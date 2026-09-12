import type { Msg } from "./message";
import { SabMsgChannel } from "./sab_msg";

/** Main side binds its Worker so dispatch knows the sender; the worker side has one peer and binds nothing. */
export type MsgDispatchFn<TPeer> = (msg: Msg, peer: TPeer) => void;

/** `peer` is the only difference between the two sides, so it is a parameter rather than a second class. */
export class MsgChannel<TPeer> {
    private ch: SabMsgChannel;
    private peer: TPeer;
    private dispatch: MsgDispatchFn<TPeer>;
    private sabHits = 0;
    private fallbackHits = 0;

    constructor(sabOut: SharedArrayBuffer, sabIn: SharedArrayBuffer, peer: TPeer, dispatch: MsgDispatchFn<TPeer>) {
        this.peer = peer;
        this.dispatch = dispatch;
        // Reads this.dispatch per message so setDispatch takes effect on the next frame.
        this.ch = new SabMsgChannel(sabOut, sabIn, (msg) => this.dispatch(msg, this.peer));
    }

    setDispatch(fn: MsgDispatchFn<TPeer>): void {
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
