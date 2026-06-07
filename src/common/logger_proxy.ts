import type { Log, LoggerImpl } from "./logger_types";

/**
 * Log proxy with two non-obvious behaviors:
 *   1. `.impl` resolves lazily — importing dogsvr alone does not invoke
 *      parent() (whose first call emits the "no plugin registered" warning).
 *   2. The one-shot console→pino swap propagates to pre-swap proxies via the
 *      `refreshers` list. Iteration must stay front-to-back so each child's
 *      refresher reads its parent's already-updated snap.
 */

type Refresh = () => void;
let refreshers: Refresh[] | null = [];

export function onImplSwap(): void {
    if (refreshers === null) return;
    const list = refreshers;
    refreshers = null;
    for (const r of list) r();
}

interface Snap { impl: LoggerImpl | null }

function buildProxy(snap: Snap, parent: () => LoggerImpl): Log {
    return {
        trace: ((a: object | string, b?: string, ...c: unknown[]) => ((snap.impl ?? (snap.impl = parent())) as any).trace(a, b, ...c)) as Log["trace"],
        debug: ((a: object | string, b?: string, ...c: unknown[]) => ((snap.impl ?? (snap.impl = parent())) as any).debug(a, b, ...c)) as Log["debug"],
        info:  ((a: object | string, b?: string, ...c: unknown[]) => ((snap.impl ?? (snap.impl = parent())) as any).info (a, b, ...c)) as Log["info"],
        warn:  ((a: object | string, b?: string, ...c: unknown[]) => ((snap.impl ?? (snap.impl = parent())) as any).warn (a, b, ...c)) as Log["warn"],
        error: ((a: object | string, b?: string, ...c: unknown[]) => ((snap.impl ?? (snap.impl = parent())) as any).error(a, b, ...c)) as Log["error"],
        fatal: ((a: object | string, b?: string, ...c: unknown[]) => ((snap.impl ?? (snap.impl = parent())) as any).fatal(a, b, ...c)) as Log["fatal"],
        isLevelEnabled: (level: string) => (snap.impl ?? (snap.impl = parent())).isLevelEnabled(level),
        child: (bindings: Record<string, unknown>) => {
            const childSnap: Snap = { impl: null };
            const childParent = () => (snap.impl ?? (snap.impl = parent())).child(bindings);
            if (refreshers !== null) {
                refreshers.push(() => { childSnap.impl = childParent(); });
            }
            return buildProxy(childSnap, childParent);
        },
        flush: () => snap.impl?.flush?.(),
    };
}

export function makeLogProxy(parent: () => LoggerImpl): Log {
    const snap: Snap = { impl: null };
    if (refreshers !== null) {
        refreshers.push(() => { snap.impl = parent(); });
    }
    return buildProxy(snap, parent);
}
