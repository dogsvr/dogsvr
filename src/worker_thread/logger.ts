import type { Log, LoggerImpl } from "../common/logger_types";
import { consoleLogger } from "../common/logger_console";
import { makeLogProxy, onImplSwap } from "../common/logger_proxy";

let impl: LoggerImpl | null = null;
let warnedFallback = false;

function currentImpl(): LoggerImpl {
    if (impl !== null) return impl;
    if (!warnedFallback) {
        warnedFallback = true;
        process.emitWarning(
            'logger plugin not registered: using console fallback. Did you forget to import "@dogsvr/logger/worker_thread" and call setupLoggerInWorker()?',
            "DogsvrLoggerWarning",
        );
    }
    return consoleLogger;
}

/**
 * Called by a logger plugin in each worker_thread to bind the backend.
 */
export function registerWorkerLogger(nextImpl: LoggerImpl): void {
    if (impl !== null) {
        throw new Error("logger already registered in this worker");
    }
    impl = nextImpl;
    onImplSwap();
}

export const log: Log = makeLogProxy(currentImpl);
