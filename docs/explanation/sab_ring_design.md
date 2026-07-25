# SAB ring design: drain-reset vs classic ring

This note explains why dogsvr's SAB transport uses a **drain-reset** buffer instead of a classic modulo ring buffer, what the trade-offs are, and how the design meshes with the per-channel fallback policies at the wrapper layer.

For the three-layer file structure and hot-path invariants, see [sab_transport_layers.md](sab_transport_layers.md); this note only covers the *why*.

## TL;DR

- The primitive in `common/sab_ring.ts` is **not a classic ring buffer** despite its name. It is a fixed-size SPSC byte buffer with two monotonic cursors that get reset to zero once the reader catches the writer.
- Drain-reset is not "more advanced" than a classic ring. It is a **simpler** design with a **lower peak-utilization ceiling**, chosen because dogsvr's workloads sit far from that ceiling and the upper layers benefit from its two side effects: **contiguous frames** and **early back-pressure**.
- Every channel that uses this ring has a fallback strategy at the wrapper layer, so early back-pressure is a feature, not a leak. The primitive itself carries no fallback.

## What drain-reset actually does

Both cursors (`WRITE_INDEX`, `READ_INDEX`) advance monotonically from `0` toward `dataBytes`. They **never wrap by modulo**. The space check inside `tryWrite` is:

```ts
if (write >= read) {
    if (view.dataBytes - write < frameLen) return false;
} else {
    if (read - write - 1 < frameLen) return false;
}
```

The `write >= read` branch is the steady state; the tail-space check only considers `dataBytes - write` — not how much the reader has already consumed. Once the writer reaches the tail, further writes are refused **regardless of how much of the front of the buffer is free**. Only when `write === read` does `resetIndexes` bring both cursors back to `0` and the buffer becomes writable again.

This is intentional. The design bets that in dogsvr's workload the reader catches the writer far more often than it lags meaningfully, so the reset happens naturally and back-to-back cycles look almost the same as if the buffer wrapped.

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

Two of the differences are decisive for the choice:

1. **Contiguous frames.** Reader-side dispatch of a straddling frame in a classic ring requires either a per-frame concat (which allocates), a per-frame copy through scratch space (which is another memcpy), or writer-side padding at the tail (which wastes space and complicates the frame format). Drain-reset removes the entire straddling case from the reader hot path.
2. **Early back-pressure.** A classic ring keeps the writer running until the buffer is truly saturated; drain-reset trips `tryWrite === false` as soon as the tail is reached, which is typically earlier. Whether that is good or bad depends entirely on what the wrapper layer does with the signal — see the fallback section.

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

dogsvr's channels — one for logger lines from workers to a central sink, one for RPC-shaped `Msg` frames between the main thread and each business worker — sit squarely in the first category. The reader is either the main event loop (for `Msg`) or a dedicated logger sink thread pulling into pino, and neither runs at the sustained saturation levels where a classic ring would pay off. Frames are small-to-medium (100 B–64 KB), well below the 1 MB default `dataBytes` for `Msg` and the 4 MB default for line channels.

## Utilization: worked example

To make the ceiling concrete, consider a 1 MB buffer with average frames of 1 KB and a reader that lags by ~200 KB steady state:

- Time 0: `write=0, read=0`.
- The writer fills to `write=1 MB` while the reader consumes to `read=800 KB`. The buffer front (0–800 KB) is unused.
- Next write: `dataBytes - write = 0`, refused. Even though 800 KB of physical space is free, the writer is stalled.
- The writer stays stalled until the reader consumes the remaining 200 KB, `write === read` triggers `resetIndexes`, and the cycle restarts.

A classic ring in the same scenario would keep filling the front 800 KB with no stall. So drain-reset's effective throughput per cycle can be as low as `dataBytes − reader_lag`. That is the price paid.

In dogsvr, the two mitigations are (a) the reader almost always keeps up, so `reader_lag` is small and stalls are rare, and (b) when the reader *does* fall behind, the wrapper layer's fallback absorbs the refused writes — see below.

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

Empirically (in the sense of "consistent with published SPSC ring literature and the primitive's design"), the two designs are within a few percent on the reader-keeps-up path. Drain-reset's slight edge on the reader side (single contiguous copy, no straddle branch, no reassembly path) approximately offsets classic ring's slight edge on the writer side (no reset moment, no `write===read` check). For dogsvr's channels this margin is well below the noise floor of any real workload; it is not a factor in the choice.

The choice is instead driven by:

1. Reader-side simplicity (contiguous frames).
2. Back-pressure timing that matches the wrapper fallbacks.
3. Implementation simplicity (no bitmask, no straddle handling, no fixed-slot alignment constraint on `dataBytes`).

## When to revisit this decision

Revisit if any of these become true:

- Sustained utilization pushes past ~50 %. `sabHits/fallbackHits` in the msg wrapper, and drop counts in the logger, are the telemetry to watch. If fallback ratio climbs to a non-trivial fraction of total traffic, the drain-reset ceiling is starting to bite.
- A new channel is introduced where per-frame allocation is unacceptable *and* frames may exceed half of `dataBytes` (making stalls frequent by construction).
- Latency SLO on cross-thread messages tightens to the point where the reset gap (a few `waitAsync` / `notify` cycles per drain cycle) shows up in tail-latency percentiles.

None of these hold at time of writing. The current shape is the right one for dogsvr's traffic profile.

## Related state header design

The state header layout (`SEQ_INDEX=0`, `WRITE_INDEX=1`, `READ_INDEX=16`, `STATE_SLOTS=32`) is a separate concern from drain-reset itself, but co-optimized:

- `WRITE_INDEX` and `READ_INDEX` sit on different 64 B cachelines to avoid producer-consumer RFO ping-pong.
- The seqlock (`SEQ_INDEX`) only guards `resetIndexes`, since a joint `(write=0, read=0)` transition must appear atomic to a reader that might otherwise observe `read > write` mid-reset. Steady-state commits use plain `Atomics.store` on `WRITE_INDEX`, which is sufficient under the SPSC invariant (each cursor has one writer, `Int32` cannot tear).
- Wakeup uses `Atomics.waitAsync` on `WRITE_INDEX`; `resetIndexes` re-notifies that address, so the reader is woken whether the change came from a commit or a reset.

This is the outcome of a targeted pass covering (a) removing an `Atomics.waitAsync` availability fallback that was dead on supported Node versions, (b) reducing the per-commit atomic count from 4 to 2, and (c) padding for cacheline isolation. See the `sab_ring.ts` header comment for the layout invariants.

## Comparison with `pinojs/thread-stream`

`thread-stream` is the SAB transport underlying pino's worker-thread destination. It is the most mature published Node SPSC SAB channel and covers the same problem as dogsvr's `sab_line`: shipping UTF-8 log lines from a producer thread to a consumer thread via `SharedArrayBuffer`. This section compares the two **for the line-stream case only**. `sab_msg` is deliberately out of scope — it carries RPC-shaped `Msg` frames (head JSON + body bytes/string), a different problem with a different design center.

Both use the **same core primitive** at L1 — a drain-reset byte buffer with monotonic `WRITE_INDEX` / `READ_INDEX`, resetting both cursors to zero when the reader catches the writer. The disagreements below all sit above that primitive.

| Dimension | `thread-stream` | dogsvr `sab_line` |
|---|---|---|
| Ring primitive | Drain-reset (resets on `resetIndexes` when leftover tail space is zero) | Drain-reset (resets on `resetIndexes` when `write === read && write !== 0`) |
| Producer path | Main-thread `write()` appends chunks to a local array; batched `setImmediate` flush into SAB | `SabLogWriter.write` writes each line directly into SAB |
| Framing | UTF-8 byte stream, chunks concatenated at the byte level | 4 B length prefix + UTF-8 bytes per line |
| UTF-8 encoding safety | Historically had a multibyte-split bug at the tail (PR #217) — encoded byte count was computed against a stale offset | Encodes into scratch first (`scratch.write(line, 0, maxBytes, 'utf8')`), takes the returned byte count as truth, then checks space |
| Backpressure signal | Node-stream `'drain'` event when free space drops below buffered length | `tryWrite === false` returned directly to the caller |
| Backpressure response | Producer waits for `'drain'`; buffer eventually drains and reset happens | Wrapper (`SabLogWriter`) routes the line via fallback: `MessagePort.postMessage` for `warn+` lines, per-level drop counter for lower levels |
| Wait/wake | `Atomics.waitAsync` on the main side (since PR #178); worker uses `Atomics.wait` | `Atomics.waitAsync` on the reader; the wrapper does not block |
| Seqlock | Present, guards every `readState` | Present, but only meaningful for `resetIndexes` (commits skip `SEQ_INDEX`) |
| Cacheline padding | `SEQ_INDEX` / `READ_INDEX` / `WRITE_INDEX` are three adjacent slots (16 B) | `SEQ_INDEX+WRITE_INDEX` on cacheline 0, `READ_INDEX` on cacheline 1 (64 B stride) |
| Control channel | `postMessage` for `READY` / `FLUSH` / `FLUSHED` / `ERROR` alongside the SAB data channel | `postMessage` is only the fallback data path; no ID-tagged control protocol |
| Flush API | `flush(cb)` with an ID-tagged callback map; `flushSync()` uses `Atomics.wait` (up to 10 s) | No explicit flush API on the primitive; shutdown drains via `stop()` on the reader |
| Worker naming | Passes `{ name }` to `new Worker` (PR #191) for OS-visible thread names | Not currently passed; tracked as a pending task |

### Where the designs agree

Same L1 primitive (drain-reset), same wait primitive (`Atomics.waitAsync` on the reader side is the correct modern choice), same seqlock intent. Two independently-evolved implementations landing on the same L1 shape is a mild sanity check on the choice.

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
- **The "encode-first" discipline that `thread-stream` PR #217 arrived at the hard way.** dogsvr's `sab_line.ts` already writes into a scratch buffer first and takes the returned byte count as truth. Preserve that order: any change that computes UTF-8 byte length from `.length` or a locally-estimated size, and *then* writes, opens the same class of tail-truncation bug that #217 fixed.

### What not to borrow (yet)

- **Batched local-buffer flushing.** `SabLogWriter.write` currently goes straight to SAB per line — no local array, no `setImmediate` deferral. Keeping it that way is the current default, but the reasoning is weaker than it might look, so this is best read as a conservative choice pending measurement rather than a settled decision.

  What per-line protects that batching would give up:
  - **A narrow crash-tail window on the *business worker* side.** If a worker is killed (SIGKILL, OOM, hang detector), any lines still sitting in a local queue would be lost. Per-line writes make sure everything issued before the crash has reached the SAB, where the central isolate can still drain it. This is real but bounded — the pipeline already has a tail-loss window further downstream, at sonic-boom's async buffer inside the central isolate (`sync: false`). Per-line protects the segment *before* the SAB, not the whole path.
  - **Hang-detected-kill diagnostics.** A special case of the above: when the hang detector fires, the interesting lines are the last few before the loop entered. Per-line keeps those in the SAB rather than in a not-yet-flushed local queue. Value depends on how tight the log-then-hang causal chain typically is.

  What per-line gives up that batching would save:
  - **Atomic-op amortization.** Each line pays one `Atomics.store(WRITE_INDEX)` + one `Atomics.notify`. Batching would fold N lines into one commit. Whether that matters depends on how much of a line's total cost is atomic ops vs everything else (JSON assembly, chindings, `Buffer.write`, dispatch). At low sustained throughput the ratio is invisible; at high sustained throughput it can dominate. dogsvr's steady-state log QPS and the CPU share of atomic ops on the SAB path are **not measured**, so we do not know where dogsvr lives on that curve.
  - **Reader-wakeup coalescing.** Reader is woken per commit (one `Atomics.notify` per line vs one per batch). Same measurement gap.

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
- [`pinojs/thread-stream`](https://github.com/pinojs/thread-stream) — pino's SAB transport. Also uses a drain-reset primitive (`resetIndexes` when leftover tail space reaches zero) but differs from dogsvr in two ways: main-thread `write()` buffers chunks into a local array and flushes in batches on `setImmediate`, and buffer-full triggers a Node-stream `'drain'` event rather than an early `tryWrite === false`. PR [#178](https://github.com/pinojs/thread-stream/pull/178) migrated its main-thread wait from `setTimeout` polling to `Atomics.waitAsync` (dogsvr's `waitForData` uses the same primitive). PR [#217](https://github.com/pinojs/thread-stream/pull/217) fixed a multibyte-UTF-8 boundary bug — dogsvr's `sab_line.ts` avoids the same class by encoding into a scratch buffer first (`scratch.write(line, 0, maxBytes, 'utf8')`) and only then checking whether the encoded byte count fits; contributors touching the encode path should preserve that "encode first, size-check second" order.
