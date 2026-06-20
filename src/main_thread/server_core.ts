import { Worker, TransferListItem } from "worker_threads";
import { BaseCL, BaseCLC } from "./cl_base";
import { TxnMgr } from "../common/transaction";
import { Msg } from "../common/message";
import { LbStrategyConfig, ILoadBalancer, createLoadBalancer } from "./lb";
import { log as rootLog, getLoggerHub } from "./logger";
import { getMetricSink } from "./metrics";
import { OtelConfig } from "./otel_config";

const log = rootLog.child({ module: "main_thread/server_core" });

export type HotUpdateStrategyConfig =
    | { strategy: 'allAtOnce' }
    | { strategy: 'rolling' };

export interface SvrConfig {
    workerThreadRunFile: string;
    workerThreadNum: number;
    clMap: { [clName: string]: BaseCL };
    clcMap: { [clcName: string]: BaseCLC };
    lbStrategy?: LbStrategyConfig;                // defaults to roundRobin
    hotUpdateTimeout?: number;                    // worker graceful shutdown timeout (ms), defaults to 30000
    hotUpdateStrategy?: HotUpdateStrategyConfig;  // defaults to 'rolling'
    workerConfigPath?: string;                    // config file path for worker threads
    otel?: OtelConfig;                            // optional otel switches (metrics/traces/logs); default off
}

export interface ServerCore {
    svrCfg: SvrConfig;
    workerThreads: Worker[];
    txnMgr: TxnMgr;
    loadBalancer: ILoadBalancer | null;
    workerPendingTxns: Map<Worker, Set<number>>;

    /** Create a new worker; does not add to workerThreads. */
    createWorker(index: number): Worker;
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
                        getMetricSink().onCmdEnd(msg.head.txnId!, index, (msg.head.errCode ?? 0) === 0);
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
