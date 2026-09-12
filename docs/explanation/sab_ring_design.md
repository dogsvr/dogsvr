# SAB ring design: drain-reset vs classic ring

dogsvr's SAB transport used a **drain-reset** buffer until 2026-09, when it moved to a classic
power-of-2 ring. This note records both designs, the measurements that drove the switch, and
what the switch costs — because the reason is narrower than it first appears, and the old design
is genuinely better on one axis.

For the three-layer file structure and hot-path invariants, see [sab_transport_layers.md](sab_transport_layers.md); this note only covers the *why*.

## TL;DR

- `common/sab_ring.ts` is now a **classic power-of-2 ring**: free-running `int32` cursors, index
  by mask, and a padding record at the tail so frames still never straddle the wrap.
- **The switch was not motivated by buffer utilization.** On a like-for-like comparison the two
  designs are identical whenever the consumer keeps up, and drain-reset is *better* when the
  consumer stalls outright. The utilization gap only appears in a narrow regime (consumer
  chronically a few percent behind) and is worth 0.3–2.3 percentage points of acceptance.
- **The switch was motivated by `Atomics.notify`.** Free-running cursors are what make notify
  elision possible, and notify is where the transport's CPU actually went: waking a parked
  thread costs ~6 µs versus ~10 ns for the barrier that replaces it. Elision now removes 99%+
  of notifies under load. See [sab_transport_layers.md](sab_transport_layers.md#notify-elision-why-cstate-exists).
- The cost is a larger record header (8 B + 8 B alignment vs 4 B) and slightly more complex
  writer logic. That is a real, accepted regression in space efficiency.

## What drain-reset did (the previous design)

Both cursors (`WRITE_INDEX`, `READ_INDEX`) advanced monotonically from `0` toward `dataBytes`. They **never wrapped by modulo**. The space check inside `tryWrite` was:

```ts
if (write >= read) {
    if (view.dataBytes - write < frameLen) return false;
} else {
    if (read - write - 1 < frameLen) return false;
}
```

The `write >= read` branch was the steady state; the tail-space check only considered `dataBytes - write` — not how much the reader had already consumed. Once the writer reached the tail, further writes were refused **regardless of how much of the front of the buffer was free**. Only when `write === read` did `resetIndexes` bring both cursors back to `0`.

The design bet that the reader catches the writer far more often than it lags meaningfully. That bet was **correct** — see the measurements below. What it missed is that `resetIndexes` ended with an `Atomics.notify`, and in the steady state `write === read && write !== 0` held on almost every message, so the reset fired constantly and paid the wakeup cost every time.

## Comparison with a classic modulo ring

A classic ring uses a power-of-two size and masks the cursors: `offset = cursor & (size - 1)`. Cursors are free-running `uint32` counters; the buffer wraps slot-by-slot; the free space at any moment is `dataBytes - (write - read)`.

| Dimension | Drain-reset (current) | Classic ring |
|---|---|---|
| Peak buffer utilization | Up to `dataBytes` per cycle, but writer stalls at tail until reader catches up | Up to `dataBytes - 1` at all times, regardless of consumer pace |
| Frame layout | Always contiguous | May straddle the wrap point, requires two-segment copies or padding |
| Reader dispatch (read side) | Single `bufView.toString('utf8', off, off + n)` / `copy` | Straddling frames must be reassembled: either two-segment concat (allocation!) or copy through a scratch buffer |
| Offset math | Raw `write` | Bitmask AND (~free on modern CPUs) |
| Back-pressure trigger | Writer reaches buffer tail | Buffer truly full (`write - read == dataBytes`) |
| Consumer-keeps-up regime | Full throughput; reset is invisible | Full throughput |
| Consumer-lags regime | Refuses early once tail is reached | Keeps filling gaps until truly full |
| Reset behavior | Explicit `resetIndexes` seqlock-protected | None needed |
| Record header | 4 B length | 8 B (length + meta), payload 8 B-aligned |
| Notify elision | Not possible — cursors reset, so there is no stable value to park on | Possible: park on a free-running `TAIL`, publish `CSTATE` |

On the two differences that originally drove the choice:

1. **Contiguous frames — kept.** This property was worth keeping, and the current design keeps it:
   when a record does not fit in the tail, the writer emits a **padding record** (negative length)
   and restarts at offset 0. The reader skips padding and never sees a straddling frame, so the
   reader hot path is the same as it was under drain-reset. The cost is the occasional wasted tail
   fragment, which is bounded by one max-record-size per wrap.
2. **Early back-pressure — given up, and it mattered less than claimed.** A classic ring keeps the
   writer running until the buffer is truly saturated. The measurements below show the practical
   difference is small and, in the stalled-consumer case, favours the old design.

## When each design wins

**Drain-reset wins when:**

- The reader can keep up in the steady state, so `write === read` happens frequently and resets are cheap.
- Frames are dispatched to a UTF-8 decoder or a copy-out destination that benefits from a single contiguous view.
- The upper layer has a fallback path (postMessage, drop, retry-later) and can act on an early `tryWrite === false` more usefully than sitting on a full ring.
- Bursts are bounded well below buffer size; a burst lands, the reader drains, the cycle repeats.

**Classic ring wins when:**

- The workload persistently runs near saturation (reader chronically slightly behind writer). Drain-reset caps utilization at the point where the tail is reached; classic ring keeps filling gaps.
- Tail latency at high sustained throughput matters more than reader-side simplicity — classic ring hides transient reader hiccups by using the free front of the buffer.
- The reader is prepared to handle straddling frames efficiently (e.g. with `readv`-style scatter reads or when frames are fixed-size slot-aligned so wrap never splits them).

**This classification held up under measurement.** The "classic ring wins when the reader is
chronically slightly behind" case is exactly the one that shows a gap, and nothing else does —
see the next section. What did *not* hold up is the follow-on claim that dogsvr never enters
that regime: at 500 k lines/s the logger channel does.

But note what that means for the decision: the utilization argument is worth a couple of
percentage points, not the order of magnitude the original framing implied. The switch is
justified by notify elision, not by this table.

## Utilization: worked example

To make the ceiling concrete, consider a 1 MB buffer with average frames of 1 KB and a reader that lags by ~200 KB steady state:

- Time 0: `write=0, read=0`.
- The writer fills to `write=1 MB` while the reader consumes to `read=800 KB`. The buffer front (0–800 KB) is unused.
- Next write: `dataBytes - write = 0`, refused. Even though 800 KB of physical space is free, the writer is stalled.
- The writer stays stalled until the reader consumes the remaining 200 KB, `write === read` triggers `resetIndexes`, and the cycle restarts.

A classic ring in the same scenario would keep filling the front 800 KB with no stall. So drain-reset's effective throughput per cycle can be as low as `dataBytes − reader_lag`. That is the price paid.

In dogsvr the reader almost always keeps up, so `reader_lag` is small and stalls are rare; when
the reader does fall behind, the wrapper layer's fallback absorbs the refused writes — see below.

### What the gap actually measures

Simulated with pino-shaped lines (85 % 150–400 B, 14 % 400 B–1 kB, 1 % 2–8 kB) into a 4 MiB ring,
both designs driven by the *same* consumer model retiring whole records:

| Consumer pace | Classic + padding | Drain-reset | Gap |
|---|---:|---:|---:|
| Keeps up exactly | 100.00 % | 100.00 % | **none** |
| 0.1 % behind | 100.00 % | 99.74 % | +0.3 pp |
| 1 % behind | 100.00 % | 98.87 % | +1.1 pp |
| 5 % behind | 97.17 % | 94.95 % | +2.2 pp |
| 10 % behind | 92.23 % | 89.92 % | +2.3 pp |

Two results are worth recording because they contradict the intuition that motivated the rewrite:

- **Coarse batching does not hurt drain-reset.** With the consumer keeping up on average but
  draining in batches of 1 → 8192 records, both designs accept 100 %. The "consumer wakes rarely,
  so the writer hits the tail with the front empty" scenario does not materialise.
- **A fully stalled consumer favours drain-reset** (92.57 % vs 90.63 % over a 12 000-line burst),
  because its 4 B header beats an 8 B header plus 8 B alignment — the same buffer simply holds
  more records.

So the honest summary is: classic ring buys 0.3–2.3 pp of acceptance in one regime, and loses
~2 pp in another. If utilization were the only consideration, this rewrite would not be worth doing.

## The mask overhead argument is a red herring

Older comparisons sometimes cite the AND mask in `cursor & (size-1)` as a per-frame overhead classic rings pay and drain-reset doesn't. This is not a meaningful cost on modern CPUs (~0.3 cycle, dwarfed by any memory access in the same frame). It should not be part of the decision. The real reasons are the contiguous-frame property and the back-pressure timing, both discussed above.

## Fallback strategy at the wrapper layer

Every channel using this ring has a fallback path defined by the wrapper, and drain-reset's early back-pressure is designed against those fallbacks:

**Msg channel** (`main_thread/sab_msg_channel.ts` + `worker_thread/sab_msg_channel.ts`)
- On `tryWrite === false`, the wrapper falls back to `MessagePort.postMessage`.
- Semantics: *no message loss*. Fallback trades throughput for correctness — the message goes through, just slower.
- `sabHits` / `fallbackHits` counters expose the ratio for observability.

**Line channel** (`@dogsvr/logger`'s `strategies/central/sab_writer.ts`)
- Two modes gated by `fallbackOnFull`:
  - `"warn+"` (default): lines at level ≥ warn fall back through `MessagePort.postMessage`; lines below warn increment a per-level drop counter.
  - `"drop"`: all refused lines are counted as drops.
- The drop counters are flushed to the main thread every 1 s as a `sabDropReport`, so drops remain observable.
- Semantics: *important logs preserved, verbose logs sheddable*. Drain-reset's early back-pressure means warn/error/fatal preferences kick in *before* the buffer is truly saturated, protecting critical logs from being crowded out by a debug flood.

In both channels, early back-pressure is not a defect. A classic ring would delay the fallback signal until the buffer is truly full, which for the line channel means high-severity logs could get pushed out during a debug spike, and for the msg channel means a backlog grows before postMessage takes over. Neither is what the wrapper wants.

The primitive itself carries **no** fallback logic. `sab_ring`, `sab_line`, and `sab_msg` all sit below any policy layer — they return `false` and let the wrapper decide.

## Steady-state throughput expectation

The original version of this section claimed the two designs are "within a few percent on the
reader-keeps-up path" and that the margin "is not a factor in the choice". **The first half was
right** — measurement puts them at exactly equal (100 % vs 100 %) whenever the consumer keeps up.
The second half was right too, just not in the way it intended: utilization is indeed not the
deciding factor. The deciding factor turned out to be something the section did not consider at
all, namely the cost of the wakeup mechanism.

What drives the current choice:

1. **Notify elision** (the reason for the rewrite). Free-running cursors give the consumer a
   stable value to park on, which is what makes the Dekker handshake in `sab_pump.ts` possible.
   Drain-reset cannot support this: resetting both cursors to zero destroys the parked-on value.
2. Reader-side simplicity — preserved via padding records, not lost.
3. Back-pressure timing that matches the wrapper fallbacks — slightly worse now, accepted.

Accepted regressions, stated plainly: a 4 B header became 8 B plus 8 B payload alignment;
`dataBytes` must now be a power of two; and the writer carries mask/padding/unsigned-distance
logic it did not have before.

## When to revisit this decision

The 2026-09 switch was triggered by the first condition this section originally listed —
sustained utilization climbing, observed as logger drops at high line rates — but the
investigation found the utilization ceiling was the *lesser* problem and notify cost the
greater one.

Revisit the current design if:

- **Header overhead starts to matter.** The 8 B header plus alignment costs ~3.2 % of a 4 MiB
  ring at 250 B average lines, versus ~1.6 % before. If record sizes shrink substantially
  (say, a metrics channel with 32 B records), that ratio gets bad enough to reconsider the
  frame format — not necessarily the ring shape.
- **A consumer appears that parks constantly.** Notify elision pays off in proportion to how
  busy the consumer is. A channel whose consumer is idle most of the time gets little benefit
  and still pays the header cost.
- **`Atomics.waitAsync` gains a timeout-capable form worth using**, which would allow a
  park/poll hybrid without the current `setTimeout` machinery in `sab_pump.ts`.

Telemetry to watch: `sabHits` / `fallbackHits` in the msg wrapper and drop counts in the logger.
Note that `fallbackHits` should now trend toward zero, so it is a weaker signal than it was —
a sustained non-zero value means something is genuinely wrong rather than merely busy.

## Related state header design

The current layout is three cursors on separate 64 B cachelines: `TAIL_INDEX` (producer-owned),
`HEAD_INDEX` (consumer-owned), `CSTATE_INDEX` (consumer-published park flag). Cacheline isolation
avoids producer-consumer RFO ping-pong.

**The seqlock is gone.** It existed solely to make the joint `(write=0, read=0)` transition of
`resetIndexes` appear atomic. With no reset, there is no multi-word transition to protect: each
cursor has exactly one writer and `Int32` cannot tear, so plain `Atomics.store` / `Atomics.load`
carry the required release/acquire ordering. This also removed the per-call object allocation in
the old `readState`, which ran on every message.

Two properties the free-running cursors depend on:

- **`dataBytes` must be a power of two.** Index wrap is `cursor & mask`, which stays contiguous
  across the `int32` sign flip only when `dataBytes` divides 2^32. With a non-power-of-two size
  the wrap point jumps — a 5000-byte ring skips from index 3647 to 1352 — and frames desync.
  `makeSabRing` enforces this; `toPowerOfTwo` rounds config values up.
- **Distance arithmetic must be unsigned.** Cursors are free-running `int32` and *do* go negative;
  at 30 k msg/s the cursor completes a full 2^32 cycle roughly every 20 minutes, so this is
  routine rather than a corner case. Free space is `cap - ((tail - head) >>> 0)`. Dropping the
  `>>> 0` makes the subtraction produce a huge positive number after the wrap, and the ring
  concludes it has infinite space and overwrites unread data.

## Comparison with `pinojs/thread-stream`

`thread-stream` is the SAB transport underlying pino's worker-thread destination. It is the most mature published Node SPSC SAB channel and covers the same problem as dogsvr's `sab_line`: shipping UTF-8 log lines from a producer thread to a consumer thread via `SharedArrayBuffer`. This section compares the two **for the line-stream case only**. `sab_msg` is deliberately out of scope — it carries RPC-shaped `Msg` frames (head JSON + body bytes/string), a different problem with a different design center.

The two **used to share the same L1 shape** — a drain-reset byte buffer with monotonic `WRITE_INDEX` / `READ_INDEX`. As of 2026-09 they diverge: dogsvr moved to a free-running classic ring to enable notify elision, while `thread-stream` still resets. Most of the comparison below sits above the primitive and is unaffected; where the divergence matters it is called out.

| Dimension | `thread-stream` | dogsvr `sab_line` |
|---|---|---|
| Ring primitive | Drain-reset (resets on `resetIndexes` when leftover tail space is zero) | Drain-reset (resets on `resetIndexes` when `write === read && write !== 0`) |
| Producer path | Main-thread `write()` appends chunks to a local array; batched `setImmediate` flush into SAB | `SabLogWriter.write` writes each line directly into SAB |
| Framing | UTF-8 byte stream, chunks concatenated at the byte level | 4 B length prefix + UTF-8 bytes per line |
| UTF-8 encoding safety | Historically had a multibyte-split bug at the tail (PR #217) — encoded byte count was computed against a stale offset | Claims an upper bound (`str.length * 3`), writes directly into the ring, and takes `Buffer.write`'s return value as truth; `commit` reconciles the real length |
| Backpressure signal | Node-stream `'drain'` event when free space drops below buffered length | `tryWrite === false` returned directly to the caller |
| Backpressure response | Producer waits for `'drain'`; buffer eventually drains and reset happens | Wrapper (`SabLogWriter`) routes the line via fallback: `MessagePort.postMessage` for `warn+` lines, per-level drop counter for lower levels |
| Wait/wake | `Atomics.waitAsync` on the main side (since PR #178); worker uses `Atomics.wait` | `Atomics.waitAsync` on the reader; the wrapper does not block |
| Seqlock | Present, guards every `readState` | Present, but only meaningful for `resetIndexes` (commits skip `SEQ_INDEX`) |
| Cacheline padding | `SEQ_INDEX` / `READ_INDEX` / `WRITE_INDEX` are three adjacent slots (16 B) | `SEQ_INDEX+WRITE_INDEX` on cacheline 0, `READ_INDEX` on cacheline 1 (64 B stride) |
| Control channel | `postMessage` for `READY` / `FLUSH` / `FLUSHED` / `ERROR` alongside the SAB data channel | `postMessage` is only the fallback data path; no ID-tagged control protocol |
| Flush API | `flush(cb)` with an ID-tagged callback map; `flushSync()` uses `Atomics.wait` (up to 10 s) | No explicit flush API on the primitive; shutdown drains via `stop()` on the reader |
| Worker naming | Passes `{ name }` to `new Worker` (PR #191) for OS-visible thread names | Not currently passed; tracked as a pending task |

### Where the designs agree

Same wait primitive — `Atomics.waitAsync` on the reader side is the correct modern choice, and
both arrived at it independently.

The two no longer agree on the L1 shape, so the old "two independent implementations converged,
which is mild evidence the choice is right" argument no longer applies. It is worth being explicit
that this is not evidence dogsvr is right and `thread-stream` is wrong: the designs optimise for
different things. `thread-stream` batches on the producer side, which amortises the notify cost
that dogsvr instead eliminates with a handshake. Batching would have been a legitimate alternative
route to the same goal — see "What not to borrow" below.

### Where dogsvr goes further at the primitive layer

Two of the differences are targeted micro-optimizations dogsvr made after splitting `sab_ring.ts` out from the framing layers, neither adopted by `thread-stream` at time of writing:

- **Cacheline padding for producer/consumer cursors** (`WRITE` and `READ` on separate 64 B cachelines). `thread-stream`'s three adjacent slots suffer producer-consumer RFO ping-pong under contention.
- **Commit path uses one `Atomics.store` + one `notify`**, not the seqlock's `add / store / add` sequence. The SPSC invariant makes seqlock protection on commits unnecessary — each cursor has a single writer, `Int32` cannot tear. `thread-stream` still pays for the full seqlock on every commit.

Whether these matter depends on producer path. dogsvr's per-line writes make the per-commit cost visible; `thread-stream`'s batching amortizes it across many appended chunks.

### Where dogsvr chose differently at the wrapper layer

- **Per-line vs batched producer path.** `thread-stream` collects chunks locally and flushes on `setImmediate`. dogsvr writes per line. This is the largest observable behavioral difference, and it is not a strictly-better choice either way — see the extended discussion in "What not to borrow (yet)" below.
- **Backpressure surface.** `thread-stream` exposes Node-stream `'drain'`. dogsvr exposes `tryWrite === false`. Neither is intrinsically better; they match different consumers. Node streams are the natural fit for pino's `DestinationStream` contract on the `thread-stream` side. dogsvr's `SabLogWriter` wants an immediate boolean so it can pick fallback vs drop synchronously per line, without registering an event listener.
- **Control channel philosophy.** `thread-stream` runs a `postMessage` protocol (`READY`, `FLUSH`, `FLUSHED`, `ERROR`, ID-tagged callbacks) alongside the SAB data channel. dogsvr uses `postMessage` only as the fallback *data* path for lines the SAB refused. See [`sab_transport_layers.md`](sab_transport_layers.md) for the wrapper layer.

### Where dogsvr should borrow

- **Worker `name` option** (PR #191). `new Worker(..., { name })` (Node 20+) surfaces the worker's role in OS-level tooling (`top -H`, `htop`, `perf`, gdb, eBPF). dogsvr's multi-layer fork (pm2 → server → Worker) currently shows only generic `node` process names, which makes OS-side correlation harder. Cheap, non-breaking, worth doing.
- **The "trust the encoder's return value" discipline that `thread-stream` PR #217 arrived at the hard way.** dogsvr's `sab_line.ts` no longer uses a scratch buffer — it claims an upper bound and writes straight into the ring — but the underlying rule is unchanged and now matters *more*: `Buffer.write` truncates silently at a codepoint boundary when it runs out of room, returning a short count with no error and no replacement character. So the claim must cover the worst case (`str.length * 3`), never "however much room is left". Any change that sizes the claim from `.length` alone, or that writes before reserving, reopens exactly the #217 class of bug.

### What not to borrow (yet)

- **Batched local-buffer flushing.** `SabLogWriter.write` currently goes straight to SAB per line — no local array, no `setImmediate` deferral. Keeping it that way is the current default, but the reasoning is weaker than it might look, so this is best read as a conservative choice pending measurement rather than a settled decision.

  What per-line protects that batching would give up:
  - **A narrow crash-tail window on the *business worker* side.** If a worker is killed (SIGKILL, OOM, hang detector), any lines still sitting in a local queue would be lost. Per-line writes make sure everything issued before the crash has reached the SAB, where the central isolate can still drain it. This is real but bounded — the pipeline already has a tail-loss window further downstream, at sonic-boom's async buffer inside the central isolate (`sync: false`). Per-line protects the segment *before* the SAB, not the whole path.
  - **Hang-detected-kill diagnostics.** A special case of the above: when the hang detector fires, the interesting lines are the last few before the loop entered. Per-line keeps those in the SAB rather than in a not-yet-flushed local queue. Value depends on how tight the log-then-hang causal chain typically is.

  What per-line gives up that batching would save:
  - **Atomic-op amortization.** Each line pays one `Atomics.store(TAIL)` plus one `Atomics.load(CSTATE)`. Batching would fold N lines into one commit. This gap has **narrowed substantially**: the expensive part used to be the unconditional `Atomics.notify` (~6 µs when it woke a parked consumer), and notify elision already removes 99 %+ of those. What remains is a store and a load, ~10 ns each, which is unlikely to be worth a crash-tail window.
  - **Reader-wakeup coalescing.** This was the strongest argument for batching and it is now largely moot: with the line channel's consumer in poll mode, the producer's `CSTATE` check finds `AWAKE` while traffic is flowing and issues no notify at all.

  Bottom line: per-line is the default, chosen because (a) it protects the pre-SAB tail on business-worker crashes, and (b) no measurement has yet shown the atomic-op cost matters. Revisit when any of these become true:
  - A `perf` / `linux profile` sample under representative load shows atomic ops on the SAB path in a significant CPU bucket (order of magnitude worth thinking about, not just visible in the flame graph).
  - Post-mortems repeatedly find crash root causes obscured by lines *before* the SAB — evidence that the current tail window is uncomfortably wide relative to what batching would give up.

  The right trigger is a measurement, not a preset QPS number.
- **`flush(cb)` with ID-tagged callback map** — dogsvr's central-isolate flush flow is serialized; no parallel pending flushes need tracking.
- **Node-stream `'drain'` event as the primary backpressure signal** — dogsvr's `SabLogWriter` benefits from a synchronous boolean; adding drain events would double the API surface for no clear consumer.

## References

- [`sab_transport_layers.md`](sab_transport_layers.md) — three-layer file structure, subpath exposure, wrapper layer, hot-path invariants, hot-update drain semantics.
- [`common_directory_discipline.md`](common_directory_discipline.md) — how `src/common/` is scoped.
- V8 blog, "Efficient JavaScript concurrency with Atomics" — Atomics semantics on modern V8 (memory ordering, waitAsync).
- Node.js docs, `worker_threads` — `MessagePort` structured-clone cost, the fallback path both wrappers use.
- [`pinojs/thread-stream`](https://github.com/pinojs/thread-stream) — pino's SAB transport. Uses a drain-reset primitive (`resetIndexes` when leftover tail space reaches zero), which is what dogsvr used until 2026-09. It also differs in that main-thread `write()` buffers chunks into a local array and flushes in batches on `setImmediate`, and buffer-full triggers a Node-stream `'drain'` event rather than an early `tryWrite === false`. PR [#178](https://github.com/pinojs/thread-stream/pull/178) migrated its main-thread wait from `setTimeout` polling to `Atomics.waitAsync` (`sab_pump.ts` uses the same primitive). PR [#217](https://github.com/pinojs/thread-stream/pull/217) fixed a multibyte-UTF-8 boundary bug — see "Where dogsvr should borrow" for why that lesson still binds after the scratch buffer was removed.
