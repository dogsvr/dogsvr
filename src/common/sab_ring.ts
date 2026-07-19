// SPSC only — one writer thread, one reader thread per SAB.

export const SEQ_INDEX = 0;
export const PAD_INDEX = 1;
export const WRITE_INDEX = 2;
export const READ_INDEX = 3;

export const STATE_SLOTS = 4;
export const STATE_BYTES = STATE_SLOTS * 4;

/** SPSC ring view over a SharedArrayBuffer. */
export interface SabRingView {
    state: Int32Array;
    data: Uint8Array;
    dataBytes: number;
}

export function makeSabRing(dataBytes: number): SharedArrayBuffer {
    return new SharedArrayBuffer(STATE_BYTES + dataBytes);
}

export function openSabRing(sab: SharedArrayBuffer): SabRingView {
    return {
        state: new Int32Array(sab, 0, STATE_SLOTS),
        data: new Uint8Array(sab, STATE_BYTES),
        dataBytes: sab.byteLength - STATE_BYTES,
    };
}

export function readState(state: Int32Array): { seq: number; write: number; read: number } {
    // seqlock: odd seq = writer mid-commit; retry until we see a matched even snapshot.
    while (true) {
        const seq1 = Atomics.load(state, SEQ_INDEX);
        if (seq1 & 1) continue;
        const write = Atomics.load(state, WRITE_INDEX);
        const read = Atomics.load(state, READ_INDEX);
        const seq2 = Atomics.load(state, SEQ_INDEX);
        if (seq1 === seq2) return { seq: seq1, write, read };
    }
}

export function commitWrite(state: Int32Array, newWrite: number): void {
    Atomics.add(state, SEQ_INDEX, 1);
    Atomics.store(state, WRITE_INDEX, newWrite);
    Atomics.add(state, SEQ_INDEX, 1);
    Atomics.notify(state, SEQ_INDEX);
}

export function resetIndexes(state: Int32Array): void {
    Atomics.add(state, SEQ_INDEX, 1);
    Atomics.store(state, WRITE_INDEX, 0);
    Atomics.store(state, READ_INDEX, 0);
    Atomics.add(state, SEQ_INDEX, 1);
    Atomics.notify(state, SEQ_INDEX);
}

export function commitRead(state: Int32Array, newRead: number): void {
    Atomics.store(state, READ_INDEX, newRead);
    Atomics.notify(state, READ_INDEX);
}

interface WaitAsyncResult {
    async: boolean;
    value: "ok" | "not-equal" | "timed-out" | Promise<"ok" | "not-equal" | "timed-out">;
}
interface AtomicsAsync {
    waitAsync?: (typedArray: Int32Array, index: number, value: number) => WaitAsyncResult;
}
export const asyncApi = Atomics as unknown as AtomicsAsync;
