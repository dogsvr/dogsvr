/** Options attached to outbound server-to-server messages sent via BaseCLC. */
export type ClcOptions = {
    /** Must match a key in SvrConfig.clcMap. */
    clcName: string,
    /** If true, no response is expected and no transaction will be created. */
    noResponse?: boolean
};

/** Options attached to push messages sent to clients via BaseCL. */
export type ClOptions = {
    /** Must match a key in SvrConfig.clMap. */
    clName: string,
    gids: number[]
};

/**
 * Message head. All fields except cmdId are optional; always use ?? fallback when accessing them.
 * clcOptions is present when the message is an outbound server-to-server call.
 * clOptions is present when the message is a push to client(s).
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
    errMsg?: string,
    /** W3C trace-context carrier for main↔worker propagation. Framework-internal — business code must not read or write this. */
    _otel?: Record<string, string>
};

/** Message body, either binary (Uint8Array) or text (string). */
export type MsgBodyType = Uint8Array | string;

/** Thrown inside a worker-thread handler to produce a typed error response. */
export class HandlerError extends Error {
    constructor(public code: number, public msg: string) {
        super(msg);
        this.name = 'HandlerError';
    }
}

/** Internal message envelope for main↔worker postMessage. Connection layers convert CS/SS formats into Msg at the boundary. */
export class Msg {
    constructor(
        public head: MsgHeadType,
        public body: MsgBodyType,
    ) {
    }
}
