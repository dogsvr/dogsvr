# @dogsvr/dogsvr

Node.js game server framework built around a **main thread + worker thread** model: the main thread owns connections and routes messages, worker threads run business logic in parallel. Worker code is **hot-updatable**; connection layers are **pluggable**; message serialization is whatever you want (`Uint8Array` or `string`).

Part of the dogsvr polyrepo. Sibling packages ship separately:

| Package | Purpose |
|---|---|
| [`@dogsvr/cl-tsrpc`](https://github.com/dogsvr/cl-tsrpc) | TSRPC connection layer (WebSocket / HTTP); also does per-conn auth + identity binding |
| [`@dogsvr/cl-grpc`](https://github.com/dogsvr/cl-grpc) | gRPC connection layer for server-to-server calls |
| [`@dogsvr/cfg-luban`](https://github.com/dogsvr/cfg-luban) | Runtime for reading Luban-generated game config (LMDB + FlatBuffers) |
| [`@dogsvr/cfg-luban-cli`](https://github.com/dogsvr/cfg-luban-cli) | Codegen CLI for the above |

See [`example-proj`](https://github.com/dogsvr/example-proj) for a three-server reference integration (dir / zonesvr / battlesvr).

## Features

- **Multi-thread via Node `worker_threads`** — main thread runs one event loop for connections; N worker threads run business handlers. Messages between them are routed by a pluggable load-balancer (round-robin, random, least-load, consistent-hash by `gid`).
- **Pluggable connection layers (CL)** — import any `@dogsvr/cl-*` package to self-register a factory; main thread wires inbound/outbound connections from JSON config. Roll your own CL by extending `BaseCL` / `BaseCLC`.
- **No serialization opinions** — `Msg.body` is `Uint8Array | string`. Protobuf, JSON, MsgPack, FlatBuffers — it's your call.
- **Hot update of worker logic** — drain in-flight txns and replace workers without dropping connections. Two strategies: `rolling` (one at a time, default) or `allAtOnce` (all new, then drain old). Triggered via pm2 `tx2` action.
- **Request/response correlation built in** — `TxnMgr` tracks in-flight requests across the thread boundary with automatic 5s timeout (configurable).
- **JSON-driven startup** — instead of hand-wiring a `SvrConfig` object, point `startServer()` at a config file path.

## Requirements

- Node.js **≥ 12.17** (needs `worker_threads` + `exports` field support)
- TypeScript **any version** works — package ships types for both modern (`node16`/`bundler`) and legacy (`node`) module resolution (see [package resolution compatibility](#package-resolution-compatibility))

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

dogsvr.regCmdHandler(10001, async (reqMsg: dogsvr.Msg, body: dogsvr.MsgBodyType) => {
    const req = JSON.parse(body as string);
    dogsvr.respondCmd(reqMsg, JSON.stringify({ res: 'I am dog' }));
});
```

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

```
     Client
       │
       ▼
   ┌───────────────┐       (pluggable CL: @dogsvr/cl-tsrpc, cl-grpc, or your own)
   │ Main thread   │
   │  - CL inbound │
   │  - CLC out    │       (to other servers)
   │  - routing    │
   │  - LB select  │
   │  - hotUpdate  │
   └───────┬───────┘
           │  postMessage(Msg)       (load-balanced)
   ┌───────┴───────┬──────────┬──────────┐
   ▼               ▼          ▼          ▼
  Worker 0      Worker 1    Worker 2    Worker N-1
  (regCmdHandler + respondCmd / callCmdByClc / pushMsgByCl)
```

- **Main thread** (`src/main_thread/`) owns the event loop for connections and dispatches messages to workers by command ID + routing fields (`gid` for consistent-hash LB).
- **Worker threads** (`src/worker_thread/`) run your registered handlers. Workers never talk directly — cross-worker comms go through CLC callbacks routed by main.
- **Messages** (`src/message.ts`): `Msg { head: MsgHeadType, body: MsgBodyType }`. Head carries `cmdId`, routing fields (`openId`/`zoneId`/`gid`), txn id, direction flags (`clcOptions` / `clOptions`), and error info. Body is raw bytes or string.

![architecture diagram](https://github.com/user-attachments/assets/8903ee30-36c6-4922-a5d9-5a0715c1ded4)

## Package resolution compatibility

`@dogsvr/dogsvr` is authored to resolve correctly under **every JavaScript module resolver**. Modern resolvers read the `exports` field; older ones fall back to stub `package.json` files under `main_thread/` and `worker_thread/`:

| Resolver | Reads `exports`? | Reads stub `package.json`? | Result |
|---|:-:|:-:|---|
| Node.js 12.17+ | ✓ | — | Hits `dist/…` via `exports` |
| Node.js < 12.17 (legacy) | ✗ | ✓ | Hits `dist/…` via stub's `main` |
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
