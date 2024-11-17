import {isMainThread, threadId} from "worker_threads";
import * as util from "node:util";

export const LOG_LEVEL_TRACE = 1;
export const LOG_LEVEL_DEBUG = 2;
export const LOG_LEVEL_INFO = 3;
export const LOG_LEVEL_WARN = 4;
export const LOG_LEVEL_ERROR = 5;
export const LOG_LEVEL_NONE = 9;

export interface LoggerImpl {
    trace(...args: any[]): void;
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
}

class ConsoleLoggerImpl implements LoggerImpl {
    readonly log_level_string_names = ["trace","debug","info","warn","error"];
    
    private padNumber(num: number): string {
        let T = ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09'];
        return T[num] || num.toString();
    }

    private getTimeString(date: Date): string {
        return date.getFullYear() + '-'
            + this.padNumber(date.getMonth() + 1) + '-'
            + this.padNumber(date.getDate()) + ' '
            + this.padNumber(date.getHours()) + ':'
            + this.padNumber(date.getMinutes()) + ':'
            + this.padNumber(date.getSeconds()) + '.'
            + date.getMilliseconds();
    }

    private log(level: number, ...args: any[]) {
        let content = this.getTimeString(new Date()) + '|'
            + this.log_level_string_names[level - 1] + '|'
            + process.pid + "|"
            + (isMainThread ? "main" : threadId) + "|"
            + util.format(...args);
        console.log(content);
    }
    
    trace(...args: any[]): void {
        this.log(LOG_LEVEL_TRACE, ...args);
    }

    debug(...args: any[]): void {
        this.log(LOG_LEVEL_DEBUG, ...args);
    }

    info(...args: any[]): void {
        this.log(LOG_LEVEL_INFO, ...args);
    }

    warn(...args: any[]): void {
        this.log(LOG_LEVEL_WARN, ...args);
    }

    error(...args: any[]): void {
        this.log(LOG_LEVEL_ERROR, ...args);
    }
}

let loggerImpl: LoggerImpl = new ConsoleLoggerImpl();
let logLevel = LOG_LEVEL_INFO;

export function setLoggerImpl(impl: LoggerImpl): void {
    loggerImpl = impl;
}

export function setLogLevel(level: number): void {
    logLevel = level;
}

export function traceLog(...args: any[]): void {
    if (logLevel <= LOG_LEVEL_TRACE) {
        loggerImpl.trace(...args);
    }
}

export function debugLog(...args: any[]): void {
    if (logLevel <= LOG_LEVEL_DEBUG) {
        loggerImpl.debug(...args);
    }
}

export function infoLog(...args: any[]): void {
    if (logLevel <= LOG_LEVEL_INFO) {
        loggerImpl.info(...args);
    }
}

export function warnLog(...args: any[]): void {
    if (logLevel <= LOG_LEVEL_WARN) {
        loggerImpl.warn(...args);
    }
}

export function errorLog(...args: any[]): void {
    if (logLevel <= LOG_LEVEL_ERROR) {
        loggerImpl.error(...args);
    }
}
