# SAB transport layers

dogsvr routes messages between the main thread and worker threads over `SharedArrayBuffer`-backed SPSC ring buffers. The transport is split into three layers plus a thin per-thread wrapper. This note explains the layering, what each layer exposes, and the constraints future contributors must preserve.

## Why three layers

Two independent encodings share the same SPSC ring machinery:

- **Line stream** — length-prefixed UTF-8 lines, used by the logger's `central` strategy to ship NDJSON records from every worker to a central sink thread.
- **Message frames** — dogsvr's own `Msg` (`head` JSON + `body` bytes-or-string) between the main thread and each business worker.

Before the 2026-07 refactor there were two nearly-identical SPSC copies. Splitting the SPSC primitive out of the framing lets both encodings reuse one ring / park-loop implementation and keeps future encodings (metric ring, RPC frame ring, …) from repeating the pattern a third time.

## Layer map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  L3  Wrappers & consumers (thread-aware glue, fallback stats, hot-update)   │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│   dogsvr internal (relative import)  │  @dogsvr/logger (external plugin)    │
│   ─────────────────────────────────  │  ──────────────────────────────────  │
│   common/sab_channel.ts  MsgChannel  │  strategies/central/sab_writer.ts    │
│   (re-exported by both thread dirs)  │  strategies/central/isolate_entry.ts │
│           │                          │           │                          │
│           │ SabMsgChannel            │           │ SabLine{Writer,Reader}   │
│           ▼                          │           ▼                          │
├──────────────────────────────────────┼─────────────────────────────────────┤
│  L2  Framing                         │                                     │
│  ─────────────                       │                                     │
│   common/sab_msg.ts                  │  common/sab_line.ts   ◄── exported  │
│   fixed binary head + ext JSON       │  8B hdr (len·level)       via       │
│   (internal only — relative import)  │  · utf-8 bytes         @dogsvr/     │
│           │                          │  (re-exported through  dogsvr/      │
│           │                          │   src/common/index.ts) common       │
│           └────────────┬─────────────┴──────────┘                          │
│                        │ both build on the same ring + pump                │
├────────────────────────▼───────────────────────────────────────────────────┤
│  L1  SPSC ring primitive + park loop                                       │
│  ────────────────────────────────────                                      │
│   common/sab_ring.ts   classic power-of-2 ring, free-running cursors,      │
│                        padding record on wrap, claim/commit, CSTATE        │
│   common/sab_pump.ts   the single park/wake loop (Dekker handshake)        │
│   (private — never re-exported)                                            │
├────────────────────────────────────────────────────────────────────────────┤
│  Substrate: SharedArrayBuffer, one writer thread + one reader thread       │
└────────────────────────────────────────────────────────────────────────────┘
```

Reading the picture: L2 files each build **only** on L1 (never on each other); L3 wrappers/consumers each build on exactly one L2 file. The only edge that crosses out of dogsvr is `sab_line` re-exported through `@dogsvr/dogsvr/common` — everything else is a relative import inside the package.

| File | Layer | Exposed via |
|---|---|---|
| `src/common/sab_ring.ts` | SPSC ring primitive: `TAIL` / `HEAD` / `CSTATE` slots, `SabRingWriter.claim` / `commit`, `SabRingReader.drain`, power-of-2 guard, `waitAsync` shim | **Private.** Relative imports inside dogsvr only. |
| `src/common/sab_pump.ts` | The one park/wake loop (`SabPump`), `park` and `poll` modes, Dekker notify elision | **Private.** Relative imports inside dogsvr only. |
| `src/common/sab_line.ts` | Line-stream framing (`SabLineWriter` / `SabLineReader` / `makeLineSab`). Frame = `4B len` + `4B level` + UTF-8 bytes; the reader hands out `(buf, off, len, level)` slices. | Re-exported from `@dogsvr/dogsvr/common` — consumed by `@dogsvr/logger`. |
| `src/common/sab_msg.ts` | Msg framing (`SabMsgWriter` / `SabMsgReader` / `SabMsgChannel` / `makeMsgSab`). Frame = fixed binary head (gid f64, cmdId/txnId/zoneId u32, errCode i32, two u16 lengths) + openId + traceparent + optional ext JSON + body. | **Internal to dogsvr.** Relative imports only. |
| `src/common/sab_channel.ts` | `MsgChannel<TPeer>` — `SabMsgChannel` + fallback stats; the peer handle is the only per-side difference | **Internal.** Re-exported by both thread dirs. |
| `src/main_thread/sab_msg_channel.ts` | `MainSabMsgChannel = MsgChannel<Worker>` | Main-thread surface. |
| `src/worker_thread/sab_msg_channel.ts` | `WorkerSabMsgChannel = MsgChannel<void>` | Worker-thread surface. |

## Subpath exposure rule

`src/common/index.ts` (the `@dogsvr/dogsvr/common` subpath) re-exports **only** `SabLineWriter` / `SabLineReader` / `makeLineSab`. Msg framing is not a public API — the framework, not the consumer, owns the main-worker channel. Adding an entry to `common/index.ts` is a versioned commitment; keep it to the minimum external surface.

When adding a new encoding:

1. Add `src/common/sab_<x>.ts` and build it on `sab_ring` + `sab_pump`. **Never** re-implement the ring cursors or the park/wake handshake in the encoding layer — the Dekker sequence is the easiest place in this codebase to introduce a lost wakeup.
2. If the encoding is consumed by an external package (like `@dogsvr/logger` consumes `sab_line`), export it from `src/common/index.ts`. Otherwise keep it as a relative import.

## Wrapper layer (`MsgChannel`)

`common/sab_channel.ts` defines one `MsgChannel<TPeer>`; each thread dir re-exports it under its historical name. The wrapper adds:

- Fallback stats (`sabHits` / `fallbackHits`) reported by `getStats()` for observability.
- Peer binding: the main side passes its `Worker` so `dispatch(msg, worker)` knows the sender; the worker side passes nothing. This is the only asymmetry, which is why it is a type parameter rather than two classes.
- Hot-update dispatch swap: `setDispatch()` replaces the field that the fixed `SabMsgChannel.onMsg` closure calls, so a mid-batch swap during hot-update takes effect on the next message without stopping the reader loop. The old `SabMsgChannel.setOnMsg` API was removed — do not reintroduce it.

Constructor shape:

- Main: `(sabOut, sabIn, worker, dispatch)`
- Worker: `(sabOut, sabIn, dispatch)` — `WorkerSabMsgChannel` supplies the empty peer.

`sabOut` comes first on both sides, matching `SabMsgChannel`. `dispatch` is required at construction (aligned with the F4 decision — a channel without a handler is a bug, not a valid intermediate state).

`stop()` (not `close()`) is deliberate: it halts the reader loop but does **not** gate further `send()` calls. The name signals that half-promise; renaming to `close()` would falsely imply the writer is also fenced.

## Hot path constraints

The reader/writer sit on the fast path for every cross-thread message. The following invariants must hold — verify with a synthetic benchmark if you touch these files:

- **Zero per-frame allocation.** Constructors cache `bufView = Buffer.from(view.data.buffer, view.data.byteOffset, view.dataBytes)` and `dv = new DataView(...)` once. Hot paths use absolute offsets (`dv.setUint32(off, …)`, `bufView.toString('utf8', off, off + n)`), never `Buffer.from` / `slice` per message.
- **No per-tick closure allocation.** `SabPump.loopBound` caches `() => this.loop()` in the constructor; every `setImmediate` / `setTimeout` receives `this.loopBound`. Do not pass a fresh arrow.
- **Dispatch reads `this.onMsg` per message.** `SabMsgReader` calls `this.onMsg(...)` directly rather than destructuring it into a local, so `setDispatch` mid-batch takes effect on the very next frame. One extra property lookup per message, traded for hot-update correctness.
- **`waitAsync` shim lives in one place.** Declared once in `sab_ring.ts` and used only by `sab_pump.ts`. `grep -rn 'waitAsync(' src` should return exactly one call site.
- **Producer cursor is a plain field.** `SabRingWriter` keeps `tail` in a JS field and only re-reads `HEAD` when the cached value says the ring is full. Re-reading the opposite cursor per record puts a contended cache line back on the hot path.
- **`claim()` must receive an upper bound.** `Buffer.write` truncates silently at a codepoint boundary when it runs out of room, so claiming "whatever is free" drops characters with no error. Pass `str.length * 3` and let `commit(meta, actualLen)` reconcile the real length — the stride is recomputed from `actualLen`, and publishing a length that disagrees with the cursor advance desyncs reader and writer permanently.

## Notify elision (why `CSTATE` exists)

Waking a thread parked on `Atomics.waitAsync` costs ~6 µs (futex wake + libuv hop). A seq-cst
barrier costs ~10 ns. The old primitive paid a `notify` on every `commitWrite` plus another on
every `resetIndexes`, whether or not anyone was parked — which is where the bulk of the SAB
transport's CPU went.

The consumer now publishes its intent in a third slot, and the producer checks it:

```
consumer, before parking:  store(CSTATE, PARKED) → load(TAIL) recheck → waitAsync
producer, on commit:       store(TAIL, newTail)  → load(CSTATE) → notify only if PARKED
```

Both sides do store-then-load in seq-cst order, so this is Dekker's algorithm: the two
operations cannot both read stale values. A consumer that parks after the producer's store
is visible to the producer's load; a producer that commits after the consumer's recheck is
visible to the recheck. Neither ordering loses the wakeup.

Two invariants follow, and both are easy to break:

- **Never reorder the store and the load** on either side, and never "optimise" the recheck
  away. Each half of the handshake is load-bearing.
- **`stop()` leaves `CSTATE` as `AWAKE`**, so a producer racing a shutting-down reader does
  not notify a dead consumer.

Measured on the real implementation: a busy consumer elides 99%+ of notifies, because it is
rarely parked. The busier the consumer, the more this saves — which is exactly the regime
where the transport was previously most expensive.

## Hot-update drain semantics (the easy trap)

`SabRingReader.drain` stores `HEAD` **outside** the `while` loop, once per batch. Consequence: reading `isSabDrained()` from inside a dispatch handler always sees `head != tail` — the batch you are currently draining has not committed yet. Moving the `Atomics.store(HEAD)` inside the loop would break this contract.

`hot_update.ts` handles this by scheduling `checkDrained` via `setImmediate` from the tail of each dispatch branch. `setImmediate` places the check at the end of the macrotask queue, after `drain` returns and `HEAD` has been stored.

**Every dispatch branch that can produce the last message of a hot-update session must schedule `checkDrained`** — currently `clc`, `cl`, and `response`. Miss one, and a hot-update whose tail message went through the un-scheduled branch will hang until `hotUpdateTimeout` (30s default) fires.

## References

- [SAB ring design: drain-reset vs classic ring](sab_ring_design.md) — why the L1 primitive moved from a drain-reset buffer to a classic power-of-2 ring, and what that costs.
- [Common directory discipline](common_directory_discipline.md) — `src/common/` holds only files genuinely imported from both sides. Single-sided files or paired families live under their own top-level subdir.
- [Subpaths](subpaths.md) — the three-subpath design and the single-sided rule that governs how the transport is exposed.
- Logger's strategy layout mirrors the same split rule (`strategies/{inline,central}/`) — see [`@dogsvr/logger`](https://github.com/dogsvr/logger).
