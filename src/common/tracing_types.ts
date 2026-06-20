// Zero-dependency SpanSink contract shared by main and worker threads.

export interface SpanCtx {
    readonly traceId: string;
    readonly spanId: string;
    readonly traceFlags: number;
    readonly traceState?: string;
}

export interface SpanHandle {
    setAttribute(key: string, value: string | number | boolean): void;
    recordException(err: unknown): void;
    end(ok: boolean): void;
    context(): SpanCtx;
}

export interface SpanSink {
    /** parent=null starts a root span; returned handle is not yet active — wrap work in withActive(). */
    start(name: string, parent: SpanCtx | null, attrs?: Record<string, string | number | boolean>): SpanHandle;
    /** Extract W3C trace-context from a carrier. */
    extract(carrier: Readonly<Record<string, string | undefined>>): SpanCtx | null;
    /** Inject W3C trace-context into a carrier. */
    inject(span: SpanHandle | SpanCtx, carrier: Record<string, string>): void;
    /** Currently-active span on this async context (or null). */
    getCurrent(): SpanHandle | null;
    /** Run fn with span as the active span; promises chained inside inherit the context. */
    withActive<T>(span: SpanHandle, fn: () => T): T;
}

const NoopSpanCtx: SpanCtx = { traceId: '', spanId: '', traceFlags: 0 };
const NoopSpanHandle: SpanHandle = {
    setAttribute() {},
    recordException() {},
    end() {},
    context: () => NoopSpanCtx,
};

export const NoopSpanSink: SpanSink = {
    start: () => NoopSpanHandle,
    extract: () => null,
    inject() {},
    getCurrent: () => null,
    withActive: (_span, fn) => fn(),
};
