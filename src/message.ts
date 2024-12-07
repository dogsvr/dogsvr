export type MsgBodyType = Uint8Array | string;
export type ClcOptions = { clcName: string };
export type ClOptions = { clName: string, connKey: string };

export class Msg {
    constructor(
        public cmdId: number,
        public txnId: number,
        public body: MsgBodyType,
        public clcOptions?: ClcOptions,
        public clOptions?: ClOptions
    ) {
    }
}
