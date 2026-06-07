import * as fs from 'node:fs';
import * as path from 'node:path';
import { SvrConfig } from './server_core';
import { LbStrategyConfig } from './lb';
import { HotUpdateStrategyConfig } from './server_core';
import { createCLFromConfig, createCLCFromConfig } from './cl_factory';
import { BaseCL, BaseCLC } from './cl_base';

/** Raw JSON structure for the main-thread config file. Business fields pass through via the index signature. */
export interface MainThreadJsonConfig {
    workerThreadRunFile: string;
    workerThreadNum: number;
    workerConfigPath?: string;
    cl?: Record<string, { type: string; [key: string]: any }>;
    clc?: Record<string, { type: string; [key: string]: any }>;
    lbStrategy?: LbStrategyConfig;
    hotUpdateTimeout?: number;
    hotUpdateStrategy?: HotUpdateStrategyConfig;
    [key: string]: any;
}

let mainConfig: MainThreadJsonConfig | null = null;
let configDir: string = '';

/** Get the raw main-thread JSON config; use the generic parameter to type-assert custom fields. */
export function getMainThreadConfig<T extends MainThreadJsonConfig = MainThreadJsonConfig>(): T {
    if (!mainConfig) throw new Error('Main thread config not loaded. Call loadMainThreadConfig() first.');
    return mainConfig as T;
}

/** Get the directory of the loaded config file. */
export function getConfigDir(): string {
    return configDir;
}

/** Load main thread config from JSON file and resolve into SvrConfig. */
export function loadMainThreadConfig(configPath: string): SvrConfig {
    const absPath = path.resolve(configPath);
    configDir = path.dirname(absPath);
    const raw = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as MainThreadJsonConfig;
    mainConfig = raw;

    const workerRunFile = path.resolve(configDir, raw.workerThreadRunFile);
    const workerConfigPath = raw.workerConfigPath
        ? path.resolve(configDir, raw.workerConfigPath)
        : undefined;

    const clMap: Record<string, BaseCL> = {};
    if (raw.cl) {
        for (const [name, entry] of Object.entries(raw.cl)) {
            const { type, ...params } = entry;
            clMap[name] = createCLFromConfig(type, params);
        }
    }

    const clcMap: Record<string, BaseCLC> = {};
    if (raw.clc) {
        for (const [name, entry] of Object.entries(raw.clc)) {
            const { type, ...params } = entry;
            clcMap[name] = createCLCFromConfig(type, params);
        }
    }

    return {
        workerThreadRunFile: workerRunFile,
        workerThreadNum: raw.workerThreadNum,
        workerConfigPath,
        clMap,
        clcMap,
        lbStrategy: raw.lbStrategy,
        hotUpdateTimeout: raw.hotUpdateTimeout,
        hotUpdateStrategy: raw.hotUpdateStrategy,
    };
}
