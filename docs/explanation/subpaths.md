# Subpaths

`@dogsvr/dogsvr` exposes three subpath entry points and — deliberately — no root entry:

| Subpath | Surface | Runs in |
|---|---|---|
| `@dogsvr/dogsvr/main_thread` | `startServer`, `sendMsgToWorkerThread`, `hotUpdate`, `getConnLayer`, `BaseCL`, `BaseCLC`, `registerCLFactory`, `registerCLCFactory`, `loadMainThreadConfig`, `getMainThreadConfig`, `log`, `registerLogger`, `Msg`, … | Main thread only |
| `@dogsvr/dogsvr/worker_thread` | `workerReady`, `regCmdHandler`, `respondCmd`, `respondError`, `callCmdByClc`, `pushMsgByCl`, `loadWorkerThreadConfig`, `getThreadConfig<T>`, `log`, `registerWorkerLogger`, `Msg`, … | Business worker threads |
| `@dogsvr/dogsvr/common` | `SabLineWriter`, `SabLineReader`, `makeLineSab` | Either side; consumed by external packages (currently `@dogsvr/logger`) |

`require('@dogsvr/dogsvr')` returns `ERR_PACKAGE_PATH_NOT_EXPORTED`. This is intentional (see below).

This note covers **what each subpath is for**, **how the three-subpath layout resolves under every JS toolchain**, and **the single-sided rule that keeps main-side and worker-side code from tangling**.

## Why no root entry

If both halves of the framework were reachable from one root module, a worker thread could `import { startServer } from '@dogsvr/dogsvr'` and recursively spawn more workers — a fork bomb. Splitting the surface into subpaths and refusing the root makes that mistake unrepresentable: worker code physically cannot see `startServer`, and main code physically cannot see `workerReady`.

The refusal is enforced by the `exports` field in `package.json`. It is not an oversight and is not a backward-compat surface waiting to be filled in — do not "fix" it by adding a root `"."` entry. Consumers must import a subpath.

## The three subpaths

### `./main_thread`

Everything the main-thread entry file needs. Owns the event loop for connections, the load balancer, the txn manager, the hot-update coordinator, and worker spawning.

```ts
import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import '@dogsvr/cl-tsrpc';   // self-registers a CL factory

const cfg = dogsvr.loadMainThreadConfig('./main_thread_config.json');
dogsvr.startServer(cfg);
```

Only the process's initial entry file imports this subpath. Business handler code does not.

### `./worker_thread`

Everything a worker file needs. Handler registration, request/response plumbing, cross-CL and cross-CLC calls, per-thread config.

```ts
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    // one-time init
});

dogsvr.regCmdHandler(10001, async (reqMsg) => {
    const req = JSON.parse(reqMsg.body as string);
    return JSON.stringify({ res: `hello, ${req.name}` });
});
```

The `workerReady` callback is where you set up logger, DBs, and other resources — see [set up the logger](../how-to/setup_logger.md).

### `./common`

Runtime primitives that live in *both* thread contexts and are also useful to external packages. Currently exports only the SAB line-stream transport (`SabLineWriter`, `SabLineReader`, `makeLineSab`) — `@dogsvr/logger`'s `central` mode consumes it to ship NDJSON records from every worker to a central sink thread.

```ts
import { SabLineWriter, SabLineReader, makeLineSab } from '@dogsvr/dogsvr/common';
```

Not everything under `src/common/` is exported through this subpath. The subpath is the **public** slice; the rest is internal. The full source-side discipline for what belongs where is in [common directory discipline](common_directory_discipline.md); the transport layering rationale is in [SAB transport layers](sab_transport_layers.md).

Adding an export to `./common` is a versioned commitment — treat it the same as adding a public API on the other subpaths.

## Resolver compatibility

`@dogsvr/dogsvr` is authored to resolve correctly under **every JavaScript module resolver** — modern (`exports`-aware) and legacy alike. Consumers do not need to configure anything.

### Why two mechanisms

The `exports` field in `package.json` is the authoritative map for modern resolvers. But TypeScript's default `moduleResolution: node` (still common in downstream projects) does **not** read `exports`. To stay compatible without asking every consumer to switch resolvers, the package also ships stub `package.json` files at each subpath.

### Resolver matrix

| Resolver | Reads `exports`? | Reads stub `package.json`? | Result |
|---|:-:|:-:|---|
| Node.js (modern) | ✓ | — | Hits `dist/…` via `exports` |
| Node.js (legacy, pre-exports) | ✗ | ✓ | Hits `dist/…` via stub's `main` |
| TypeScript `moduleResolution: bundler` / `node16` / `nodenext` | ✓ | — | Hits `dist/….d.ts` via `exports.types` |
| TypeScript `moduleResolution: node` (TS default) | ✗ | ✓ | Hits `dist/….d.ts` via stub's `types` |
| Webpack / Rollup / Vite / Parcel / esbuild (modern) | ✓ | — | Hits `dist/…` via `exports` |
| Webpack 4 and other legacy bundlers | ✗ | ✓ | Hits `dist/…` via stub's `main` |

Exactly one mechanism resolves each import — the two never fight.

### Published layout

```
@dogsvr/dogsvr/
├── main_thread/
│   └── package.json        # stub: { "main": "../dist/main_thread/index.js", "types": "../dist/main_thread/index.d.ts" }
├── worker_thread/
│   └── package.json        # stub: { "main": "../dist/worker_thread/index.js", "types": "../dist/worker_thread/index.d.ts" }
├── common/
│   └── package.json        # stub: { "main": "../dist/common/index.js", "types": "../dist/common/index.d.ts" }
├── dist/
│   ├── main_thread/index.{js,d.ts}
│   ├── worker_thread/index.{js,d.ts}
│   └── common/index.{js,d.ts}
└── package.json            # "exports" map for modern resolvers
```

## The single-sided rule

> A single `.ts` source file must not value-import both `@dogsvr/dogsvr/main_thread` and `@dogsvr/dogsvr/worker_thread` (same for `@dogsvr/logger`).

Type-only imports (`import type { X } from '...'`, `import { type X } from '...'`) are fine — `tsc` erases them and the emitted `.js` never `require`s the module. Mixing values and types counts as a value import: the whole subpath gets required once.

### What goes wrong when you break it

Both subpaths' `logger.ts` share the same `common/logger_proxy.ts` refreshers array. When `setupLogger` (main) or `setupLoggerInWorker` (worker) fires `onImplSwap`, the proxy walks every registered refresher — including the one belonging to the *other* side. That other side never had a real logger registered, so its `rootLog` proxy emits a spurious `DogsvrLoggerWarning: logger plugin not registered`.

Node worker threads have independent module caches, so this misfires **inside the worker** too: any file that value-imports both subpaths gets pulled into worker module space, wires up both proxies, and the warning cascade repeats there.

If you see the "not registered" warning more than once with a well-configured logger, the first suspect is a file that imports both subpaths — not pm2 forking. (pm2's `exec_mode: 'fork'` starts one Node process; the doubled load comes from Node's per-worker module cache.)

### How to structure shared setup wiring

For code that legitimately needs to wire up the same subsystem on both sides — OpenTelemetry setup, metric sinks, span exporters — do **not** collapse it into one file that imports both subpaths. Instead, split three ways:

```
src/shared/
├── otel_shared.ts     # types + pure functions; no dogsvr subpath imports
├── otel_main.ts       # value-imports '@dogsvr/dogsvr/main_thread'
└── otel_worker.ts     # value-imports '@dogsvr/dogsvr/worker_thread'
```

`otel_main.ts` and `otel_worker.ts` are each single-sided. Each is imported only by the corresponding entry file (`server.ts` or `worker.ts`).

When the shared layer needs to reach into side-effectful APIs (`setSpanSink`, `setMetricSink`), use **setter injection**: `otel_shared.ts` declares a function like `setupOtelTracing(opts, setSpanSinkFn)` that takes the setter as a parameter, and each side's wrapper passes its own side's setter in. `example-proj/src/shared/otel_tracing.ts` is the reference implementation.

### Verifying compliance

After a build, grep the emitted `dist/` for any `.js` that requires both subpaths of the same package:

```sh
cd example-proj
for f in $(find dist -name '*.js'); do
    if grep -q "@dogsvr/dogsvr/main_thread" "$f" && grep -q "@dogsvr/dogsvr/worker_thread" "$f"; then
        echo "VIOLATION: $f"
    fi
done
```

Expected output: nothing. Same check with `@dogsvr/logger`.

## References

- [Common directory discipline](common_directory_discipline.md) — source-side rule for `src/common/` (dual-subpath packages)
- [SAB transport layers](sab_transport_layers.md) — what's behind the `./common` subpath's current export set
- [Set up the logger](../how-to/setup_logger.md) — practical wiring that respects the single-sided rule
