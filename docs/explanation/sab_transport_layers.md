# SAB transport layers

dogsvr routes messages between the main thread and worker threads over `SharedArrayBuffer`-backed SPSC ring buffers. The transport is split into three layers plus a thin per-thread wrapper. This note explains the layering, what each layer exposes, and the constraints future contributors must preserve.

## Why three layers

Two independent encodings share the same SPSC ring machinery:

- **Line stream** — length-prefixed UTF-8 lines, used by the logger's `central` strategy to ship NDJSON records from every worker to a central sink thread.
- **Message frames** — dogsvr's own `Msg` (`head` JSON + `body` bytes-or-string) between the main thread and each business worker.

Before the 2026-07 refactor there were two nearly-identical SPSC copies (`msg_sab_shared.ts` in dogsvr, `sab_shared.ts` in logger). Splitting the SPSC primitive out of the framing lets both encodings reuse one seqlock / `waitAsync` implementation and keeps future encodings (metric ring, RPC frame ring, …) from repeating the pattern a third time.

## Layer map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  L3  Wrappers & consumers (thread-aware glue, fallback stats, hot-update)   │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│   dogsvr internal (relative import)  │  @dogsvr/logger (external plugin)    │
│   ─────────────────────────────────  │  ──────────────────────────────────  │
│   main_thread/sab_msg_channel.ts     │  strategies/central/sab_writer.ts    │
│   worker_thread/sab_msg_channel.ts   │  strategies/central/sab_reader.ts    │
│           │                          │           │                          │
│           │ SabMsgChannel            │           │ SabLine{Writer,Reader}   │
│           ▼                          │           ▼                          │
├──────────────────────────────────────┼─────────────────────────────────────┤
│  L2  Framing                         │                                     │
│  ─────────────                       │                                     │
│   common/sab_msg.ts                  │  common/sab_line.ts   ◄── exported  │
│   4B headLen · head JSON             │  4B len · utf-8 bytes     via       │
│   4B bodyLen (+ binary bit) · body   │                        @dogsvr/     │
│   (internal only — relative import)  │  (re-exported through  dogsvr/      │
│           │                          │   src/common/index.ts) common       │
│           └────────────┬─────────────┴──────────┘                          │
│                        │ both build on the same ring primitive             │
├────────────────────────▼───────────────────────────────────────────────────┤
│  L1  SPSC ring primitive                                                   │
│  ─────────────────────────                                                 │
│   common/sab_ring.ts                                                       │
│   SabRingView · state slots (seq/write/read) · readState · commitWrite /   │
│   commitRead · resetIndexes · Atomics.waitAsync availability shim          │
│   (private — never re-exported)                                            │
├────────────────────────────────────────────────────────────────────────────┤
│  Substrate: SharedArrayBuffer, one writer thread + one reader thread       │
└────────────────────────────────────────────────────────────────────────────┘
```

Reading the picture: L2 files each build **only** on L1 (never on each other); L3 wrappers/consumers each build on exactly one L2 file. The only edge that crosses out of dogsvr is `sab_line` re-exported through `@dogsvr/dogsvr/common` — everything else is a relative import inside the package.

| File | Layer | Exposed via |
|---|---|---|
| `src/common/sab_ring.ts` | SPSC ring primitive: state slots, `SabRingView`, `readState` / `commitWrite` / `commitRead` / `resetIndexes`, `asyncApi` shim | **Private.** Relative imports inside dogsvr only. |
| `src/common/sab_line.ts` | Line-stream framing (`SabLineWriter` / `SabLineReader` / `makeLineSab`). Frame = `4B len` + UTF-8 bytes. | Re-exported from `@dogsvr/dogsvr/common` — consumed by `@dogsvr/logger`. |
| `src/common/sab_msg.ts` | Msg framing (`SabMsgWriter` / `SabMsgReader` / `SabMsgChannel` / `makeMsgSab`). Frame = `4B headLen` + head JSON + `4B bodyLen(+binary bit)` + body. | **Internal to dogsvr.** Relative imports only. |
| `src/main_thread/sab_msg_channel.ts` | `MainSabMsgChannel` — `SabMsgChannel` + fallback stats + worker binding | Main-thread surface. |
| `src/worker_thread/sab_msg_channel.ts` | `WorkerSabMsgChannel` — `SabMsgChannel` + fallback stats | Worker-thread surface. |

## Subpath exposure rule

`src/common/index.ts` (the `@dogsvr/dogsvr/common` subpath) re-exports **only** `SabLineWriter` / `SabLineReader` / `makeLineSab`. Msg framing is not a public API — the framework, not the consumer, owns the main-worker channel. Adding an entry to `common/index.ts` is a versioned commitment; keep it to the minimum external surface.

When adding a new encoding:

1. Add `src/common/sab_<x>.ts` and build it on `sab_ring` primitives. **Never** re-implement seqlock or `waitAsync` in the encoding layer.
2. If the encoding is consumed by an external package (like `@dogsvr/logger` consumes `sab_line`), export it from `src/common/index.ts`. Otherwise keep it as a relative import.

## Wrapper layer (`MainSabMsgChannel` / `WorkerSabMsgChannel`)

The framework wraps `SabMsgChannel` on each side to add:

- Fallback stats (`sabHits` / `fallbackHits`) reported by `getStats()` for observability.
- Worker handle binding on the main side (`dispatch(msg, worker)` needs the sender).
- Hot-update dispatch swap: `setDispatch()` replaces the field that the fixed `SabMsgChannel.onMsg` closure calls, so a mid-batch swap during hot-update takes effect on the next message without stopping the reader loop. The old `SabMsgChannel.setOnMsg` API was removed — do not reintroduce it.

Constructor shape:

- Main: `(sabOut, sabIn, worker, dispatch)`
- Worker: `(sabOut, sabIn, dispatch)`

`sabOut` comes first on both sides, matching `SabMsgChannel`. `dispatch` is required at construction (aligned with the F4 decision — a channel without a handler is a bug, not a valid intermediate state).

`stop()` (not `close()`) is deliberate: it halts the reader loop but does **not** gate further `send()` calls. The name signals that half-promise; renaming to `close()` would falsely imply the writer is also fenced.

## Hot path constraints

The reader/writer sit on the fast path for every cross-thread message. The following invariants must hold — verify with a synthetic benchmark if you touch these files:

- **Zero per-frame allocation.** Constructors cache `bufView = Buffer.from(view.data.buffer, view.data.byteOffset, view.dataBytes)` and `dv = new DataView(...)` once. Hot paths use absolute offsets (`dv.setUint32(off, …)`, `bufView.toString('utf8', off, off + n)`), never `Buffer.from` / `slice` per message.
- **No per-tick closure allocation.** `Reader.loopBound: () => void` caches `() => this.loop()` in the constructor; every `setImmediate` receives `this.loopBound`. Do not pass a fresh arrow to `setImmediate`.
- **`readOut` is a reused instance field.** `{ msg, nextCursor }` lives on the reader and is repopulated per frame; a fresh object per frame would allocate on every message.
- **Dispatch reads `this.onMsg` per message.** The `pumpOnce` loop calls `this.onMsg(m)` directly rather than destructuring `onMsg` into a local, so that `setDispatch` mid-batch takes effect on the very next frame. This is a deliberate tradeoff of one extra property lookup per message against hot-update correctness.
- **`asyncApi` shim lives in one place.** The `Atomics.waitAsync` availability shim is declared once in `sab_ring.ts`; `sab_line` and `sab_msg` import it. Do not duplicate the shim.

## Hot-update drain semantics (the easy trap)

`SabMsgReader.pumpOnce` calls `commitRead` **outside** the `while` loop, once per batch. Consequence: reading `isSabDrained()` from inside a dispatch handler always sees `write > read` — the batch you are currently draining has not committed yet.

`hot_update.ts` handles this by scheduling `checkDrained` via `setImmediate` from the tail of each dispatch branch. `setImmediate` places the check at the end of the macrotask queue, after `pumpOnce` returns and `commitRead` has run.

**Every dispatch branch that can produce the last message of a hot-update session must schedule `checkDrained`** — currently `clc`, `cl`, and `response`. Miss one, and a hot-update whose tail message went through the un-scheduled branch will hang until `hotUpdateTimeout` (30s default) fires.

## References

- [Common directory discipline](common_directory_discipline.md) — `src/common/` holds only files genuinely imported from both sides. Single-sided files or paired families live under their own top-level subdir.
- [Subpaths](subpaths.md) — the three-subpath design and the single-sided rule that governs how the transport is exposed.
- Logger's strategy layout mirrors the same split rule (`strategies/{inline,central}/`) — see [`@dogsvr/logger`](https://github.com/dogsvr/logger).
