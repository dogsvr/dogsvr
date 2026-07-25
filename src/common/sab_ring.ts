// SPSC state header + byte buffer; upper layers reuse via drain-reset, not slot-wise wrap.

export const SEQ_INDEX = 0;
export const WRITE_INDEX = 1;
export const READ_INDEX = 16;

export const STATE_SLOTS = 32;
export const STATE_BYTES = STATE_SLOTS * 4;

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

export function readState(state: Int32Array): { write: number; read: number } {
    // Seqlock retry only fires during resetIndexes; steady-state exits first pass.
    while (true) {
        const seq1 = Atomics.load(state, SEQ_INDEX);
        if (seq1 & 1) continue;
        const write = Atomics.load(state, WRITE_INDEX);
        const read = Atomics.load(state, READ_INDEX);
        const seq2 = Atomics.load(state, SEQ_INDEX);
        if (seq1 === seq2) return { write, read };
    }
}

export function commitWrite(state: Int32Array, newWrite: number): void {
    Atomics.store(state, WRITE_INDEX, newWrite);
    Atomics.notify(state, WRITE_INDEX);
}

export function commitRead(state: Int32Array, newRead: number): void {
    Atomics.store(state, READ_INDEX, newRead);
}

export function resetIndexes(state: Int32Array): void {
    Atomics.add(state, SEQ_INDEX, 1);
    Atomics.store(state, WRITE_INDEX, 0);
    Atomics.store(state, READ_INDEX, 0);
    Atomics.add(state, SEQ_INDEX, 1);
    Atomics.notify(state, WRITE_INDEX);
}

// Atomics.waitAsync is ES2024; cast keeps ES2018 lib target.
type WaitAsyncResult = { async: boolean; value: "ok" | "not-equal" | "timed-out" | Promise<"ok" | "not-equal" | "timed-out"> };
export const waitAsync = (Atomics as unknown as {
    waitAsync: (ta: Int32Array, i: number, v: number) => WaitAsyncResult;
}).waitAsync;
