import { log as rootLog } from "./logger";

const log = rootLog.child({ module: "main_thread/metrics" });

export interface MetricSink {
    onCmdStart(txnId: number, cmdId: number): void;
    onCmdEnd(txnId: number, ok: boolean): void;
    onTxnTimeout(txnId: number): void;
}

const NoopSink: MetricSink = {
    onCmdStart() {},
    onCmdEnd() {},
    onTxnTimeout() {},
};

let currentSink: MetricSink = NoopSink;

export function setMetricSink(sink?: MetricSink): void {
    currentSink = sink ?? NoopSink;
}

export function getMetricSink(): MetricSink {
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
