import type { Msg, MsgHeadType, MsgBodyType } from "./message";
import {
    SabRingView,
    SEQ_INDEX,
    WRITE_INDEX,
    READ_INDEX,
    asyncApi,
    makeSabRing,
    openSabRing,
    readState,
    commitWrite,
    commitRead,
    resetIndexes,
} from "./sab_ring";

const FRAME_LEN_BYTES = 4;
const BODY_BINARY_BIT = 0x8000_0000;
const BODY_LEN_MASK = 0x7fff_ffff;

export const DEFAULT_MSG_SAB_DATA_BYTES = 1 * 1024 * 1024;
export const DEFAULT_WAIT_ON_FULL_MS = 1;

export function makeMsgSab(dataBytes: number): SharedArrayBuffer {
    return makeSabRing(dataBytes);
}

export class SabMsgWriter {
    private view: SabRingView;
    private bufView: Buffer;
    private dv: DataView;

    constructor(sab: SharedArrayBuffer) {
        this.view = openSabRing(sab);
        this.bufView = Buffer.from(this.view.data.buffer, this.view.data.byteOffset, this.view.dataBytes);
        this.dv = new DataView(this.view.data.buffer, this.view.data.byteOffset, this.view.dataBytes);
    }

    tryWrite(msg: Msg): boolean {
        const {view, bufView, dv} = this;
        const headJson = JSON.stringify(msg.head);
        const headLen = Buffer.byteLength(headJson, "utf8");
        const bodyIsBinary = typeof msg.body !== "string";
        const bodyLen = bodyIsBinary ? (msg.body as Uint8Array).length : Buffer.byteLength(msg.body as string, "utf8");
        if (bodyLen > BODY_LEN_MASK) throw new Error(`msg body too large: ${bodyLen}`);

        const frameLen = FRAME_LEN_BYTES + headLen + FRAME_LEN_BYTES + bodyLen;
        if (frameLen > view.dataBytes) throw new Error(`msg frame too large: ${frameLen} > ${view.dataBytes}`);

        let { write, read } = readState(view.state);
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

        let off = write;
        dv.setUint32(off, headLen, true);
        off += FRAME_LEN_BYTES;
        bufView.write(headJson, off, headLen, "utf8");
        off += headLen;

        const bodyLenField = bodyIsBinary ? ((bodyLen | BODY_BINARY_BIT) >>> 0) : bodyLen;
        dv.setUint32(off, bodyLenField, true);
        off += FRAME_LEN_BYTES;
        if (bodyIsBinary) {
            view.data.set(msg.body as Uint8Array, off);
        } else {
            bufView.write(msg.body as string, off, bodyLen, "utf8");
        }
        off += bodyLen;

        commitWrite(view.state, off);
        return true;
    }

    isDrained(): boolean {
        const {state} = this.view;
        return Atomics.load(state, WRITE_INDEX) === Atomics.load(state, READ_INDEX);
    }
}

export type OnMsgFn = (msg: Msg) => void;

export class SabMsgReader {
    private view: SabRingView;
    private bufView: Buffer;
    private dv: DataView;
    private onMsg: OnMsgFn;
    private stopped = true;
    private waiter: Promise<"ok" | "not-equal" | "timed-out"> | null = null;
    private readOut: { msg: Msg | null; nextCursor: number } = { msg: null, nextCursor: 0 };
    private loopBound: () => void;

    constructor(sab: SharedArrayBuffer, onMsg: OnMsgFn) {
        this.view = openSabRing(sab);
        this.bufView = Buffer.from(this.view.data.buffer, this.view.data.byteOffset, this.view.dataBytes);
        this.dv = new DataView(this.view.data.buffer, this.view.data.byteOffset, this.view.dataBytes);
        this.onMsg = onMsg;
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

    isDrained(): boolean {
        const {state} = this.view;
        return Atomics.load(state, WRITE_INDEX) === Atomics.load(state, READ_INDEX);
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
        const {view} = this;
        const {state} = view;
        const {write, read} = readState(state);
        if (write === read) return false;

        let cursor = read;
        const end = write;
        const out = this.readOut;
        while (cursor < end) {
            if (!this.tryRead(cursor, end, out)) break;
            cursor = out.nextCursor;
            const m = out.msg;
            if (m) {
                try { this.onMsg(m); } catch { /* caller-installed handler swallows */ }
            }
        }
        if (cursor > read) commitRead(state, cursor);
        return cursor > read;
    }

    private tryRead(cursor: number, writeEnd: number, out: { msg: Msg | null; nextCursor: number }): boolean {
        const {bufView, dv} = this;
        if (writeEnd - cursor < FRAME_LEN_BYTES) return false;
        const headLen = dv.getUint32(cursor, true);
        let off = cursor + FRAME_LEN_BYTES;
        if (headLen === 0 || headLen > writeEnd - off) return false;
        const headJson = bufView.toString("utf8", off, off + headLen);
        off += headLen;

        if (writeEnd - off < FRAME_LEN_BYTES) return false;
        const bodyLenField = dv.getUint32(off, true);
        off += FRAME_LEN_BYTES;
        const bodyIsBinary = (bodyLenField & BODY_BINARY_BIT) !== 0;
        const bodyLen = bodyLenField & BODY_LEN_MASK;
        if (bodyLen > writeEnd - off) return false;

        let body: MsgBodyType;
        if (bodyIsBinary) {
            const dst = Buffer.allocUnsafe(bodyLen);
            bufView.copy(dst, 0, off, off + bodyLen);
            body = dst;
        } else {
            body = bufView.toString("utf8", off, off + bodyLen);
        }
        off += bodyLen;

        let head: MsgHeadType;
        try {
            head = JSON.parse(headJson) as MsgHeadType;
        } catch {
            out.msg = null;
            out.nextCursor = off;
            return true;
        }
        out.msg = { head, body } as Msg;
        out.nextCursor = off;
        return true;
    }
}

export class SabMsgChannel {
    private writer: SabMsgWriter;
    private reader: SabMsgReader;

    constructor(sabOut: SharedArrayBuffer, sabIn: SharedArrayBuffer, onMsg: OnMsgFn) {
        this.writer = new SabMsgWriter(sabOut);
        this.reader = new SabMsgReader(sabIn, onMsg);
    }

    trySend(msg: Msg): boolean {
        return this.writer.tryWrite(msg);
    }

    start(): void {
        this.reader.start();
    }

    stop(): void {
        this.reader.stop();
    }

    isDrained(): boolean {
        return this.writer.isDrained() && this.reader.isDrained();
    }
}
