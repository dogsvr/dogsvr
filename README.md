# @dogsvr/dogsvr

Node.js game server framework built around a **main thread + worker thread** model: the main thread owns connections and routes messages, worker threads run business logic in parallel. Worker code is **hot-updatable**; connection layers are **pluggable**; message serialization is whatever you want (`Uint8Array` or `string`).

This package is the **entry point of the dogsvr polyrepo** — if you're new here, start with this README for the framework, then walk through [`example-proj`](https://github.com/dogsvr/example-proj) for a runnable three-server reference.

## Ecosystem — the dogsvr polyrepo

The dogsvr stack is intentionally split into small, independently versioned git repos. Each repo publishes at most one or two npm packages; no monorepo, no workspaces.

| Repo / package | Role |
|---|---|
| [`@dogsvr/dogsvr`](https://github.com/dogsvr/dogsvr) | **Framework core** — main thread, worker threads, load balancer, hot update, txn mgr |
| [`@dogsvr/cl-tsrpc`](https://github.com/dogsvr/cl-tsrpc) | TSRPC connection layer (WebSocket / HTTP) with per-connection auth + identity binding (`openId` / `zoneId` / `gid`) |
| [`@dogsvr/cl-grpc`](https://github.com/dogsvr/cl-grpc) | gRPC connection layer for server-to-server unary calls |
| [`@dogsvr/cfg-luban`](https://github.com/dogsvr/cfg-luban) | Runtime for reading Luban-generated game config — data lives in LMDB (mmap'd, outside the V8 heap), so all worker threads in the process share one pagecache-resident copy, and multiple Node processes on the same host share it via the OS pagecache too. FlatBuffers provides offset-based random access, so no upfront parse and no GC pressure from config tables |
| [`@dogsvr/cfg-luban-cli`](https://github.com/dogsvr/cfg-luban-cli) | Codegen CLI: Excel → FlatBuffers → LMDB pipeline |
| [`example-proj`](https://github.com/dogsvr/example-proj) | **Reference integration** — three servers (dir / zonesvr / battlesvr), Redis + MongoDB, Colyseus rooms |
| [`example-proj-cfg`](https://github.com/dogsvr/example-proj-cfg) | Reference business config repo that feeds `cfg-luban-cli` |
| [`example-proj-client`](https://github.com/dogsvr/example-proj-client) | Reference Phaser 3 web client for `example-proj` |

You pick which `@dogsvr/cl-*` packages to install; you pick whether to use `@dogsvr/cfg-luban`; the framework core only requires one of them to be imported at startup to self-register a CL factory. See [Architecture](#architecture) below for how they fit together at runtime.

## Features

- **Multi-thread via Node `worker_threads`** — main thread runs one event loop for connections; N worker threads run business handlers. Messages between them are routed by a pluggable load-balancer (round-robin, random, least-load, consistent-hash by `gid`).
- **Pluggable connection layers (CL)** — import any `@dogsvr/cl-*` package to self-register a factory; main thread wires inbound/outbound connections from JSON config. Roll your own CL by extending `BaseCL` / `BaseCLC`.
- **No serialization opinions** — `Msg.body` is `Uint8Array | string`. Protobuf, JSON, MsgPack, FlatBuffers — it's your call.
- **Hot update of worker logic** — drain in-flight txns and replace workers without dropping connections. Two strategies: `rolling` (one at a time, default) or `allAtOnce` (all new, then drain old). Triggered via pm2 `tx2` action.

## Requirements

**Node.js**: tested on **v16.15.1 on Linux (x86-64)**. Newer LTS versions (18 / 20 / 22) are expected to work but are not routinely exercised; older versions may not. File an issue if something breaks on your runtime.

## Install

```sh
npm install @dogsvr/dogsvr
npm install @dogsvr/cl-tsrpc   # pick your connection layer(s)
npm install @dogsvr/cl-grpc    # or gRPC, or both
```

> The `@dogsvr/dogsvr` package exposes two **subpath** imports only — there is no root entry. See [import paths](#import-paths) below.

## Quick start

Minimum two files: one that boots the main thread, one that runs in each worker.

### `server.ts` (main thread entry)

```ts
import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import '@dogsvr/cl-tsrpc';  // self-registers "tsrpc" CL factory
import * as path from 'node:path';

await dogsvr.startServer({
    workerThreadRunFile: path.resolve(__dirname, 'worker.js'),
    workerThreadNum: 2,
    cl:  { "tsrpc":  { "type": "tsrpc", "svrType": "ws", "port": 20000 } },
    clc: {},
    lbStrategy: { strategy: 'roundRobin' },
    hotUpdateStrategy: { strategy: 'rolling' },
});
```

Or point to a JSON config file — the shape mirrors the `SvrConfig` object above (`workerThreadRunFile`, `workerThreadNum`, `cl`, `clc`, `lbStrategy`, `hotUpdateStrategy`, optional `workerConfigPath` / `logLevel` / `hotUpdateTimeout`):

```ts
import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import '@dogsvr/cl-tsrpc';
dogsvr.startServer(__dirname + '/main_thread_config.json');
```

### `worker.ts` (runs in each worker thread)

```ts
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';

dogsvr.workerReady(async () => {
    // one-time init: open DBs, load config, etc.
});

dogsvr.regCmdHandler(10001, async (reqMsg) => {
    const req = JSON.parse(reqMsg.body as string);
    if (!req.name) {
        // non-zero errCode path — framework sends an error response
        throw new dogsvr.HandlerError(1001, 'name is required');
    }
    // return a body (string | Uint8Array) and the framework responds for you
    return JSON.stringify({ res: `hello, ${req.name}` });

    // other valid returns:
    //   return { body: '...', head: { serverVersion: '1.2.3' } };   // with head patch
    //   return;                                                      // undefined → silent drop (no response)
});
```

`respondCmd` / `respondError` are still exported as escape hatches for advanced cases (e.g. responding to a request from a different async context), but the return-value / throw form above is the canonical handler shape.

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

Main-thread surface (`startServer`, `sendMsgToWorkerThread`, `hotUpdate`, `getConnLayer`, `BaseCL`, `BaseCLC`, `registerCLFactory`, `registerCLCFactory`, `loadMainThreadConfig`, `Msg`, log functions…) — see [`src/main_thread/index.ts`](src/main_thread/index.ts).

Worker-thread surface (`workerReady`, `regCmdHandler`, `respondCmd`, `respondError`, `callCmdByClc`, `pushMsgByCl`, `loadWorkerThreadConfig`, `getThreadConfig<T>`, `Msg`, log functions…) — see [`src/worker_thread/index.ts`](src/worker_thread/index.ts).

## Architecture

![architecture diagram](https://github.com/user-attachments/assets/8903ee30-36c6-4922-a5d9-5a0715c1ded4)

- **Main thread** (`src/main_thread/`) owns the event loop for connections and dispatches messages to workers by command ID + routing fields (`gid` for consistent-hash LB).
- **Worker threads** (`src/worker_thread/`) run your registered handlers. Workers never talk directly — cross-worker comms go through CLC callbacks routed by main.
- **Messages** (`src/message.ts`): `Msg { head: MsgHeadType, body: MsgBodyType }`. Head carries `cmdId`, routing fields (`openId`/`zoneId`/`gid`), txn id, direction flags (`clcOptions` / `clOptions`), and error info. Body is raw bytes or string.

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
