import { Worker, TransferListItem } from "worker_threads";
import { BaseCL, BaseCLC } from "./cl_base";
import { TxnMgr } from "../common/transaction";
import { Msg } from "../common/message";
import { LbStrategyConfig, ILoadBalancer, createLoadBalancer } from "./lb";
import { log as rootLog, getLoggerHub } from "./logger";

const log = rootLog.child({ module: "main_thread/server_core" });

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
    lbStrategy?: LbStrategyConfig;                // defaults to roundRobin
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

    /** Create a new worker and register its message handler; does not add to workerThreads */
    createWorker(index: number): Worker;
    /** Rebuild the loadBalancer (full reset) */
    resetLoadBalancer(): void;
}

export function createServerCore(cfg: SvrConfig): ServerCore {
    const core: ServerCore = {
        svrCfg: cfg,
        workerThreads: [],
        txnMgr: new TxnMgr(rootLog.child({ module: "main_thread/txnMgr" })),
        loadBalancer: null,
        workerPendingTxns: new Map(),

        createWorker(index: number): Worker {
            // Inject logger port into workerData so the worker can call setupLoggerInWorker
            // without re-deciding mode. Throws if no logger plugin is registered (fail fast).
            const hub = getLoggerHub();
            const loggerPort = hub.issueWorkerPort();
            const loggerInit = hub.workerInitFor(loggerPort);
            const workerData: Record<string, unknown> = {
                workerConfigPath: core.svrCfg.workerConfigPath,
                loggerInit,
            };
            const transferList: TransferListItem[] = [];
            if (loggerPort) {
                transferList.push(loggerPort);
            }
            const worker = new Worker(core.svrCfg.workerThreadRunFile, {
                workerData,
                transferList,
            });
            core.workerPendingTxns.set(worker, new Set());
            // Clean up port tracking when the worker exits (rolling hot-update relies on this).
            worker.on("exit", () => hub.releaseWorkerPort(worker));
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
                        log.error({ txnId: msg.head.txnId, cmdId: msg.head.cmdId }, "no callback for txnId");
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
