import {
    SabRingView,
    SEQ_INDEX,
    asyncApi,
    makeSabRing,
    openSabRing,
    readState,
    commitWrite,
    commitRead,
    resetIndexes,
} from "./sab_ring";

const FRAME_LEN_BYTES = 4;
const DEFAULT_SCRATCH_BYTES = 64 * 1024;

export function makeLineSab(dataBytes: number): SharedArrayBuffer {
    return makeSabRing(dataBytes);
}

export interface SabLineWriterOpts {
    scratchBytes?: number;
}

export class SabLineWriter {
    private view: SabRingView;
    private bufView: Buffer;
    private dv: DataView;
    private scratch: Buffer;

    constructor(sab: SharedArrayBuffer, opts?: SabLineWriterOpts) {
        this.view = openSabRing(sab);
        this.bufView = Buffer.from(this.view.data.buffer, this.view.data.byteOffset, this.view.dataBytes);
        this.dv = new DataView(this.view.data.buffer, this.view.data.byteOffset, this.view.dataBytes);
        this.scratch = Buffer.allocUnsafe(opts?.scratchBytes ?? DEFAULT_SCRATCH_BYTES);
    }

    tryWrite(line: string): boolean {
        const {view, bufView, dv, scratch} = this;
        const maxBytes = Math.min(scratch.length, view.dataBytes - FRAME_LEN_BYTES);
        const bodyLen = scratch.write(line, 0, maxBytes, "utf8");
        if (bodyLen <= 0) return false;
        const frameLen = FRAME_LEN_BYTES + bodyLen;

        let {write, read} = readState(view.state);
        if (write === read && write !== 0) {
            resetIndexes(view.state);
            write = 0;
            read = 0;
        }
        if (write >= read) {
            if (view.dataBytes - write < frameLen) return false;
        } else {
            if (read - write - 1 < frameLen) return false;
        }

        dv.setUint32(write, bodyLen, true);
        bufView.set(scratch.subarray(0, bodyLen), write + FRAME_LEN_BYTES);
        commitWrite(view.state, write + frameLen);
        return true;
    }
}

export type OnLineFn = (line: string) => void;

export class SabLineReader {
    private view: SabRingView;
    private bufView: Buffer;
    private dv: DataView;
    private onLine: OnLineFn;
    private stopped = true;
    private waiter: Promise<"ok" | "not-equal" | "timed-out"> | null = null;
    private loopBound: () => void;

    constructor(sab: SharedArrayBuffer, onLine: OnLineFn) {
        this.view = openSabRing(sab);
        this.bufView = Buffer.from(this.view.data.buffer, this.view.data.byteOffset, this.view.dataBytes);
        this.dv = new DataView(this.view.data.buffer, this.view.data.byteOffset, this.view.dataBytes);
        this.onLine = onLine;
        this.loopBound = () => this.loop();
    }

    start(): void {
        this.stopped = false;
        this.loop();
    }

    stop(): void {
        this.stopped = true;
    }

    /** Best-effort synchronous drain of everything currently visible. */
    drainSync(): void {
        this.pumpOnce();
    }

    private loop(): void {
        if (this.stopped) return;
        const hadData = this.pumpOnce();
        if (this.stopped) return;
        if (hadData) {
            setImmediate(this.loopBound);
            return;
        }
        this.waitForData();
    }

    private waitForData(): void {
        if (this.stopped) return;
        const {state} = this.view;
        const seq = Atomics.load(state, SEQ_INDEX);
        const {write, read} = readState(state);
        if (write !== read) {
            setImmediate(this.loopBound);
            return;
        }
        if (!asyncApi.waitAsync) {
            setImmediate(this.loopBound);
            return;
        }
        const res = asyncApi.waitAsync(state, SEQ_INDEX, seq);
        if (!res.async) {
            setImmediate(this.loopBound);
            return;
        }
        this.waiter = res.value as Promise<"ok" | "not-equal" | "timed-out">;
        this.waiter.then(() => {
            this.waiter = null;
            if (!this.stopped) this.loop();
        });
    }

    private pumpOnce(): boolean {
        const {view, bufView, dv} = this;
        const {state} = view;
        const {write, read} = readState(state);
        if (write === read) return false;

        let cursor = read;
        const end = write;
        while (cursor < end) {
            if (end - cursor < FRAME_LEN_BYTES) break;
            const bodyLen = dv.getUint32(cursor, true);
            if (bodyLen === 0 || cursor + FRAME_LEN_BYTES + bodyLen > end) break;
            const bodyStart = cursor + FRAME_LEN_BYTES;
            let line: string;
            try { line = bufView.toString("utf8", bodyStart, bodyStart + bodyLen); } catch { line = ""; }
            if (line.length > 0) {
                try { this.onLine(line); } catch { /* caller-installed handler swallows */ }
            }
            cursor = bodyStart + bodyLen;
        }
        if (cursor > read) commitRead(state, cursor);
        return cursor > read;
    }
}
