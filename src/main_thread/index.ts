import { Worker } from "worker_threads"
import { BaseCL } from "./conn_layer/base_cl";
import { TxnMgr } from "./transaction";
import { Msg } from "../message";
import { traceLog, debugLog, infoLog, warnLog, errorLog } from "../logger";
import "./pm2"

export interface MainThreadInfo {
    workerThreadRunFile: string;
    workerThreadNum: number;
    connLayer: BaseCL;
}
let mtInfo: MainThreadInfo | null = null;

export function getConnLayer(): BaseCL {
    return mtInfo!.connLayer;
}

export async function startServer(info: MainThreadInfo) {
    mtInfo = info;
    await startWorkerThreads();
    await mtInfo.connLayer.startListen();
    infoLog("start dog server successfully");
}

let workerThreads: Worker[] = [];
const txnMgr: TxnMgr = new TxnMgr();

async function startWorkerThreads() {
    for (let i = 0; i < mtInfo!.workerThreadNum; ++i) {
        const worker = new Worker(mtInfo!.workerThreadRunFile);
        workerThreads.push(worker);
        worker.on("message", (msg: Msg) => {
            txnMgr.onWorkerThreadMsg(msg);
        });
    }
}

let roundRobinIndex = 0;
function getWorkerThread(): Worker {
    roundRobinIndex = (roundRobinIndex + 1) % workerThreads.length;
    return workerThreads[roundRobinIndex];
}

export function sendMsgToWorkerThread(msg: Msg): Promise<Msg> {
    return new Promise((resolve, reject) => {
        msg.txnId = txnMgr.genNewTxnId();
        let worker = getWorkerThread();
        worker.postMessage(msg);
        txnMgr.addTxn(msg.txnId, resolve);
    });
}

// TODO: gracefully exit
export async function hotUpdate() {
    for (let i = 0; i < workerThreads.length; ++i) {
        workerThreads[i].terminate();
    }
    workerThreads = [];
    await startWorkerThreads();
}

export * from "./conn_layer/base_cl";
export * from "../logger";
export * from "../message";
