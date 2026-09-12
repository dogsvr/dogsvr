import type { Msg } from "../common/message";
import { MsgChannel } from "../common/sab_channel";

/** The worker talks to exactly one peer (the main thread), so dispatch takes no peer argument. */
export type MsgDispatchFn = (msg: Msg) => void;

export class WorkerSabMsgChannel extends MsgChannel<null> {
    constructor(sabOut: SharedArrayBuffer, sabIn: SharedArrayBuffer, dispatch: MsgDispatchFn) {
        super(sabOut, sabIn, null, dispatch);
    }
}
