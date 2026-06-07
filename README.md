# @dogsvr/dogsvr

Node.js game server framework built around a **main thread + worker thread** model: the main thread owns connections and routes messages, worker threads run business logic in parallel. Worker code is **hot-updatable**; connection layers are **pluggable**; message serialization is whatever you want (`Uint8Array` or `string`).

This package is the **entry point of the dogsvr polyrepo** — if you're new here, start with this README for the framework, then walk through [`example-proj`](https://github.com/dogsvr/example-proj) for a runnable three-server reference.

## Ecosystem — the dogsvr polyrepo

The dogsvr stack is intentionally split into small, independently versioned git repos. Each repo publishes at most one or two npm packages; no monorepo, no workspaces.

| Repo / package | Role |
|---|---|
| [`@dogsvr/dogsvr`](https://github.com/dogsvr/dogsvr) | **Framework core** — main thread, worker threads, load balancer, hot update, txn mgr, logger interface |
| [`@dogsvr/logger`](https://github.com/dogsvr/logger) | Default pino-based NDJSON logger plugin (inline / central modes); registers itself when imported |
| [`@dogsvr/cl-tsrpc`](https://github.com/dogsvr/cl-tsrpc) | TSRPC connection layer (WebSocket / HTTP) with per-connection auth + identity binding (`openId` / `zoneId` / `gid`) |
| [`@dogsvr/cl-grpc`](https://github.com/dogsvr/cl-grpc) | gRPC connection layer for server-to-server unary calls |
| [`@dogsvr/cfg-luban`](https://github.com/dogsvr/cfg-luban) | Runtime for reading Luban-generated game config — data lives in LMDB (mmap'd, outside the V8 heap), so all worker threads in the process share one pagecache-resident copy, and multiple Node processes on the same host share it via the OS pagecache too. FlatBuffers provides offset-based random access, so no upfront parse and no GC pressure from config tables |
| [`@dogsvr/cfg-luban-cli`](https://github.com/dogsvr/cfg-luban-cli) | Codegen CLI: Excel → FlatBuffers → LMDB pipeline |
| [`example-proj`](https://github.com/dogsvr/example-proj) | **Reference integration** — three servers (dir / zonesvr / battlesvr), Redis + MongoDB, Colyseus rooms |
| [`example-proj-cfg`](https://github.com/dogsvr/example-proj-cfg) | Reference business config repo that feeds `cfg-luban-cli` |
| [`example-proj-client`](https://github.com/dogsvr/example-proj-client) | Reference Phaser 4 web client for `example-proj` |

You pick which `@dogsvr/cl-*` packages to install; you pick whether to use `@dogsvr/cfg-luban`; you pick `@dogsvr/logger` (or supply your own `LoggerImpl`). The framework core only requires that any chosen plugin be imported at startup to self-register. See [Architecture](#architecture) below for how they fit together at runtime.

## Features

- **Multi-thread via Node `worker_threads`** — main thread runs one event loop for connections; N worker threads run business handlers. Messages between them are routed by a pluggable load-balancer (round-robin, random, least-load, consistent-hash by `gid`).
- **Pluggable connection layers (CL)** — import any `@dogsvr/cl-*` package to self-register a factory; main thread wires inbound/outbound connections from JSON config. Roll your own CL by extending `BaseCL` / `BaseCLC`.
- **Pluggable logger** — `log`, `LoggerImpl`, `LoggerHub`, `Level` are defined here; the implementation registers itself via `registerLogger()` (main) / `registerWorkerLogger()` (worker). Default plugin is [`@dogsvr/logger`](https://github.com/dogsvr/logger) (pino-based NDJSON, two modes); without a plugin a built-in console fallback prints human-readable lines and warns once.
- **No serialization opinions** — `Msg.body` is `Uint8Array | string`. Protobuf, JSON, MsgPack, FlatBuffers — it's your call.
- **Hot update of worker logic** — drain in-flight txns and replace workers without dropping connections. Two strategies: `rolling` (one at a time, default) or `allAtOnce` (all new, then drain old). Triggered via `pm2 trigger <name> hotUpdate` over the native pm2 IPC channel (no `tx2` dependency).

## Requirements

**Node.js**: tested on **v24.13.0 on Linux (x86-64)**; other maintained LTS lines are expected to work but are not routinely exercised. File an issue if something breaks on your runtime.

## Install

```sh
npm install @dogsvr/dogsvr
npm install @dogsvr/logger     # NDJSON output via pino (recommended)
npm install @dogsvr/cl-tsrpc   # pick your connection layer(s)
npm install @dogsvr/cl-grpc    # or gRPC, or both
```

> The `@dogsvr/dogsvr` package exposes two **subpath** imports only — there is no root entry. See [import paths](#import-paths) below.

## Quick start

Minimum two files: one that boots the main thread, one that runs in each worker.

### `server.ts` (main thread entry)

```ts
import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { setupLogger } from '@dogsvr/logger/main_thread';
import '@dogsvr/cl-tsrpc';  // self-registers "tsrpc" CL factory
import * as path from 'node:path';

const cfg = dogsvr.loadMainThreadConfig(path.resolve(__dirname, 'main_thread_config.json'));
setupLogger({ mode: 'inline', level: 'info' });  // read from cfg.log in practice; see Logger section
dogsvr.startServer(cfg);
```

`main_thread_config.json` shape (mirrors `SvrConfig` + any business fields you read via `getMainThreadConfig<MyTypedConfig>()`):

```json
{
    "workerThreadRunFile": "./worker.js",
    "workerThreadNum": 2,
    "log": { "mode": "inline", "level": "info" },
    "cl":  { "tsrpc": { "type": "tsrpc", "svrType": "ws", "port": 20000 } },
    "clc": {}
}
```

Values like `workerThreadNum`, `port`, `mode`, and `level` are illustrative — tune them for your deployment.

Optional fields: `lbStrategy`, `hotUpdateStrategy`, `workerConfigPath`, `hotUpdateTimeout`.

You can also pass a `SvrConfig` object directly to `startServer()` if you prefer programmatic setup.

### `worker.ts` (runs in each worker thread)

```ts
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    // one-time init: set up logger, open DBs, etc.
    // See Logger section below for setupLoggerInWorker() wiring.
});

dogsvr.regCmdHandler(10001, async (reqMsg) => {
    const req = JSON.parse(reqMsg.body as string);
    if (!req.name) {
        throw new dogsvr.HandlerError(1001, 'name is required');
    }
    return JSON.stringify({ res: `hello, ${req.name}` });

    // other valid returns:
    //   return { body: '...', head: { serverVersion: '1.2.3' } };   // with head patch
    //   return;                                                      // undefined → silent drop
});
```

`respondCmd` / `respondError` are still exported as escape hatches for responding from a different async context, but the return-value / throw form above is the canonical handler shape.

### Run

```sh
pm2 start dist/server.js
pm2 trigger dist/server hotUpdate    # redeploy worker.js without dropping conns
```

For a complete, runnable example with three servers, Redis/MongoDB integration, and room-based battles, see [`example-proj`](https://github.com/dogsvr/example-proj).

## Import paths

`@dogsvr/dogsvr` exposes **two subpaths** and no root:

```ts
import * as dogsvr from '@dogsvr/dogsvr/main_thread';    // main-thread APIs
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';  // worker-thread APIs
```

Attempting `require('@dogsvr/dogsvr')` returns `ERR_PACKAGE_PATH_NOT_EXPORTED` — this is **intentional**, so that code running in a worker can never accidentally pull in `startServer` (which would recursively spawn more workers).

Main-thread surface (`startServer`, `sendMsgToWorkerThread`, `hotUpdate`, `getConnLayer`, `BaseCL`, `BaseCLC`, `registerCLFactory`, `registerCLCFactory`, `loadMainThreadConfig`, `getMainThreadConfig`, `log`, `registerLogger`, `Msg`, …) — see [`src/main_thread/index.ts`](src/main_thread/index.ts).

Worker-thread surface (`workerReady`, `regCmdHandler`, `respondCmd`, `respondError`, `callCmdByClc`, `pushMsgByCl`, `loadWorkerThreadConfig`, `getThreadConfig<T>`, `log`, `registerWorkerLogger`, `Msg`, …) — see [`src/worker_thread/index.ts`](src/worker_thread/index.ts).

## Architecture

![architecture diagram](https://github.com/user-attachments/assets/8903ee30-36c6-4922-a5d9-5a0715c1ded4)

- **Main thread** owns the event loop for connections and dispatches messages to workers by command ID + routing fields (`gid` for consistent-hash LB).
- **Worker threads** run your registered handlers. Workers never talk directly — cross-worker comms go through CLC callbacks routed by main.
- **Messages** (`Msg`): `head` carries `cmdId`, routing fields, txn id, direction flags (`clcOptions` / `clOptions`), and error info; `body` is raw bytes or string.

## Logger

`@dogsvr/dogsvr` defines the logger contract (`Log`, `LoggerImpl`, `LoggerHub`, `Level`) and exposes a `log` proxy from both subpaths — but ships only a console-based fallback. To get NDJSON output, install [`@dogsvr/logger`](https://github.com/dogsvr/logger) and call `setupLogger()` / `setupLoggerInWorker()` once at startup:

```ts
// main thread entry
import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { setupLogger } from '@dogsvr/logger/main_thread';

const cfg = dogsvr.loadMainThreadConfig(...);
setupLogger({ ...cfg.log, base: { svrId: 'mysvr' } });
dogsvr.startServer(cfg);
```

```ts
// worker thread entry
import { workerData } from 'node:worker_threads';
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import { setupLoggerInWorker, type WorkerInitPayload } from '@dogsvr/logger/worker_thread';

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    const cfg = dogsvr.getThreadConfig<{ log: { level: dogsvr.Level } }>();
    setupLoggerInWorker({
        ...(workerData as { loggerInit: WorkerInitPayload }).loggerInit,
        level: cfg.log.level,
        base: { svrId: 'mysvr' },
    });
});
```

The main thread passes a `MessagePort` to each worker via `workerData.loggerInit` automatically — you just spread it. The `log` config key in your JSON configs is a business field (not read by the framework core); add it to your typed config interface and read it with `getMainThreadConfig<T>()` / `getThreadConfig<T>()` as shown above.

To use a different backend, skip `@dogsvr/logger` and call `registerLogger(hub)` (main) / `registerWorkerLogger(impl)` (worker) yourself with your own `LoggerImpl`. Each `register*` is one-shot — calling twice throws.

If no plugin registers, `log.*` calls fall back to the console logger, which emits a one-time `process.emitWarning`. Spawning workers before `setupLogger()` throws rather than silently misrouting log lines.

## Package resolution compatibility

`@dogsvr/dogsvr` is authored to resolve correctly under **every JavaScript module resolver**. Modern resolvers read the `exports` field; older ones fall back to stub `package.json` files under `main_thread/` and `worker_thread/`:

| Resolver | Reads `exports`? | Reads stub `package.json`? | Result |
|---|:-:|:-:|---|
| Node.js (modern) | ✓ | — | Hits `dist/…` via `exports` |
| Node.js (legacy, pre-exports) | ✗ | ✓ | Hits `dist/…` via stub's `main` |
| TypeScript `moduleResolution: bundler` / `node16` / `nodenext` | ✓ | — | Hits `dist/….d.ts` via `exports.types` |
| TypeScript `moduleResolution: node` (TS default) | ✗ | ✓ | Hits `dist/….d.ts` via stub's `types` |
| Webpack / Rollup / Vite / Parcel / esbuild (modern) | ✓ | — | Hits `dist/…` via `exports` |
| Webpack 4 and other legacy bundlers | ✗ | ✓ | Hits `dist/…` via stub's `main` |

In every case, exactly one of the two mechanisms resolves the import — nothing to configure on the consumer side.

### Published layout

```
@dogsvr/dogsvr/
├── main_thread/
│   └── package.json        # stub: { "main": "../dist/main_thread/index.js", "types": "../dist/main_thread/index.d.ts" }
├── worker_thread/
│   └── package.json        # stub: { "main": "../dist/worker_thread/index.js", "types": "../dist/worker_thread/index.d.ts" }
├── dist/
│   ├── main_thread/index.{js,d.ts}
│   └── worker_thread/index.{js,d.ts}
└── package.json            # "exports" map for modern resolvers
```

## License

MIT — see [LICENSE](LICENSE).
