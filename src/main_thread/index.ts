import { BaseCL } from "./cl_base";
import { Msg } from "../common/message";
import { log as rootLog } from "./logger";
import { SvrConfig, ServerCore, createServerCore } from "./server_core";
import { createHotUpdateStrategy } from "./hot_update";
import { loadMainThreadConfig } from "./config";
import { logEnvInfo } from "./env_info";
import { getMetricSink, safeCall } from "./metrics";
import { getSpanSink } from "./tracing";
import type { ThreadStatsSnapshot } from "../common/thread_stats_types";
import "./pm2"

const log = rootLog.child({ module: "main_thread/index" });

let core: ServerCore | null = null;

export function getConnLayer(clName: string): BaseCL {
    return core!.svrCfg.clMap[clName];
}

export function getLatestThreadStatsSnapshot(): ThreadStatsSnapshot | null {
    return core?.threadCpuSampler?.getSnapshot() ?? null;
}

export function getTxnPendingCount(): number {
    return core === null ? 0 : Object.keys(core.txnMgr.txnMap).length;
}

export function getWorkerPendingCounts(): readonly number[] {
    if (core === null) return [];
    const c = core;
    return c.workerThreads.map(w => c.workerPendingTxns.get(w)?.size ?? 0);
}

export async function startServer(cfg: SvrConfig): Promise<void>;
export async function startServer(configPath: string): Promise<void>;
export async function startServer(cfgOrPath: SvrConfig | string): Promise<void> {
    logEnvInfo();
    let cfg: SvrConfig;
    if (typeof cfgOrPath === 'string') {
        cfg = loadMainThreadConfig(cfgOrPath);
    } else {
        cfg = cfgOrPath;
    }
    core = createServerCore(cfg);
    core.resetLoadBalancer();
    for (let i = 0; i < cfg.workerThreadNum; i++) {
        core.workerThreads.push(core.createWorker(i));
    }
    for (const cl of Object.values(cfg.clMap)) {
        await cl.startListen();
    }
    startThreadStatsSampler(cfg);
    log.info("start dog server successfully");
}

function startThreadStatsSampler(cfg: SvrConfig): void {
    const sampler = core?.threadCpuSampler;
    if (!sampler) return;
    const intervalMs = cfg.otel?.metrics?.sampleIntervalMs ?? 5000;
    sampler.start(intervalMs, (err) => log.error({ err }, "thread stats sample failed"));
}

export function sendMsgToWorkerThread(msg: Msg): Promise<Msg> {
    return new Promise((resolve) => {
        msg.head.txnId = core!.txnMgr.genNewTxnId();
        const workerIndex = core!.loadBalancer!.selectWorkerIndex(msg, core!.workerThreads.length);
        const worker = core!.workerThreads[workerIndex];
        safeCall("SpanSink.inject", () => {
            const span = getSpanSink().getCurrent();
            if (span) {
                msg.head._otel = {};
                getSpanSink().inject(span, msg.head._otel);
            }
        });
        // Register txn callback BEFORE postMessage: any subsequent throw would otherwise hang the Promise.
        core!.txnMgr.addTxn(msg.head.txnId, resolve, () => {
            core!.workerPendingTxns.get(worker)?.delete(msg.head.txnId!);
            core!.loadBalancer!.onMessageResolved(workerIndex);
            safeCall("MetricSink.onTxnTimeout", () =>
                getMetricSink().onTxnTimeout(msg.head.txnId!));
            msg.head.errCode = -1;
            msg.head.errMsg = `txn timeout|txnId:${msg.head.txnId}`;
            msg.body = '';
            resolve(msg);
        });
        worker.postMessage(msg);
        core!.loadBalancer!.onMessageSent(workerIndex);
        core!.workerPendingTxns.get(worker)!.add(msg.head.txnId);
        safeCall("MetricSink.onCmdStart", () =>
            getMetricSink().onCmdStart(msg.head.txnId!, msg.head.cmdId));
    });
}

let isHotUpdating = false;

export async function hotUpdate() {
    if (isHotUpdating) {
        log.warn("hotUpdate called while already updating, ignoring");
        return;
    }
    isHotUpdating = true;
    try {
        const strategy = createHotUpdateStrategy(core!.svrCfg.hotUpdateStrategy);
        await strategy.execute(core!);
    } finally {
        isHotUpdating = false;
    }
}

export * from "./cl_base";
export { SvrConfig } from "./server_core";
export * from "../common/message";
export { registerCLFactory, registerCLCFactory } from "./cl_factory";
export { loadMainThreadConfig, getMainThreadConfig, getConfigDir, MainThreadJsonConfig } from "./config";
export { log, registerLogger, type LoggerHub, type WorkerInitPayload } from "./logger";
export type { Log, LoggerImpl } from "../common/logger_types";
export { setMetricSink, getMetricSink, type MetricSink } from "./metrics";
export type { OtelConfig, MetricsConfig, TraceConfig, LogConfig, ThreadStatsConfig } from "./otel_config";
export { setSpanSink, getSpanSink } from "./tracing";
export type { SpanSink, SpanCtx, SpanHandle } from "../common/tracing_types";
export type { ThreadCpuSample, ThreadRole, ThreadCpuMode, ProcessSnapshot, ThreadStatsSnapshot } from "../common/thread_stats_types";
export { onShutdown } from "../common/shutdown";
