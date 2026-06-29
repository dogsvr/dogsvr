/** Plugin contract; registered via registerLogger / registerWorkerLogger. */
export interface LoggerImpl {
    trace(objOrMsg: object | string, msg?: string, ...args: unknown[]): void;
    debug(objOrMsg: object | string, msg?: string, ...args: unknown[]): void;
    info(objOrMsg: object | string, msg?: string, ...args: unknown[]): void;
    warn(objOrMsg: object | string, msg?: string, ...args: unknown[]): void;
    error(objOrMsg: object | string, msg?: string, ...args: unknown[]): void;
    fatal(objOrMsg: object | string, msg?: string, ...args: unknown[]): void;
    isLevelEnabled(level: string): boolean;
    child(bindings: Record<string, unknown>): LoggerImpl;
    flush?(): void;
}

/** Public log API; obtained via the `log` export from main_thread / worker_thread. */
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
    isLevelEnabled(level: string): boolean;
    child(bindings: Record<string, unknown>): Log;
    flush(): void;
}
