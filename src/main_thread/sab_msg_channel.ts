import type { Worker } from "worker_threads";
import type { Msg } from "../common/message";
import { SabMsgChannel } from "../common/sab_msg";

export type MsgDispatchFn = (msg: Msg, worker: Worker) => void;

export class MainSabMsgChannel {
    private ch: SabMsgChannel;
    private worker: Worker;
    private dispatch: MsgDispatchFn;
    private sabHits = 0;
    private fallbackHits = 0;

    constructor(sabOut: SharedArrayBuffer, sabIn: SharedArrayBuffer, worker: Worker, dispatch: MsgDispatchFn) {
        this.worker = worker;
        this.dispatch = dispatch;
        this.ch = new SabMsgChannel(sabOut, sabIn, (msg) => this.dispatch(msg, this.worker));
    }

    setDispatch(fn: MsgDispatchFn): void {
        this.dispatch = fn;
    }

    start(): void {
        this.ch.start();
    }

    stop(): void {
        this.ch.stop();
    }

    send(msg: Msg): boolean {
        const ok = this.ch.trySend(msg);
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
        return this.ch.isDrained();
    }
}
