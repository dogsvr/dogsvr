import type { Msg, MsgHeadType, MsgBodyType } from "./message";
import {
    SabRingWriter,
    SabRingReader,
    makeSabRing,
    openSabRing,
    toPowerOfTwo,
    isRingDrained,
} from "./sab_ring";
import { SabPump } from "./sab_pump";

export const DEFAULT_MSG_SAB_DATA_BYTES = 1 * 1024 * 1024;

/** meta bits. cmdId is deliberately NOT packed here — bit-packing measured slower than a plain u32. */
const HAS_TRACEPARENT = 1 << 0;
const HAS_EXT = 1 << 1;
const BODY_BINARY = 1 << 2;

/** gid goes first: the payload start is 8B-aligned, so setFloat64 is aligned for free. */
const OFF_GID = 0;
const OFF_CMD_ID = 8;
const OFF_TXN_ID = 12;
const OFF_ZONE_ID = 16;
const OFF_ERR_CODE = 20;
const OFF_OPEN_ID_LEN = 24;
const OFF_TP_LEN = 26;
const FIXED_HEAD_BYTES = 28;

/** Everything not listed here rides in the ext JSON, including future MsgHeadType fields. */
const FIXED_KEYS = new Set(["cmdId", "openId", "zoneId", "gid", "txnId", "errCode", "_otel"]);

/** Worst-case UTF-8 expansion per JS char, for sizing the claim before writing. */
const MAX_UTF8_PER_CHAR = 3;

export function makeMsgSab(dataBytes: number): SharedArrayBuffer {
    return makeSabRing(toPowerOfTwo(dataBytes));
}

export class SabMsgWriter extends SabRingWriter {
    tryWrite(msg: Msg): boolean {
        const head = msg.head;
        const body = msg.body;
        const bodyIsBinary = typeof body !== "string";

        const openId = head.openId;
        const traceparent = head._otel?.traceparent;

        let ext: Record<string, unknown> | null = null;
        for (const k in head) {
            if (!FIXED_KEYS.has(k)) (ext ??= {})[k] = (head as Record<string, unknown>)[k];
        }
        const tracestate = head._otel?.tracestate;
        if (tracestate !== undefined) (ext ??= {}).tracestate = tracestate;
        const extJson = ext === null ? null : JSON.stringify(ext);

        // Upper bound: real lengths are only known after Buffer.write returns.
        const upper = FIXED_HEAD_BYTES
            + (openId === undefined ? 0 : openId.length * MAX_UTF8_PER_CHAR)
            + (traceparent === undefined ? 0 : traceparent.length)
            + (extJson === null ? 0 : 4 + extJson.length * MAX_UTF8_PER_CHAR)
            + (bodyIsBinary ? (body as Uint8Array).length : (body as string).length * MAX_UTF8_PER_CHAR);

        const base = this.claim(upper);
        if (base < 0) return false;

        const {buf, dv} = this;
        let meta = 0;
        dv.setFloat64(base + OFF_GID, head.gid ?? 0, true);
        dv.setUint32(base + OFF_CMD_ID, head.cmdId, true);
        dv.setUint32(base + OFF_TXN_ID, head.txnId ?? 0, true);
        dv.setUint32(base + OFF_ZONE_ID, head.zoneId ?? 0, true);
        dv.setInt32(base + OFF_ERR_CODE, head.errCode ?? 0, true); // signed: errCode -1 is a real value

        let off = base + FIXED_HEAD_BYTES;
        const openIdLen = openId === undefined ? 0 : buf.write(openId, off, "utf8");
        dv.setUint16(base + OFF_OPEN_ID_LEN, openIdLen, true);
        off += openIdLen;

        // Length-prefixed rather than a fixed 55B slot: the W3C propagator accepts longer
        // future-version strings on extract, and truncating one silently drops trace context.
        let tpLen = 0;
        if (traceparent !== undefined) {
            tpLen = buf.write(traceparent, off, "latin1");
            meta |= HAS_TRACEPARENT;
            off += tpLen;
        }
        dv.setUint16(base + OFF_TP_LEN, tpLen, true);

        if (extJson !== null) {
            const extLen = buf.write(extJson, off + 4, "utf8");
            dv.setUint32(off, extLen, true);
            meta |= HAS_EXT;
            off += 4 + extLen;
        }

        if (bodyIsBinary) {
            const bin = body as Uint8Array;
            buf.set(bin, off);
            off += bin.length;
            meta |= BODY_BINARY;
        } else {
            off += buf.write(body as string, off, "utf8");
        }

        this.commit(meta, off - base);
        return true;
    }
}

export type OnMsgFn = (msg: Msg) => void;

export class SabMsgReader {
    private readonly pump: SabPump;
    private readonly buf: Buffer;
    private readonly dv: DataView;
    private readonly state: Int32Array;
    /** Read per message so setDispatch() takes effect on the next frame (hot update). */
    private onMsg: OnMsgFn;

    constructor(sab: SharedArrayBuffer, onMsg: OnMsgFn) {
        const view = openSabRing(sab);
        this.buf = view.buf;
        this.dv = view.dv;
        this.state = view.state;
        this.onMsg = onMsg;
        this.pump = new SabPump(
            new SabRingReader(sab),
            view.state,
            (off, len, meta) => this.readRecord(off, len, meta),
            "park",
        );
    }

    setOnMsg(onMsg: OnMsgFn): void {
        this.onMsg = onMsg;
    }

    start(): void {
        this.pump.start();
    }

    stop(): void {
        this.pump.stop();
    }

    isDrained(): boolean {
        return isRingDrained(this.state);
    }

    private readRecord(base: number, len: number, meta: number): void {
        const {buf, dv} = this;
        const head: MsgHeadType = { cmdId: dv.getUint32(base + OFF_CMD_ID, true) };
        const gid = dv.getFloat64(base + OFF_GID, true);
        if (gid !== 0) head.gid = gid;
        const txnId = dv.getUint32(base + OFF_TXN_ID, true);
        if (txnId !== 0) head.txnId = txnId;
        const zoneId = dv.getUint32(base + OFF_ZONE_ID, true);
        if (zoneId !== 0) head.zoneId = zoneId;
        const errCode = dv.getInt32(base + OFF_ERR_CODE, true);
        if (errCode !== 0) head.errCode = errCode;

        const openIdLen = dv.getUint16(base + OFF_OPEN_ID_LEN, true);
        const tpLen = dv.getUint16(base + OFF_TP_LEN, true);
        let off = base + FIXED_HEAD_BYTES;
        if (openIdLen > 0) {
            head.openId = buf.toString("utf8", off, off + openIdLen);
            off += openIdLen;
        }
        if ((meta & HAS_TRACEPARENT) !== 0) {
            head._otel = { traceparent: buf.toString("latin1", off, off + tpLen) };
            off += tpLen;
        }
        if ((meta & HAS_EXT) !== 0) {
            const extLen = dv.getUint32(off, true);
            off += 4;
            try {
                const ext = JSON.parse(buf.toString("utf8", off, off + extLen)) as Record<string, unknown>;
                const tracestate = ext.tracestate;
                if (typeof tracestate === "string") {
                    delete ext.tracestate;
                    (head._otel ??= {}).tracestate = tracestate;
                }
                Object.assign(head, ext);
            } catch { /* malformed ext: keep the fixed fields already decoded */ }
            off += extLen;
        }

        const bodyEnd = base + len;
        let body: MsgBodyType;
        if ((meta & BODY_BINARY) !== 0) {
            const dst = Buffer.allocUnsafe(bodyEnd - off);
            buf.copy(dst, 0, off, bodyEnd);
            body = dst;
        } else {
            body = buf.toString("utf8", off, bodyEnd);
        }
        this.onMsg({ head, body } as Msg);
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
