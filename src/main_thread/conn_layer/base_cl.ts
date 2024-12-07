import { Msg } from "../../message";
import { Worker } from "worker_threads"

export type AuthFuncType = (msg: Msg) => Promise<boolean>;

export abstract class BaseCL {
    abstract startListen(): Promise<void>;

    setAuthFunc(authFunc: AuthFuncType): void { }
}

// client that communicates with connection layer
export abstract class BaseCLC {
    abstract callCmd(msg: Msg, thread: Worker): Promise<void>;
}
