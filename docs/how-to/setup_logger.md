# Set up the logger

`@dogsvr/dogsvr` defines the logger contract (`Log`, `LoggerImpl`, `LoggerHub`, `Level`) and exposes a `log` proxy from both subpaths, but ships only a console-based fallback. Without a registered plugin, `log.*` calls print human-readable lines and emit a one-time `process.emitWarning`.

For NDJSON output, install [`@dogsvr/logger`](https://github.com/dogsvr/logger) and wire it once at startup.

## Main thread

```ts
import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { setupLogger } from '@dogsvr/logger/main_thread';

const cfg = dogsvr.loadMainThreadConfig(...);
setupLogger({ ...cfg.log, base: { svrId: 'mysvr' } });
dogsvr.startServer(cfg);
```

`setupLogger()` must run **before** `startServer()` — spawning workers before the logger is set up throws rather than silently misrouting log lines.

## Worker thread

```ts
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

The main thread passes a `MessagePort` to each worker via `workerData.loggerInit` automatically — spread it as shown.

## Config plumbing

The `log` key in your JSON configs is a **business field** — the framework core does not read it. Add it to your typed config interface and pull it out with `getMainThreadConfig<T>()` / `getThreadConfig<T>()`.

## Using a different backend

Skip `@dogsvr/logger` and call `registerLogger(hub)` (main) / `registerWorkerLogger(impl)` (worker) yourself with your own `LoggerImpl`. Each `register*` is one-shot — calling twice throws.
