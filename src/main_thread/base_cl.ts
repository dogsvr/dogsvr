/**
 * Base classes for Connection Layer (CL) and Connection Layer Client (CLC).
 *
 * - CL  (Connection Layer):        Inbound connection layer that accepts requests
 *                                   from external clients (e.g. via WebSocket, HTTP,
 *                                   gRPC). It listens for incoming messages and can
 *                                   push messages back to connected clients.
 *
 * - CLC (Connection Layer Client):  Outbound connection layer client used for
 *                                   server-to-server communication. It sends
 *                                   commands to remote services on behalf of
 *                                   the current server.
 */

import { Msg } from "../message";
import { Worker } from "worker_threads"

/**
 * BaseCL — Abstract base for inbound Connection Layer.
 *
 * Implementations (e.g. TsrpcCL, GrpcCL) accept client connections,
 * forward requests to worker threads, and push messages to clients.
 */
export abstract class BaseCL {
    /** Start listening for incoming client connections. */
    abstract startListen(): Promise<void>;

    /** Push a message to one or more connected clients. */
    abstract pushMsg(msg: Msg): Promise<void>;
}

/**
 * BaseCLC — Abstract base for outbound Connection Layer Client.
 *
 * Implementations handle server-to-server calls. When `thread` is provided,
 * the response will be forwarded back to that worker thread; when `undefined`,
 * the call is fire-and-forget (no response expected).
 */
export abstract class BaseCLC {
    /** Send a command to a remote service. */
    abstract callCmd(msg: Msg, thread: Worker | undefined): Promise<void>;
}
