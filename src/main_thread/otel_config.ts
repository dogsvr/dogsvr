// Framework-side OTel config schema. Zero dependency: no @opentelemetry/* imports.
// Application code extends these interfaces to add OTLP exporter details.

export interface MetricsConfig {
    enabled: boolean;
    /** Framework sampling loop period (ms). Defaults to 5000. */
    sampleIntervalMs?: number;
    /** Per-thread CPU + process memory sampling. Requires Linux + /proc; opt-in. */
    threadStats?: ThreadStatsConfig;
}

export interface ThreadStatsConfig {
    enabled: boolean;
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
