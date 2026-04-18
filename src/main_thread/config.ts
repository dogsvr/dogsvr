import * as fs from 'node:fs';
import * as path from 'node:path';
import { SvrConfig } from './server_core';
import { LbStrategyConfig } from './lb';
import { HotUpdateStrategyConfig } from './server_core';
import { createCLFromConfig, createCLCFromConfig } from './cl_factory';
import { BaseCL, BaseCLC } from './cl_base';
import {
    setLogLevel,
    LOG_LEVEL_TRACE, LOG_LEVEL_DEBUG, LOG_LEVEL_INFO,
    LOG_LEVEL_WARN, LOG_LEVEL_ERROR
} from '../logger';

/** Raw JSON structure for main thread config file. */
export interface MainThreadJsonConfig {
    workerThreadRunFile: string;
    workerThreadNum: number;
    workerConfigPath?: string;
    logLevel?: string;
    cl?: Record<string, { type: string; [key: string]: any }>;
    clc?: Record<string, { type: string; [key: string]: any }>;
    lbStrategy?: LbStrategyConfig;
    hotUpdateTimeout?: number;
    hotUpdateStrategy?: HotUpdateStrategyConfig;
    [key: string]: any;
}

// Global singleton
let mainConfig: MainThreadJsonConfig | null = null;
let configDir: string = '';

/**
 * Get the raw main-thread JSON config.
 * Use the generic parameter to type-assert custom fields.
 */
export function getMainThreadConfig<T extends MainThreadJsonConfig = MainThreadJsonConfig>(): T {
    if (!mainConfig) throw new Error('Main thread config not loaded. Call loadMainThreadConfig() first.');
    return mainConfig as T;
}

/** Get the directory of the loaded config file (for resolving relative paths). */
export function getConfigDir(): string {
    return configDir;
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
 * Load main thread config from JSON file and resolve into SvrConfig.
 * The configPath is resolved relative to cwd if not absolute.
 */
export function loadMainThreadConfig(configPath: string): SvrConfig {
    const absPath = path.resolve(configPath);
    configDir = path.dirname(absPath);
    const raw = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as MainThreadJsonConfig;
    mainConfig = raw;

    // Apply log level
    const ll = parseLogLevel(raw.logLevel);
    if (ll !== undefined) setLogLevel(ll);

    // Resolve workerThreadRunFile relative to config file directory
    const workerRunFile = path.resolve(configDir, raw.workerThreadRunFile);

    // Resolve workerConfigPath relative to config file directory
    const workerConfigPath = raw.workerConfigPath
        ? path.resolve(configDir, raw.workerConfigPath)
        : undefined;

    // Build clMap via factories
    const clMap: Record<string, BaseCL> = {};
    if (raw.cl) {
        for (const [name, entry] of Object.entries(raw.cl)) {
            const { type, ...params } = entry;
            clMap[name] = createCLFromConfig(type, params);
        }
    }

    // Build clcMap via factories
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
