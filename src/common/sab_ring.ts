// SPSC classic power-of-2 ring: free-running cursors, padding record for wrap,
// consumer-published park flag so the producer can elide Atomics.notify.

const CACHE_LINE_SLOTS = 16; // 64B / 4B per int32

/** Producer-owned. Free-running int32; wraps negative by design. */
export const TAIL_INDEX = CACHE_LINE_SLOTS * 1;
/** Consumer-owned. */
export const HEAD_INDEX = CACHE_LINE_SLOTS * 3;
/** Consumer publishes PARKED here; the producer notifies only when it sees it. */
export const CSTATE_INDEX = CACHE_LINE_SLOTS * 5;

export const STATE_SLOTS = CACHE_LINE_SLOTS * 7;
export const STATE_BYTES = STATE_SLOTS * 4;

export const AWAKE = 0;
export const PARKED = 1;

/** 4B length (negative => padding record) + 4B meta. Payloads stay 8B-aligned. */
export const RECORD_HEADER_BYTES = 8;
const PADDING_FLAG = 0x8000_0000 | 0;

const MIN_DATA_BYTES = 4096;
// Cap at 2^31: `(tail - head) >>> 0` reads used-bytes mod 2^32; cap == 2^32 makes full alias empty.
const MAX_DATA_BYTES = 2 ** 31;

export interface SabRingView {
    state: Int32Array;
    data: Uint8Array;
    buf: Buffer;
    dv: DataView;
    dataBytes: number;
    mask: number;
}

/**
 * dataBytes must be a power of two: index wrap relies on `cursor & mask` staying
 * contiguous across the int32 sign flip, which only holds when dataBytes divides 2^32.
 */
export function makeSabRing(dataBytes: number): SharedArrayBuffer {
    if (!Number.isInteger(dataBytes) || dataBytes < MIN_DATA_BYTES || dataBytes > MAX_DATA_BYTES || (dataBytes & (dataBytes - 1)) !== 0) {
        throw new Error(`sab ring dataBytes must be a power of two in [${MIN_DATA_BYTES}, ${MAX_DATA_BYTES}], got ${dataBytes}`);
    }
    return new SharedArrayBuffer(STATE_BYTES + dataBytes);
}

/** For sizes coming from user config, which need not be a power of two. */
export function toPowerOfTwo(dataBytes: number): number {
    let n = MIN_DATA_BYTES;
    while (n < dataBytes) n *= 2;
    return n;
}

export function openSabRing(sab: SharedArrayBuffer): SabRingView {
    const dataBytes = sab.byteLength - STATE_BYTES;
    return {
        state: new Int32Array(sab, 0, STATE_SLOTS),
        data: new Uint8Array(sab, STATE_BYTES, dataBytes),
        buf: Buffer.from(sab, STATE_BYTES, dataBytes),
        dv: new DataView(sab, STATE_BYTES, dataBytes),
        dataBytes,
        mask: dataBytes - 1,
    };
}

export function isRingDrained(state: Int32Array): boolean {
    return Atomics.load(state, HEAD_INDEX) === Atomics.load(state, TAIL_INDEX);
}

export class SabRingWriter {
    protected readonly state: Int32Array;
    protected readonly buf: Buffer;
    protected readonly dv: DataView;
    protected readonly data: Uint8Array;
    protected readonly cap: number;
    protected readonly mask: number;
    /** Producer-owned: plain field, not re-read from shared memory per record. */
    private tail: number;
    /** Cached opposite cursor; refreshed only when the cached value says we are full. */
    private headCache: number;
    private pendIdx = -1;
    private pendAbs = 0;

    constructor(sab: SharedArrayBuffer) {
        const view = openSabRing(sab);
        this.state = view.state;
        this.buf = view.buf;
        this.dv = view.dv;
        this.data = view.data;
        this.cap = view.dataBytes;
        this.mask = view.mask;
        this.tail = Atomics.load(view.state, TAIL_INDEX);
        this.headCache = Atomics.load(view.state, HEAD_INDEX);
    }

    /** `>>> 0` is load-bearing: cursors are free-running int32 and do wrap negative. */
    private space(tail: number): number {
        return this.cap - ((tail - this.headCache) >>> 0);
    }

    private hasRoom(tail: number, need: number): boolean {
        if (this.space(tail) >= need) return true;
        this.headCache = Atomics.load(this.state, HEAD_INDEX);
        return this.space(tail) >= need;
    }

    /**
     * Reserve room for `n` payload bytes; returns the payload offset, or -1 if full.
     * For write-first encoding pass an upper bound — commit() reconciles the real length.
     *
     * Assumes cursors stay 8-byte aligned (start at 0, strides round up to 8, 2^32 % 8 == 0),
     * which is what guarantees the tail always fits a padding header.
     */
    claim(n: number): number {
        const need = (RECORD_HEADER_BYTES + n + 7) & ~7;
        if (need > this.cap) return -1;
        let tail = this.tail;
        if (!this.hasRoom(tail, need)) return -1;

        let idx = tail & this.mask;
        const toEnd = this.cap - idx;
        if (need > toEnd) {
            // Pad out to the end so frames never straddle the wrap.
            if (!this.hasRoom(tail, need + toEnd)) return -1;
            this.dv.setInt32(idx, (toEnd - RECORD_HEADER_BYTES) | PADDING_FLAG, true);
            tail = (tail + toEnd) | 0;
            idx = 0;
        }
        this.pendIdx = idx;
        this.pendAbs = tail;
        return idx + RECORD_HEADER_BYTES;
    }

    /**
     * `len` must be what was actually written: the stride is recomputed from it, and a
     * length that disagrees with the cursor advance desyncs reader and writer permanently.
     */
    commit(meta: number, len: number): void {
        this.dv.setInt32(this.pendIdx, len, true);
        this.dv.setInt32(this.pendIdx + 4, meta | 0, true);
        this.tail = (this.pendAbs + ((RECORD_HEADER_BYTES + len + 7) & ~7)) | 0;
        Atomics.store(this.state, TAIL_INDEX, this.tail); // release
        // Dekker: the store above is ordered before this load, so a consumer that parked
        // after it is visible here and cannot miss the wakeup.
        if (Atomics.load(this.state, CSTATE_INDEX) === PARKED) {
            Atomics.notify(this.state, TAIL_INDEX);
        }
    }

    isDrained(): boolean {
        return isRingDrained(this.state);
    }
}

/** Offset is absolute within the ring buffer. */
export type OnRecordFn = (off: number, len: number, meta: number) => void;

export class SabRingReader {
    protected readonly state: Int32Array;
    protected readonly buf: Buffer;
    protected readonly dv: DataView;
    protected readonly cap: number;
    protected readonly mask: number;
    private head: number;

    constructor(sab: SharedArrayBuffer) {
        const view = openSabRing(sab);
        this.state = view.state;
        this.buf = view.buf;
        this.dv = view.dv;
        this.cap = view.dataBytes;
        this.mask = view.mask;
        this.head = Atomics.load(view.state, HEAD_INDEX);
    }

    /**
     * Dispatch every record currently visible; returns how many were handled.
     * HEAD is committed once per batch, never inside the loop — hot-update drain
     * detection relies on isDrained() staying false while a batch is dispatching.
     */
    drain(onRecord: OnRecordFn): number {
        const tail = Atomics.load(this.state, TAIL_INDEX); // acquire
        let head = this.head;
        let n = 0;
        while (head !== tail) {
            const idx = head & this.mask;
            const raw = this.dv.getInt32(idx, true);
            if (raw < 0) { // padding
                head = (head + (raw & ~PADDING_FLAG) + RECORD_HEADER_BYTES) | 0;
                continue;
            }
            const meta = this.dv.getInt32(idx + 4, true);
            try {
                onRecord(idx + RECORD_HEADER_BYTES, raw, meta);
            } catch { /* caller-installed handler swallows */ }
            head = (head + ((RECORD_HEADER_BYTES + raw + 7) & ~7)) | 0;
            n++;
        }
        if (head !== this.head) {
            this.head = head;
            Atomics.store(this.state, HEAD_INDEX, head);
        }
        return n;
    }

    isDrained(): boolean {
        return isRingDrained(this.state);
    }
}

// Atomics.waitAsync is ES2024; cast keeps ES2018 lib target.
type WaitAsyncResult = { async: boolean; value: "ok" | "not-equal" | "timed-out" | Promise<"ok" | "not-equal" | "timed-out"> };
export const waitAsync = (Atomics as unknown as {
    waitAsync: (ta: Int32Array, i: number, v: number) => WaitAsyncResult;
}).waitAsync;
