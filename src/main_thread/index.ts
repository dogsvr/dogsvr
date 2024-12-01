import { Worker } from "worker_threads"
import { BaseCL, BaseCLC } from "./conn_layer/base_cl";
import { TxnMgr } from "./transaction";
import { Msg } from "../message";
import { traceLog, debugLog, infoLog, warnLog, errorLog } from "../logger";
import "./pm2"

export interface SvrConfig {
    workerThreadRunFile: string;
    workerThreadNum: number;
    clMap: { [clName: string]: BaseCL };
    clcMap: { [clcName: string]: BaseCLC };
}
let svrCfg: SvrConfig | null = null;

export function getConnLayer(clName: string): BaseCL {
    return svrCfg!.clMap[clName];
}

export async function startServer(cfg: SvrConfig) {
    svrCfg = cfg;
    await startWorkerThreads();
    for(let cl of Object.values(svrCfg!.clMap))
    {
        await cl.startListen();
    }
    infoLog("start dog server successfully");
}

let workerThreads: Worker[] = [];
const txnMgr: TxnMgr = new TxnMgr();

async function startWorkerThreads() {
    for (let i = 0; i < svrCfg!.workerThreadNum; ++i) {
        const worker = new Worker(svrCfg!.workerThreadRunFile);
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
