/**
 * Logger interface contracts shared between main thread and worker thread.
 * The logger plugin (e.g. @dogsvr/logger) implements these; dogsvr core only
 * sees the interfaces.
 */

export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

/**
 * Implementation contract for a logger backend. Plugin packages register an
 * instance via registerLogger() (main) or registerWorkerLogger() (worker).
 */
export interface LoggerImpl {
    trace(objOrMsg: object | string, msg?: string, ...args: unknown[]): void;
    debug(objOrMsg: object | string, msg?: string, ...args: unknown[]): void;
    info(objOrMsg: object | string, msg?: string, ...args: unknown[]): void;
    warn(objOrMsg: object | string, msg?: string, ...args: unknown[]): void;
    error(objOrMsg: object | string, msg?: string, ...args: unknown[]): void;
    fatal(objOrMsg: object | string, msg?: string, ...args: unknown[]): void;
    isLevelEnabled(level: Level | string): boolean;
    child(bindings: Record<string, unknown>): LoggerImpl;
    flush?(): void;
}

/**
 * Public log API used throughout dogsvr and downstream business code. Methods
 * are overload-typed for both `(obj, msg)` and `(msg)` call shapes.
 */
export interface Log {
    trace(obj: object, msg?: string, ...args: unknown[]): void;
    trace(msg: string, ...args: unknown[]): void;
    debug(obj: object, msg?: string, ...args: unknown[]): void;
    debug(msg: string, ...args: unknown[]): void;
    info(obj: object, msg?: string, ...args: unknown[]): void;
    info(msg: string, ...args: unknown[]): void;
    warn(obj: object, msg?: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(obj: object, msg?: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
    fatal(obj: object, msg?: string, ...args: unknown[]): void;
    fatal(msg: string, ...args: unknown[]): void;
    isLevelEnabled(level: Level | string): boolean;
    child(bindings: Record<string, unknown>): Log;
    flush(): void;
}
