// CL: inbound connection layer (e.g. WebSocket, gRPC) — accepts client requests and pushes responses.
// CLC: outbound connection layer client — sends commands to remote services server-to-server.

import { Msg } from "../common/message";
import { Worker } from "worker_threads"

export abstract class BaseCL {
    abstract startListen(): Promise<void>;
    abstract pushMsg(msg: Msg): Promise<void>;
}

export abstract class BaseCLC {
    // thread: if provided, response is forwarded back to that worker; undefined = fire-and-forget.
    abstract callCmd(msg: Msg, thread: Worker | undefined): Promise<void>;
}
