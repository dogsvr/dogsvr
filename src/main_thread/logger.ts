import type { Worker, MessagePort } from "worker_threads";
import type { Log, LoggerImpl } from "../common/logger_types";
import { consoleLogger } from "../common/logger_console";
import { makeLogProxy, onImplSwap } from "../common/logger_proxy";

/**
 * Payload the main thread injects into Worker.workerData.loggerInit so the
 * worker can call setupLoggerInWorker without re-deciding mode/destination.
 * The plugin defines the concrete shape; dogsvr only needs to forward it.
 */
export interface WorkerInitPayload {
    [key: string]: unknown;
}

/**
 * Side-channel handle that lets dogsvr's createWorker hand each spawned worker
 * a fresh MessagePort plus the init payload. Plugin packages provide the
 * concrete implementation; dogsvr core only sees this interface.
 */
export interface LoggerHub {
    issueWorkerPort(): MessagePort | undefined;
    releaseWorkerPort(worker: Worker): void;
    workerInitFor(port: MessagePort | undefined): WorkerInitPayload;
    bufferedBytes(): number;
    flush(): void;
}

let impl: LoggerImpl | null = null;
let hub: LoggerHub | null = null;
let warnedFallback = false;

function currentImpl(): LoggerImpl {
    if (impl !== null) return impl;
    if (!warnedFallback) {
        warnedFallback = true;
        process.emitWarning(
            'logger plugin not registered: using console fallback. Did you forget to import "@dogsvr/logger/main_thread" and call setupLogger()?',
            "DogsvrLoggerWarning",
        );
    }
    return consoleLogger;
}

/**
 * Called by a logger plugin (e.g. @dogsvr/logger) once the backend is set up.
 * Throws on duplicate registration to surface accidental double-init.
 */
export function registerLogger(nextImpl: LoggerImpl, nextHub: LoggerHub): void {
    if (impl !== null) {
        throw new Error("logger already registered");
    }
    impl = nextImpl;
    hub = nextHub;
    onImplSwap();
}

/**
 * Internal: dogsvr core retrieves the registered hub when spawning workers.
 * Throws if no plugin has registered, since spawning workers without a hub
 * would silently misroute log lines.
 */
export function getLoggerHub(): LoggerHub {
    if (hub === null) {
        throw new Error(
            'logger plugin not registered: cannot spawn workers without a LoggerHub. ' +
            'Import "@dogsvr/logger/main_thread" and call setupLogger() before startServer().',
        );
    }
    return hub;
}

export const log: Log = makeLogProxy(currentImpl);
