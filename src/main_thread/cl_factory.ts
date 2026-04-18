import { BaseCL, BaseCLC } from "./cl_base";

/**
 * Factory function signature for creating CL instances from JSON config params.
 * `params` is the raw JSON object from config (minus the `type` field).
 */
export type CLFactory = (params: Record<string, any>) => BaseCL;

/**
 * Factory function signature for creating CLC instances from JSON config params.
 */
export type CLCFactory = (params: Record<string, any>) => BaseCLC;

// Internal registries
const clFactoryMap: Record<string, CLFactory> = {};
const clcFactoryMap: Record<string, CLCFactory> = {};

/** Register a CL factory. Called by CL packages (e.g., cl-tsrpc, cl-grpc). */
export function registerCLFactory(type: string, factory: CLFactory): void {
    if (clFactoryMap[type]) {
        throw new Error(`CL factory '${type}' already registered`);
    }
    clFactoryMap[type] = factory;
}

/** Register a CLC factory. Called by CL packages (e.g., cl-grpc). */
export function registerCLCFactory(type: string, factory: CLCFactory): void {
    if (clcFactoryMap[type]) {
        throw new Error(`CLC factory '${type}' already registered`);
    }
    clcFactoryMap[type] = factory;
}

/** Internal: resolve a cl config entry into a BaseCL instance. */
export function createCLFromConfig(type: string, params: Record<string, any>): BaseCL {
    const factory = clFactoryMap[type];
    if (!factory) {
        throw new Error(`No CL factory registered for type '${type}'. Did you forget to call registerCLFactory('${type}', ...)?`);
    }
    return factory(params);
}

/** Internal: resolve a clc config entry into a BaseCLC instance. */
export function createCLCFromConfig(type: string, params: Record<string, any>): BaseCLC {
    const factory = clcFactoryMap[type];
    if (!factory) {
        throw new Error(`No CLC factory registered for type '${type}'. Did you forget to call registerCLCFactory('${type}', ...)?`);
    }
    return factory(params);
}
