import { Worker, TransferListItem } from "worker_threads";
import { BaseCL, BaseCLC } from "./cl_base";
import { TxnMgr } from "../common/transaction";
import { Msg } from "../common/message";
import { LbStrategyConfig, ILoadBalancer, createLoadBalancer } from "./lb";
import { log as rootLog, getLoggerHub } from "./logger";
import { getMetricSink, safeCall } from "./metrics";
import { OtelConfig } from "./otel_config";
import { ThreadCpuSampler } from "./thread_stats";
import type { DogsvrCtlMsg } from "../common/thread_stats_types";

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
    threadCpuSampler: ThreadCpuSampler | null;

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
        threadCpuSampler:
            cfg.otel?.metrics?.enabled && cfg.otel.metrics.threadStats?.enabled
                ? new ThreadCpuSampler()
                : null,

        createWorker(index: number): Worker {
            const hub = getLoggerHub();
            const loggerPort = hub.issueWorkerPort();
            const loggerInit = hub.workerInitFor(loggerPort);
            const workerData: Record<string, unknown> = {
                workerConfigPath: core.svrCfg.workerConfigPath,
                workerIndex: index,
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
            worker.on("exit", () => {
                hub.releaseWorkerPort(worker);
                // On hot-update the new worker registers its tid before the old one exits; guard against clobber.
                if (core.workerThreads[index] === worker) {
                    core.threadCpuSampler?.unregister(index);
                }
            });
            worker.on("message", (msg: Msg | DogsvrCtlMsg) => {
                if ((msg as DogsvrCtlMsg).__dogsvrCtl === 'tidReport') {
                    const ctl = msg as DogsvrCtlMsg;
                    core.threadCpuSampler?.registerWorkerTid(ctl.workerIndex, ctl.nodeThreadId, ctl.osTid);
                    return;
                }
                const bizMsg = msg as Msg;
                if (bizMsg.head.clcOptions) {
                    core.svrCfg.clcMap[bizMsg.head.clcOptions.clcName].callCmd(
                        bizMsg, bizMsg.head.clcOptions.noResponse ? undefined : worker
                    );
                } else if (bizMsg.head.clOptions) {
                    core.svrCfg.clMap[bizMsg.head.clOptions.clName].pushMsg(bizMsg);
                } else {
                    core.workerPendingTxns.get(worker)?.delete(bizMsg.head.txnId!);
                    const cb = core.txnMgr.onCallback(bizMsg.head.txnId!);
                    if (cb) {
                        core.loadBalancer!.onMessageResolved(index);
                        safeCall("MetricSink.onCmdEnd", () =>
                            getMetricSink().onCmdEnd(bizMsg.head.txnId!, (bizMsg.head.errCode ?? 0) === 0));
                        cb(bizMsg);
                    } else {
                        log.error({ txnId: bizMsg.head.txnId, cmdId: bizMsg.head.cmdId }, "no callback for txnId");
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
