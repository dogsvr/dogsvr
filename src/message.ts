export type MsgBodyType = Uint8Array | string;

export class Msg {
    constructor(
        public cmdId: number,
        public txnId: number,
        public body: MsgBodyType
    ) {
    }
}
