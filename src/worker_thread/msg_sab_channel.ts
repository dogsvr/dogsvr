import type { Msg } from "../common/message";
import {
    SabMsgReader,
    SabMsgWriter,
    SEQ_INDEX,
    WRITE_INDEX,
    READ_INDEX,
    commitRead,
    openMsgSab,
    readState,
    type SabView,
} from "../common/msg_sab_shared";

export type MsgDispatchFn = (msg: Msg) => void;

interface WaitAsyncResult {
    async: boolean;
    value: "ok" | "not-equal" | "timed-out" | Promise<"ok" | "not-equal" | "timed-out">;
}
interface AtomicsAsync {
    waitAsync?: (typedArray: Int32Array, index: number, value: number) => WaitAsyncResult;
}
const asyncApi = Atomics as unknown as AtomicsAsync;

export class WorkerMsgSabChannel {
    private inView: SabView;
    private outView: SabView;
    private writer: SabMsgWriter;
    private reader: SabMsgReader;
    private dispatch: MsgDispatchFn = () => {};
    private stopped = false;
    private waiter: Promise<"ok" | "not-equal" | "timed-out"> | null = null;
    private readOut: { msg: Msg | null; nextCursor: number } = { msg: null, nextCursor: 0 };
    private loopBound: () => void;
    private sabHits = 0;
    private fallbackHits = 0;

    constructor(sabIn: SharedArrayBuffer, sabOut: SharedArrayBuffer) {
        this.inView = openMsgSab(sabIn);
        this.outView = openMsgSab(sabOut);
        this.writer = new SabMsgWriter(this.outView);
        this.reader = new SabMsgReader(this.inView);
        this.loopBound = () => this.loop();
    }

    setDispatch(fn: MsgDispatchFn): void {
        this.dispatch = fn;
    }

    start(): void {
        this.stopped = false;
        this.loop();
    }

    close(): void {
        this.stopped = true;
    }

    send(msg: Msg): boolean {
        const ok = this.writer.tryWrite(msg);
        if (ok) this.sabHits++;
        return ok;
    }

    recordFallback(): void {
        this.fallbackHits++;
    }

    getStats(): { sabHits: number; fallbackHits: number } {
        return { sabHits: this.sabHits, fallbackHits: this.fallbackHits };
    }

    isSabDrained(): boolean {
        const outSame = Atomics.load(this.outView.state, WRITE_INDEX) === Atomics.load(this.outView.state, READ_INDEX);
        const inSame = Atomics.load(this.inView.state, WRITE_INDEX) === Atomics.load(this.inView.state, READ_INDEX);
        return outSame && inSame;
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
        const {state} = this.inView;
        const seq = Atomics.load(state, SEQ_INDEX);
        const s = readState(state);
        if (s.write !== s.read) {
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
        const {state} = this.inView;
        const {write, read} = readState(state);
        if (write === read) return false;

        let cursor = read;
        const end = write;
        const out = this.readOut;
        while (cursor < end) {
            if (!this.reader.tryRead(cursor, end, out)) break;
            cursor = out.nextCursor;
            const m = out.msg;
            if (m) {
                try { this.dispatch(m); } catch { /* handler guarded upstream */ }
            }
        }
        if (cursor > read) commitRead(state, cursor);
        return cursor > read;
    }
}
