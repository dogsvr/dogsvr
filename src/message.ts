/**
 * Options attached to outbound server-to-server messages sent via BaseCLC.
 * @property clcName - Name of the outbound connection layer client to use
 *   (must match a key in SvrConfig.clcMap).
 * @property noResponse - If true, the caller does not expect a response
 *   and no transaction will be created.
 */
export type ClcOptions = {
    clcName: string,
    noResponse?: boolean
};

/**
 * Options attached to push messages sent to clients via BaseCL.
 * @property clName - Name of the inbound connection layer to push through
 *   (must match a key in SvrConfig.clMap).
 * @property gids - List of gid (global identifiers) to push to.
 */
export type ClOptions = {
    clName: string,
    gids: number[]
};

/**
 * Message head that carries routing and metadata for every Msg.
 * All fields except cmdId are optional; code accessing them should
 * handle undefined (use ?? '' / ?? 0 for fallback).
 *
 * @property cmdId - Command identifier that selects the handler in worker threads.
 * @property openId - User/player identifier, used for routing and business logic.
 * @property zoneId - Zone/server identifier, used for routing and business logic.
 * @property gid - Global user/player identifier, used for routing and business logic.
 * @property txnId - Transaction identifier for correlating async request-response pairs.
 * @property clcOptions - Present when the message is an outbound server-to-server call.
 * @property clOptions - Present when the message is a push to client(s).
 */
export type MsgHeadType = {
    cmdId: number,
    openId?: string,
    zoneId?: number,
    gid?: number,
    txnId?: number,
    clcOptions?: ClcOptions,
    clOptions?: ClOptions,
    errCode?: number,
    errMsg?: string
};

/** Message body, either binary (Uint8Array) or text (string). */
export type MsgBodyType = Uint8Array | string;

/**
 * Msg is the internal message envelope used within dogsvr, primarily for
 * communication between the main thread and worker threads via postMessage.
 * Connection layers convert their own CS/SS formats into Msg at the boundary.
 */
export class Msg {
    constructor(
        /** Routing and metadata header. */
        public head: MsgHeadType,
        /** Serialized payload. */
        public body: MsgBodyType,
    ) {
    }
}
