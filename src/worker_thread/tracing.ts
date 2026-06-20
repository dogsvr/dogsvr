import { SpanSink, NoopSpanSink } from "../common/tracing_types";

let currentSink: SpanSink = NoopSpanSink;

/** Inject a sink. Pass nothing or undefined to revert to no-op. */
export function setSpanSink(sink?: SpanSink): void {
    currentSink = sink ?? NoopSpanSink;
}

export function getSpanSink(): SpanSink {
    return currentSink;
}
