import type { Level, LoggerImpl } from "./logger_types";

/**
 * Console-based fallback used until a logger plugin registers itself.
 * Output is human-readable, not NDJSON. Always emits at info+ regardless of
 * isLevelEnabled — the assumption is that the fallback is wrong and you want
 * to see warnings about it.
 */

const LEVEL_ORDER: Record<Level, number> = {
    trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 100,
};

function format(level: string, bindings: Record<string, unknown>, a: object | string, b?: string): string {
    const ts = new Date().toISOString();
    const mod = bindings.module ? `[${bindings.module}]` : "";
    let msg: string;
    let extra: object | undefined;
    if (typeof a === "string") {
        msg = a;
    } else {
        extra = a;
        msg = b ?? "";
    }
    const extraStr = extra ? ` ${JSON.stringify(extra)}` : "";
    return `[${ts}][${level.toUpperCase()}]${mod} ${msg}${extraStr}`;
}

function makeImpl(bindings: Record<string, unknown>): LoggerImpl {
    return {
        trace: (a, b) => console.log(format("trace", bindings, a, b)),
        debug: (a, b) => console.log(format("debug", bindings, a, b)),
        info:  (a, b) => console.log(format("info",  bindings, a, b)),
        warn:  (a, b) => console.warn(format("warn", bindings, a, b)),
        error: (a, b) => console.error(format("error", bindings, a, b)),
        fatal: (a, b) => console.error(format("fatal", bindings, a, b)),
        isLevelEnabled: (level: Level | string) => (LEVEL_ORDER[level as Level] ?? 0) >= LEVEL_ORDER.info,
        child: (childBindings) => makeImpl({ ...bindings, ...childBindings }),
    };
}

export const consoleLogger: LoggerImpl = makeImpl({});
