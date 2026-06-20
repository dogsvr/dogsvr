// MetricSink contract for the dogsvr main thread.
// Zero dependency: no-op default; inject a real implementation via setMetricSink().

export interface MetricSink {
    onCmdStart(txnId: number, cmdId: string, workerIndex: number): void;
    onCmdEnd(txnId: number, workerIndex: number, ok: boolean): void;
    onTxnTimeout(txnId: number, workerIndex: number): void;
    /** Periodic sample of pending transaction count. */
    observeTxnPending(count: number): void;
    /** Periodic sample of in-flight requests per worker thread. */
    observeWorkerPending(perWorker: readonly number[]): void;
}

const NoopSink: MetricSink = {
    onCmdStart() {},
    onCmdEnd() {},
    onTxnTimeout() {},
    observeTxnPending() {},
    observeWorkerPending() {},
};

let currentSink: MetricSink = NoopSink;

/** Inject a sink. Pass nothing or undefined to revert to no-op. */
export function setMetricSink(sink?: MetricSink): void {
    currentSink = sink ?? NoopSink;
}

export function getMetricSink(): MetricSink {
    return currentSink;
}
