export type ClcOptions = {
    clcName: string,
    noResponse?: boolean
};
export type ClOptions = {
    clName: string,
    connKeys: string[]  // For example, concatenate openId and zoneId, and zoneId fixed length
};
export type MsgHeadType = {
    cmdId: number,
    openId: string,
    zoneId: number,
    txnId?: number,
    clcOptions?: ClcOptions,
    clOptions?: ClOptions
};
export type MsgBodyType = Uint8Array | string;

export class Msg {
    constructor(
        public head: MsgHeadType,
        public body: MsgBodyType,
    ) {
    }
}
