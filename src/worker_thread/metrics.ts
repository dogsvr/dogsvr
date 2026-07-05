import { log as rootLog } from "./logger";

const log = rootLog.child({ module: "worker_thread/metrics" });

export interface WorkerMetricSink {
    onHandlerStart(txnId: number, cmdId: number): void;
    onHandlerEnd(txnId: number, cmdId: number, ok: boolean): void;
}

const NoopSink: WorkerMetricSink = {
    onHandlerStart() {},
    onHandlerEnd() {},
};

let currentSink: WorkerMetricSink = NoopSink;

export function setWorkerMetricSink(sink?: WorkerMetricSink): void {
    currentSink = sink ?? NoopSink;
}

export function getWorkerMetricSink(): WorkerMetricSink {
    return currentSink;
}

/** Log-and-swallow wrapper for injected sink calls; a throw here would corrupt hot paths. */
export function safeCall(what: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        log.error({ err, what }, "sink call threw");
    }
}
