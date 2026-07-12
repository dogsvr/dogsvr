import type { Msg, MsgHeadType, MsgBodyType } from "./message";

export const SEQ_INDEX = 0;
export const PAD_INDEX = 1;
export const WRITE_INDEX = 2;
export const READ_INDEX = 3;

export const STATE_SLOTS = 4;
export const STATE_BYTES = STATE_SLOTS * 4;

export const FRAME_LEN_BYTES = 4;
export const BODY_BINARY_BIT = 0x8000_0000;
export const BODY_LEN_MASK = 0x7fff_ffff;

export const DEFAULT_MSG_SAB_DATA_BYTES = 1 * 1024 * 1024;
export const DEFAULT_WAIT_ON_FULL_MS = 1;

export interface SabView {
    state: Int32Array;
    data: Uint8Array;
    bufView: Buffer;
    dv: DataView;
    dataBytes: number;
}

export function makeMsgSab(dataBytes: number): SharedArrayBuffer {
    return new SharedArrayBuffer(STATE_BYTES + dataBytes);
}

export function openMsgSab(sab: SharedArrayBuffer): SabView {
    const dataBytes = sab.byteLength - STATE_BYTES;
    return {
        state: new Int32Array(sab, 0, STATE_SLOTS),
        data: new Uint8Array(sab, STATE_BYTES),
        bufView: Buffer.from(sab as unknown as ArrayBuffer, STATE_BYTES, dataBytes),
        dv: new DataView(sab as unknown as ArrayBuffer, STATE_BYTES, dataBytes),
        dataBytes,
    };
}

export function readState(state: Int32Array): { seq: number; write: number; read: number } {
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

export class SabMsgWriter {
    private view: SabView;

    constructor(view: SabView) {
        this.view = view;
    }

    tryWrite(msg: Msg): boolean {
        const {view} = this;
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

        const {bufView, dv, data} = view;
        let off = write;
        dv.setUint32(off, headLen, true);
        off += FRAME_LEN_BYTES;
        bufView.write(headJson, off, headLen, "utf8");
        off += headLen;

        const bodyLenField = bodyIsBinary ? ((bodyLen | BODY_BINARY_BIT) >>> 0) : bodyLen;
        dv.setUint32(off, bodyLenField, true);
        off += FRAME_LEN_BYTES;
        if (bodyIsBinary) {
            data.set(msg.body as Uint8Array, off);
        } else {
            bufView.write(msg.body as string, off, bodyLen, "utf8");
        }
        off += bodyLen;

        commitWrite(view.state, off);
        return true;
    }
}

export class SabMsgReader {
    private view: SabView;

    constructor(view: SabView) {
        this.view = view;
    }

    tryRead(cursor: number, writeEnd: number, out: { msg: Msg | null; nextCursor: number }): boolean {
        const {view} = this;
        if (writeEnd - cursor < FRAME_LEN_BYTES) return false;
        const {bufView, dv} = view;
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
