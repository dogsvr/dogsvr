import { Worker } from "worker_threads";
import { BaseCL, BaseCLC } from "./base_cl";
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
    lbStrategy?: LbStrategyConfig;                // 不填默认 roundRobin
    hotUpdateTimeout?: number;                    // worker 优雅退出超时(ms)，默认 30000
    hotUpdateStrategy?: HotUpdateStrategyConfig;  // 默认 'rolling'
}

// ---- ServerCore ----

export interface ServerCore {
    svrCfg: SvrConfig;
    workerThreads: Worker[];
    txnMgr: TxnMgr;
    loadBalancer: ILoadBalancer | null;
    workerPendingTxns: Map<Worker, Set<number>>;

    /** 创建新 worker 并注册 message handler，不放入 workerThreads 数组 */
    createWorker(index: number): Worker;
    /** 重建 loadBalancer（全量重置） */
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
            const worker = new Worker(core.svrCfg.workerThreadRunFile);
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
