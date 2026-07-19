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

`@dogsvr/dogsvr` exposes **three subpaths** and no root:

```ts
import * as dogsvr from '@dogsvr/dogsvr/main_thread';    // main-thread APIs
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';  // worker-thread APIs
import { SabLineWriter } from '@dogsvr/dogsvr/common';   // SAB line-stream transport (for external plugins)
```

Attempting `require('@dogsvr/dogsvr')` returns `ERR_PACKAGE_PATH_NOT_EXPORTED` — this is **intentional**, so that code running in a worker can never accidentally pull in `startServer` (which would recursively spawn more workers).

Full surface lists live in the barrel files: [`src/main_thread/index.ts`](src/main_thread/index.ts), [`src/worker_thread/index.ts`](src/worker_thread/index.ts), [`src/common/index.ts`](src/common/index.ts). For the design rationale (why no root, the single-sided rule, resolver compatibility), see [`docs/explanation/subpaths.md`](docs/explanation/subpaths.md).

## Architecture

![architecture diagram](https://github.com/user-attachments/assets/8903ee30-36c6-4922-a5d9-5a0715c1ded4)

- **Main thread** owns the event loop for connections and dispatches messages to workers by command ID + routing fields (`gid` for consistent-hash LB).
- **Worker threads** run your registered handlers. Workers never talk directly — cross-worker comms go through CLC callbacks routed by main.
- **Messages** (`Msg`): `head` carries `cmdId`, routing fields, txn id, direction flags (`clcOptions` / `clOptions`), and error info; `body` is raw bytes or string.

## Logger

The framework defines the logger contract (`Log`, `LoggerImpl`, `LoggerHub`, `Level`) and exposes a `log` proxy from both subpaths, but ships only a console-based fallback. For NDJSON output install [`@dogsvr/logger`](https://github.com/dogsvr/logger) and wire it once at startup; to plug in a different backend call `registerLogger()` / `registerWorkerLogger()` with your own `LoggerImpl`.

See [`docs/how-to/setup_logger.md`](docs/how-to/setup_logger.md) for the full wiring.

## More

- [Set up the logger](docs/how-to/setup_logger.md) — NDJSON output, worker wiring, alternative backends
- [Subpaths](docs/explanation/subpaths.md) — three-subpath design, resolver compatibility, the single-sided rule, why no root
- [SAB transport layers](docs/explanation/sab_transport_layers.md) — three-layer split (ring / line / msg), subpath exposure rule, hot-path invariants, hot-update drain trap
- [`src/common/` directory discipline](docs/explanation/common_directory_discipline.md) — what belongs in `common/`, auditing recipe, paired-strategy reshaping

Related repos in the dogsvr ecosystem:

- Logger plugin: [`@dogsvr/logger`](https://github.com/dogsvr/logger)
- Connection layers: [`@dogsvr/cl-tsrpc`](https://github.com/dogsvr/cl-tsrpc) · [`@dogsvr/cl-grpc`](https://github.com/dogsvr/cl-grpc)
- Config pipeline: [`@dogsvr/cfg-luban`](https://github.com/dogsvr/cfg-luban) · [`@dogsvr/cfg-luban-cli`](https://github.com/dogsvr/cfg-luban-cli)
- Reference integration: [`example-proj`](https://github.com/dogsvr/example-proj) · [`example-proj-cfg`](https://github.com/dogsvr/example-proj-cfg) · [`example-proj-client`](https://github.com/dogsvr/example-proj-client)

## License

MIT — see [LICENSE](LICENSE).
