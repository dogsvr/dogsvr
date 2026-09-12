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
import type { DogsvrBroadcastMsg } from "../common/broadcast_types";
import { MainSabMsgChannel } from "./sab_msg_channel";
import { DEFAULT_MSG_SAB_DATA_BYTES, makeMsgSab } from "../common/sab_msg";

const log = rootLog.child({ module: "main_thread/server_core" });

export type HotUpdateStrategyConfig =
    | { strategy: 'allAtOnce' }
    | { strategy: 'rolling' };

export type MsgChannelTransport = 'sab' | 'postMessage';

export interface MsgChannelConfig {
    transport?: MsgChannelTransport;
    /** Rounded up to a power of two; the ring requires it. */
    sabSizeBytes?: number;
    fallbackOnFull?: boolean;
}

export interface SvrConfig {
    workerThreadRunFile: string;
    workerThreadNum: number;
    clMap: { [clName: string]: BaseCL };
    clcMap: { [clcName: string]: BaseCLC };
    lbStrategy?: LbStrategyConfig;                // defaults to roundRobin
    hotUpdateTimeout?: number;                    // worker graceful shutdown timeout (ms), defaults to 30000
    hotUpdateStrategy?: HotUpdateStrategyConfig;  // defaults to 'rolling'
    workerConfigPath?: string;
    msgChannel?: MsgChannelConfig;                // main↔worker channel; defaults to sab transport
    otel?: OtelConfig;                            // optional otel switches (metrics/traces/logs); default off
}

export interface ServerCore {
    svrCfg: SvrConfig;
    workerThreads: Worker[];
    txnMgr: TxnMgr;
    loadBalancer: ILoadBalancer | null;
    workerPendingTxns: Map<Worker, Set<number>>;
    workerChannels: Map<Worker, MainSabMsgChannel>;
    threadCpuSampler: ThreadCpuSampler | null;

    /** Create a new worker; does not add to workerThreads. */
    createWorker(index: number): Worker;
    resetLoadBalancer(): void;
    /** Broadcast a control message to all live workers via parentPort.postMessage. */
    broadcast(msg: DogsvrBroadcastMsg): void;
}

export function createServerCore(cfg: SvrConfig): ServerCore {
    const core: ServerCore = {
        svrCfg: cfg,
        workerThreads: [],
        txnMgr: new TxnMgr(rootLog.child({ module: "main_thread/txnMgr" })),
        loadBalancer: null,
        workerPendingTxns: new Map(),
        workerChannels: new Map(),
        threadCpuSampler:
            cfg.otel?.metrics?.enabled && cfg.otel.metrics.threadStats?.enabled
                ? new ThreadCpuSampler()
                : null,

        createWorker(index: number): Worker {
            const hub = getLoggerHub();
            const loggerPort = hub.issueWorkerPort();
            const loggerInit = hub.workerInitFor(loggerPort);
            const msgCfg = core.svrCfg.msgChannel ?? {};
            const useSab = (msgCfg.transport ?? 'sab') === 'sab';
            const sabBytes = msgCfg.sabSizeBytes ?? DEFAULT_MSG_SAB_DATA_BYTES;
            let msgSabIn: SharedArrayBuffer | null = null;
            let msgSabOut: SharedArrayBuffer | null = null;
            if (useSab) {
                msgSabIn = makeMsgSab(sabBytes);
                msgSabOut = makeMsgSab(sabBytes);
            }
            const workerData: Record<string, unknown> = {
                workerConfigPath: core.svrCfg.workerConfigPath,
                workerIndex: index,
                loggerInit,
                msgChannel: {
                    transport: useSab ? 'sab' : 'postMessage',
                    fallbackOnFull: msgCfg.fallbackOnFull ?? true,
                },
                msgSabIn,
                msgSabOut,
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

            if (useSab && msgSabIn && msgSabOut) {
                // Direction: msgSabIn = worker's IN = main's OUT; msgSabOut = worker's OUT = main's IN.
                const channel = new MainSabMsgChannel(msgSabIn, msgSabOut, worker, dispatchWorkerMsg);
                channel.start();
                core.workerChannels.set(worker, channel);
            }

            worker.on("exit", () => {
                hub.releaseWorkerPort(worker);
                const ch = core.workerChannels.get(worker);
                if (ch) { ch.stop(); core.workerChannels.delete(worker); }
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
                dispatchWorkerMsg(msg as Msg, worker);
            });

            function dispatchWorkerMsg(bizMsg: Msg, w: Worker): void {
                if (bizMsg.head.clcOptions) {
                    core.svrCfg.clcMap[bizMsg.head.clcOptions.clcName].callCmd(
                        bizMsg, bizMsg.head.clcOptions.noResponse ? undefined : w
                    );
                } else if (bizMsg.head.clOptions) {
                    core.svrCfg.clMap[bizMsg.head.clOptions.clName].pushMsg(bizMsg);
                } else {
                    core.workerPendingTxns.get(w)?.delete(bizMsg.head.txnId!);
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
            }

            return worker;
        },

        resetLoadBalancer(): void {
            core.loadBalancer = createLoadBalancer(
                core.svrCfg.lbStrategy ?? { strategy: 'roundRobin' },
                core.svrCfg.workerThreadNum
            );
        },

        broadcast(msg: DogsvrBroadcastMsg): void {
            for (const w of core.workerThreads) {
                w.postMessage(msg);
            }
        }
    };
    return core;
}
