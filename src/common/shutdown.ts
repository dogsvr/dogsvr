// Async shutdown hook registry. Both main and worker threads call onShutdown(fn);
// on SIGTERM/SIGINT/beforeExit all handlers run via Promise.allSettled.

type ShutdownFn = () => void | Promise<void>;

const handlers: ShutdownFn[] = [];
let installed = false;

/** Register a shutdown handler. Idempotent. */
export function onShutdown(fn: ShutdownFn): void {
    handlers.push(fn);
    install();
}

function install(): void {
    if (installed) return;
    installed = true;

    let draining = false;
    const drain = async (signal: string, exitCode: number): Promise<void> => {
        if (draining) return;
        draining = true;
        await Promise.allSettled(handlers.map(h => Promise.resolve().then(h)));
        if (signal !== "beforeExit") {
            process.exit(exitCode);
        }
    };

    process.once("beforeExit", () => { void drain("beforeExit", 0); });
    process.once("SIGINT",     () => { void drain("SIGINT",  130); });
    process.once("SIGTERM",    () => { void drain("SIGTERM", 143); });
}

/** Internal: reset for tests. */
export function _resetShutdownForTest(): void {
    handlers.length = 0;
    installed = false;
}
