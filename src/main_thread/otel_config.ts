// Framework-side OTel config schema. Zero dependency: no @opentelemetry/* imports.
// Application code extends these interfaces to add OTLP exporter details.

export interface MetricsConfig {
    /** Master switch. */
    enabled: boolean;
    /** Period (ms) for the framework's txnPending/workerPending sampling loop. Defaults to 1000. */
    sampleIntervalMs?: number;
}

export interface TraceConfig {
    enabled: boolean;
}

export interface LogConfig {
    enabled: boolean;
}

export interface OtelConfig {
    metrics?: MetricsConfig;
    traces?:  TraceConfig;
    logs?:    LogConfig;
}
