import { Msg } from "../../message";
import { Worker } from "worker_threads"

export abstract class BaseCL {
    abstract startListen(): Promise<void>;
    abstract pushMsg(msg: Msg): Promise<void>;
}

// client that communicates with connection layer
export abstract class BaseCLC {
    abstract callCmd(msg: Msg, thread: Worker | undefined): Promise<void>;
}
