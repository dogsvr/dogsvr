import type { Worker } from "worker_threads";
import type { Msg } from "../common/message";
import { MsgChannel } from "../common/sab_channel";

export type MsgDispatchFn = (msg: Msg, worker: Worker) => void;

export class MainSabMsgChannel extends MsgChannel<Worker> {}
