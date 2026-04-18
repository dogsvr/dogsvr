import * as fs from 'node:fs';
import * as path from 'node:path';
import { workerData } from 'node:worker_threads';
import {
    setLogLevel,
    LOG_LEVEL_TRACE, LOG_LEVEL_DEBUG, LOG_LEVEL_INFO,
    LOG_LEVEL_WARN, LOG_LEVEL_ERROR
} from '../logger';

/** Framework-recognized fields in worker thread config. User business fields are added via extends. */
export interface WorkerThreadBaseConfig {
    logLevel?: string;
    [key: string]: any;
}

let workerConfig: WorkerThreadBaseConfig | null = null;

/**
 * Get the worker thread config, typed with user's custom interface.
 * Example: getThreadConfig<MyWorkerConfig>().mongoUri
 */
export function getThreadConfig<T extends WorkerThreadBaseConfig = WorkerThreadBaseConfig>(): T {
    if (!workerConfig) throw new Error('Worker thread config not loaded. Call loadWorkerThreadConfig() first.');
    return workerConfig as T;
}

function parseLogLevel(level?: string): number | undefined {
    switch (level) {
        case 'trace': return LOG_LEVEL_TRACE;
        case 'debug': return LOG_LEVEL_DEBUG;
        case 'info':  return LOG_LEVEL_INFO;
        case 'warn':  return LOG_LEVEL_WARN;
        case 'error': return LOG_LEVEL_ERROR;
        default:      return undefined;
    }
}

/**
 * Load worker thread config from JSON file.
 * If configPath is not provided, reads from workerData.workerConfigPath
 * (set by the main thread via Worker constructor).
 */
export function loadWorkerThreadConfig(configPath?: string): void {
    const filePath = configPath ?? workerData?.workerConfigPath;
    if (!filePath) {
        throw new Error('No worker config path provided. Pass configPath or ensure workerConfigPath is set in main thread config.');
    }
    const absPath = path.resolve(filePath);
    const raw = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as WorkerThreadBaseConfig;
    workerConfig = raw;

    const ll = parseLogLevel(raw.logLevel);
    if (ll !== undefined) setLogLevel(ll);
}
