import { errorLog } from "./logger";

class Txn {
    txnId: number;
    callback: Function;
    timer: ReturnType<typeof setTimeout>;

    constructor(txnId: number, callback: Function, timer: ReturnType<typeof setTimeout>) {
        this.txnId = txnId;
        this.callback = callback;
        this.timer = timer;
    }
}

type TxnMapType = { [key: number]: Txn }

export class TxnMgr {
    txnMap: TxnMapType = {};
    currTxnId = 0;
    readonly maxTxnId = 4200000000;
    readonly defaultTimeoutMs: number;

    constructor(defaultTimeoutMs: number = 5000) {
        this.defaultTimeoutMs = defaultTimeoutMs;
    }

    genNewTxnId(): number {
        if (this.currTxnId >= this.maxTxnId) {
            this.currTxnId = 0;
        }
        return ++this.currTxnId;
    }

    addTxn(txnId: number, callback: Function, onTimeout?: Function, timeoutMs?: number) {
        if (this.txnMap[txnId]) {
            errorLog('txn already exists', txnId);
            return;
        }
        const ms = timeoutMs ?? this.defaultTimeoutMs;
        const timer = setTimeout(() => {
            if (this.txnMap[txnId]) {
                delete this.txnMap[txnId];
                errorLog(`txn timeout|txnId:${txnId}|timeoutMs:${ms}`);
                if (onTimeout) {
                    onTimeout();
                } else {
                    callback(null);
                }
            }
        }, ms);
        this.txnMap[txnId] = new Txn(txnId, callback, timer);
    }

    onCallback(txnId: number): Function | undefined {
        if (this.txnMap[txnId]) {
            clearTimeout(this.txnMap[txnId].timer);
            let cb = this.txnMap[txnId].callback;
            delete this.txnMap[txnId];
            return cb;
        }
    }
}
