import * as fs from 'node:fs';
import * as path from 'node:path';
import { workerData } from 'node:worker_threads';

/** Worker thread config base. Business code extends this and retrieves it via `getThreadConfig<MyConfig>()`. */
export interface WorkerThreadBaseConfig {
    [key: string]: any;
}

let workerConfig: WorkerThreadBaseConfig | null = null;

/** Get the worker thread config typed with user's custom interface. */
export function getThreadConfig<T extends WorkerThreadBaseConfig = WorkerThreadBaseConfig>(): T {
    if (!workerConfig) throw new Error('Worker thread config not loaded. Call loadWorkerThreadConfig() first.');
    return workerConfig as T;
}

/** Load worker thread config from JSON file. Falls back to workerData.workerConfigPath if configPath is omitted. */
export function loadWorkerThreadConfig(configPath?: string): void {
    const filePath = configPath ?? workerData?.workerConfigPath;
    if (!filePath) {
        throw new Error('No worker config path provided. Pass configPath or ensure workerConfigPath is set in main thread config.');
    }
    const absPath = path.resolve(filePath);
    const raw = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as WorkerThreadBaseConfig;
    workerConfig = raw;
}
