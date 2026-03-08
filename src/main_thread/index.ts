import { Worker } from "worker_threads"
import { BaseCL, BaseCLC } from "./conn_layer/base_cl";
import { TxnMgr } from "../transaction";
import { Msg } from "../message";
import { traceLog, debugLog, infoLog, warnLog, errorLog } from "../logger";
import { LbStrategyConfig, ILoadBalancer, createLoadBalancer } from './lb';
import "./pm2"

export interface SvrConfig {
    workerThreadRunFile: string;
    workerThreadNum: number;
    clMap: { [clName: string]: BaseCL };
    clcMap: { [clcName: string]: BaseCLC };
    lbStrategy?: LbStrategyConfig;   // 不填默认 roundRobin
}
let svrCfg: SvrConfig | null = null;

export function getConnLayer(clName: string): BaseCL {
    return svrCfg!.clMap[clName];
}

export async function startServer(cfg: SvrConfig) {
    svrCfg = cfg;
    loadBalancer = createLoadBalancer(
        cfg.lbStrategy ?? { strategy: 'roundRobin' },
        cfg.workerThreadNum
    );
    await startWorkerThreads();
    for (let cl of Object.values(svrCfg!.clMap)) {
        await cl.startListen();
    }
    infoLog("start dog server successfully");
}

let workerThreads: Worker[] = [];
const txnMgr: TxnMgr = new TxnMgr();
let loadBalancer: ILoadBalancer | null = null;

async function startWorkerThreads() {
    for (let i = 0; i < svrCfg!.workerThreadNum; ++i) {
        const worker = new Worker(svrCfg!.workerThreadRunFile);
        const workerIndex = i;
        workerThreads.push(worker);
        worker.on("message", (msg: Msg) => {
            if (msg.head.clcOptions) {
                svrCfg!.clcMap[msg.head.clcOptions.clcName].callCmd(msg, msg.head.clcOptions.noResponse ? undefined : worker);
            }
            else if (msg.head.clOptions) {
                svrCfg!.clMap[msg.head.clOptions.clName].pushMsg(msg);
            }
            else {
                let cb = txnMgr.onCallback(msg.head.txnId!);
                if (cb) {
                    loadBalancer!.onMessageResolved(workerIndex);
                    cb(msg);
                } else {
                    errorLog(`No callback for txnId ${msg.head.txnId}|${msg.head.cmdId}`);
                }
            }
        });
    }
}

export function sendMsgToWorkerThread(msg: Msg): Promise<Msg> {
    return new Promise((resolve) => {
        msg.head.txnId = txnMgr.genNewTxnId();
        const workerIndex = loadBalancer!.selectWorkerIndex(msg, workerThreads.length);
        const worker = workerThreads[workerIndex];
        worker.postMessage(msg);
        loadBalancer!.onMessageSent(workerIndex);
        txnMgr.addTxn(msg.head.txnId, resolve);
    });
}

// TODO: gracefully exit
export async function hotUpdate() {
    for (let i = 0; i < workerThreads.length; ++i) {
        workerThreads[i].terminate();
    }
    workerThreads = [];
    loadBalancer = createLoadBalancer(
        svrCfg!.lbStrategy ?? { strategy: 'roundRobin' },
        svrCfg!.workerThreadNum
    );
    await startWorkerThreads();
}

export * from "./conn_layer/base_cl";
export * from "../logger";
export * from "../message";
