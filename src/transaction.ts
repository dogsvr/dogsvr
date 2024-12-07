import { errorLog } from "./logger";

class Txn {
    txnId: number;
    callback: Function;

    constructor(txnId: number, callback: Function) {
        this.txnId = txnId;
        this.callback = callback;
    }
}

type TxnMapType = { [key: number]: Txn }

export class TxnMgr {
    txnMap: TxnMapType = {};
    currTxnId = 0;
    readonly maxTxnId = 4200000000;

    constructor() {
    }

    genNewTxnId(): number {
        if (this.currTxnId >= this.maxTxnId) {
            this.currTxnId = 0;
        }
        return ++this.currTxnId;
    }

    addTxn(txnId:number, callback: Function) {
        if (this.txnMap[txnId]) {
            errorLog('txn already exists', txnId);
            return;
        }
        this.txnMap[txnId] = new Txn(txnId, callback);
    }

    onCallback(txnId: number): Function | undefined {
        if (this.txnMap[txnId]) {
            let cb = this.txnMap[txnId].callback;
            delete this.txnMap[txnId];
            return cb;
        }
    }
}
