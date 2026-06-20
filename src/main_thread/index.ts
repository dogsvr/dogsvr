import { BaseCL } from "./cl_base";
import { Msg } from "../common/message";
import { log as rootLog } from "./logger";
import { SvrConfig, ServerCore, createServerCore } from "./server_core";
import { createHotUpdateStrategy } from "./hot_update";
import { loadMainThreadConfig } from "./config";
import { logEnvInfo } from "./env_info";
import { getMetricSink } from "./metrics";
import { getSpanSink } from "./tracing";
import "./pm2"

const log = rootLog.child({ module: "main_thread/index" });

let core: ServerCore | null = null;

export function getConnLayer(clName: string): BaseCL {
    return core!.svrCfg.clMap[clName];
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
    startMetricsSampler(cfg);
    log.info("start dog server successfully");
}

function startMetricsSampler(cfg: SvrConfig): void {
    if (!cfg.otel?.metrics?.enabled) return;
    const intervalMs = cfg.otel.metrics.sampleIntervalMs ?? 1000;
    setInterval(() => {
        const c = core;
        if (!c) return;
        const sink = getMetricSink();
        sink.observeTxnPending(Object.keys(c.txnMgr.txnMap).length);
        const perWorker: number[] = c.workerThreads.map(w =>
            c.workerPendingTxns.get(w)?.size ?? 0
        );
        sink.observeWorkerPending(perWorker);
    }, intervalMs).unref();
}

export function sendMsgToWorkerThread(msg: Msg): Promise<Msg> {
    return new Promise((resolve) => {
        msg.head.txnId = core!.txnMgr.genNewTxnId();
        const workerIndex = core!.loadBalancer!.selectWorkerIndex(msg, core!.workerThreads.length);
        const worker = core!.workerThreads[workerIndex];
        const span = getSpanSink().getCurrent();
        if (span) {
            msg.head._otel = {};
            getSpanSink().inject(span, msg.head._otel);
        }
        worker.postMessage(msg);
        core!.loadBalancer!.onMessageSent(workerIndex);
        core!.workerPendingTxns.get(worker)!.add(msg.head.txnId);
        getMetricSink().onCmdStart(msg.head.txnId, String(msg.head.cmdId), workerIndex);
        core!.txnMgr.addTxn(msg.head.txnId, resolve, () => {
            core!.workerPendingTxns.get(worker)?.delete(msg.head.txnId!);
            core!.loadBalancer!.onMessageResolved(workerIndex);
            getMetricSink().onTxnTimeout(msg.head.txnId!, workerIndex);
            msg.head.errCode = -1;
            msg.head.errMsg = `txn timeout|txnId:${msg.head.txnId}`;
            msg.body = '';
            resolve(msg);
        });
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
export type { Log, LoggerImpl, Level } from "../common/logger_types";
export { setMetricSink, getMetricSink, type MetricSink } from "./metrics";
export type { OtelConfig, MetricsConfig, TraceConfig, LogConfig } from "./otel_config";
export { setSpanSink, getSpanSink } from "./tracing";
export type { SpanSink, SpanCtx, SpanHandle } from "../common/tracing_types";
export { onShutdown } from "../common/shutdown";
