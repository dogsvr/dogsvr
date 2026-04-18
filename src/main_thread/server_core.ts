import { Worker } from "worker_threads";
import { BaseCL, BaseCLC } from "./cl_base";
import { TxnMgr } from "../transaction";
import { Msg } from "../message";
import { LbStrategyConfig, ILoadBalancer, createLoadBalancer } from "./lb";
import { errorLog } from "../logger";

// ---- Hot update strategy config ----

export type HotUpdateStrategyConfig =
    | { strategy: 'allAtOnce' }
    | { strategy: 'rolling' };

// ---- Server config ----

export interface SvrConfig {
    workerThreadRunFile: string;
    workerThreadNum: number;
    clMap: { [clName: string]: BaseCL };
    clcMap: { [clcName: string]: BaseCLC };
    lbStrategy?: LbStrategyConfig;                // defaults to roundRobin if omitted
    hotUpdateTimeout?: number;                    // worker graceful shutdown timeout (ms), defaults to 30000
    hotUpdateStrategy?: HotUpdateStrategyConfig;  // defaults to 'rolling'
    workerConfigPath?: string;                    // config file path for worker threads
}

// ---- ServerCore ----

export interface ServerCore {
    svrCfg: SvrConfig;
    workerThreads: Worker[];
    txnMgr: TxnMgr;
    loadBalancer: ILoadBalancer | null;
    workerPendingTxns: Map<Worker, Set<number>>;

    /** Create a new worker and register its message handler; does not add it to the workerThreads array */
    createWorker(index: number): Worker;
    /** Rebuild the loadBalancer (full reset) */
    resetLoadBalancer(): void;
}

export function createServerCore(cfg: SvrConfig): ServerCore {
    const core: ServerCore = {
        svrCfg: cfg,
        workerThreads: [],
        txnMgr: new TxnMgr(),
        loadBalancer: null,
        workerPendingTxns: new Map(),

        createWorker(index: number): Worker {
            const worker = new Worker(core.svrCfg.workerThreadRunFile, {
                workerData: { workerConfigPath: core.svrCfg.workerConfigPath }
            });
            core.workerPendingTxns.set(worker, new Set());
            worker.on("message", (msg: Msg) => {
                if (msg.head.clcOptions) {
                    core.svrCfg.clcMap[msg.head.clcOptions.clcName].callCmd(
                        msg, msg.head.clcOptions.noResponse ? undefined : worker
                    );
                } else if (msg.head.clOptions) {
                    core.svrCfg.clMap[msg.head.clOptions.clName].pushMsg(msg);
                } else {
                    core.workerPendingTxns.get(worker)?.delete(msg.head.txnId!);
                    const cb = core.txnMgr.onCallback(msg.head.txnId!);
                    if (cb) {
                        core.loadBalancer!.onMessageResolved(index);
                        cb(msg);
                    } else {
                        errorLog(`No callback for txnId ${msg.head.txnId}|${msg.head.cmdId}`);
                    }
                }
            });
            return worker;
        },

        resetLoadBalancer(): void {
            core.loadBalancer = createLoadBalancer(
                core.svrCfg.lbStrategy ?? { strategy: 'roundRobin' },
                core.svrCfg.workerThreadNum
            );
        }
    };
    return core;
}
