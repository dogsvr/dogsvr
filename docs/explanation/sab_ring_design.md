# SAB ring design: drain-reset vs classic ring

dogsvr's SAB transport used a **drain-reset** buffer until 2026-09, when it moved to a classic
power-of-2 ring. This note records the three implementations involved, the measurements that drove
the switch, and what the switch costs — because the reason is narrower than it first appears, and
the old design is genuinely better on one axis.

**Revised 2026-09-13 after re-measuring all three implementations against each other.** The
previous version's central argument — that the rewrite was needed to make notify elision possible
— does not survive testing, and has been replaced with the reasons that do. Claims that were
wrong are called out where they appeared rather than quietly deleted, so the same reasoning error
is not repeated. Method notes are at the [end](#how-the-measurements-in-this-note-were-produced).

For the three-layer file structure and hot-path invariants, see
[sab_transport_layers.md](sab_transport_layers.md); this note only covers the *why*.

## TL;DR

- `common/sab_ring.ts` is now a **classic power-of-2 ring**: free-running `int32` cursors, index
  by mask, and a padding record at the tail so frames still never straddle the wrap.
- **The switch was not motivated by buffer utilization**, and it was **not** motivated by notify
  elision either. Both arguments were tested and neither survives — see
  [Two utilizations, measured](#two-utilizations-measured) and
  [Notify elision is orthogonal](#notify-elision-is-orthogonal-to-ring-shape).
- **What actually justified the rewrite** was two correctness defects in the shipped drain-reset
  code — silent truncation, and a lost wakeup caused by an **ABA** race (a value going A → B → A,
  so "unchanged value" stops meaning "nothing happened") — plus a measured producer-side win from
  ~960 ns to ~505 ns per write. See
  [Why the rewrite was actually justified](#why-the-rewrite-was-actually-justified).
- Accepted regressions: an 8 B header + 8 B alignment vs 4 B before, a power-of-two buffer-size
  constraint, and mask/padding/unsigned-distance logic in the writer. A stalled 4 MiB ring holds
  10 814 records now versus 11 049 before (97.0 % vs 98.9 % payload).

## The three designs

Everything that follows — utilization, notify cost, both defects — falls out of how each
implementation answers a single question: **how is space reclaimed?**

### At a glance

| | dogsvr `32e70c5` (previous) | `thread-stream` 4.2.0 | dogsvr current |
|---|---|---|---|
| reclaim strategy | all at once, by rewinding both cursors | all at once, by rewinding both cursors | continuously, per record retired |
| reset condition | `write === read` (reader caught up) | `leftover === 0` **and** reader caught up | never resets |
| record split at wrap | no | **yes** — byte stream reassembles | no — padding record |
| when it cannot fit | **refuse** — `tryWrite` returns `false` | **wait** for the reader, then reset | refuse only when genuinely full |
| needs a seqlock | yes — for the two-cursor reset | yes | no, one writer per cursor |
| buffer size constraint | any | any | power of two (for `& mask`) |
| record header | 4 B length | UTF-8 byte stream, no per-line header | 8 B (length + level), payload 8 B-aligned |

The two drain-reset designs are the same family; the third column of the *split-at-wrap* row is
what separates them, and the *when-it-cannot-fit* row is what makes the same shape safe in one and
not the other.

### Reading the diagrams

All three diagrams below use one buffer picture and two cursors. **The two naming conventions are
the same two cursors** — the code simply renames them when the cursors stop resetting:

| role | drain-reset name (`32e70c5`, `thread-stream`) | classic-ring name (current) | owned by |
|---|---|---|---|
| next byte to be **written** | `write` / `W` (`WRITE_INDEX`) | `tail` (`TAIL_INDEX`) | producer — only it advances this |
| next byte to be **read** | `read` / `R` (`READ_INDEX`) | `head` (`HEAD_INDEX`) | consumer — only it advances this |

Both pairs mean the same thing: the region **between read and write is filled but not yet
consumed**. The difference is range, not role — `write`/`read` are byte offsets bounded by
`dataBytes` and reset to 0, while `tail`/`head` are free-running counters that never reset and
whose byte offset is `cursor & mask`.

```
▓ = written, not yet read (the unread region)      ░ = free space
```

Empty ring means the two cursors are equal; full means the writer has caught the reader from
behind.

### `32e70c5`: drain-reset — the writer only moves forward; the reset is what rewinds it

Two **independent** conditions drive this design, and it is easy to conflate them:

- **Reset** fires when the reader has caught up: `write === read && write !== 0`, checked at the
  top of `tryWrite`. It has **nothing to do with reaching the end of the buffer.**
- **Refusal** happens when the record does not fit in `dataBytes - write`, the space between the
  write cursor and the physical end.

Whichever comes first decides what happens. That is the whole design:

```
W = write cursor (producer)    R = read cursor (consumer)    ▓ = unread    ░ = free

CASE A — the reader keeps up. R has caught W, so the ring is empty.
┌───────────────────────────────────────────────────────────┐
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
└──────────────────────────▲────────────────────────────────┘
                           R = W       (everything written has been read)
        next tryWrite() sees write === read -> resetIndexes() -> both to 0,
        then writes at offset 0. The cursors never traverse the buffer at all;
        measured, this happens on ~every message (1.000 resets/line).

CASE B — the reader lags. R has freed the front, but that space is unreachable.
┌───────────────────────────────────────────────────────────┐
│░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
└──────────────────────────▲────────────────────────────────┘
 │← freed by R, UNUSABLE ─→ R ───── unread ───────────→ W = end
        W !== R, so no reset. Tail space is too small -> REFUSED,
        even though R has already freed everything to its left.
        R advancing further does NOT help until it reaches W (-> CASE A).
```

**Measured**, 20 000 lines into a 4 MiB ring, counting real `resetIndexes` calls:

| reader behaviour | resets per line | refused |
|---|---:|---:|
| drains after every write | 1.000 | 0 |
| drains every 10 writes | 0.100 | 0 |
| drains every 1000 writes | 0.001 | 0 |
| never drains (stalled) | **0.000** | 9 154 |

So in dogsvr's normal regime — reader keeping up — **the reset fires on essentially every
message**, and the buffer's tail is never reached. That constant reset is what made
`resetIndexes`'s unconditional `Atomics.notify` expensive, and it is also what makes the
[lost-wakeup ABA](#defect-2-lost-wakeup-aba-32e70c5-only) reachable in steady state rather than
only at wrap time. The refusal path (Case B) is the *other* regime, and is where the
acceptance-rate gap comes from.

Space is therefore reclaimed **in one batch**, only at the instant the reader fully catches up —
never incrementally as records are retired.

**The `write === read` reset is a strictly dominated design choice.** A survey of open SPSC
ring-buffer implementations turned up nothing that rewinds both cursors to `0` as soon as
`write === read`, regardless of where the write cursor sits and without a compensating structure.
Every published family solves the same "reclaim the empty front" problem better on at least one
axis:

- `thread-stream` — same two-cursor reset, but gated on the write cursor first reaching the
  buffer end, so the reset is rare rather than per-message.
- **BipBuffer** — reclaims space with a runtime watermark (`active_capacity`) and lets the writer
  keep going by opening a second region; only one cursor moves per event, no seqlock needed. See
  [Adjacent precedent](#adjacent-precedent-bipbuffer--out-of-band-cousin-of-the-current-classic-ring)
  below — it is closer in structure to dogsvr's *current* design than to `32e70c5`.
- **Classic ring with padding record** (current dogsvr) — reclaims space per record retired, no
  reset at all.
- Linux kernel ring buffers, DPDK `rte_ring`, `boost::lockfree::spsc_queue`, and
  `rigtorp/SPSCQueue` — free-running cursors and modulo indexing, never drain-reset.

There is no workload on which `32e70c5`'s trigger point is preferable to any of these. Three
independent costs fall out of it, each measurable:

1. **Acceptance gap** — writer refuses while the front is free (Case B above, and the 1–4 pp gap
   in [Two utilizations](#two-utilizations-measured)).
2. **Per-message reset overhead** — in the steady state the reset fires on essentially every
   commit (measured 1.000 resets/line), so the seqlock-protected two-cursor rewind and the
   unconditional `Atomics.notify` become hot-path costs, not rare events.
3. **ABA amplification** — the same high reset frequency puts the write cursor back on identical
   values every cycle, which is what makes [Defect 2](#defect-2-lost-wakeup-aba-32e70c5-only)
   reachable in steady state rather than only at wrap time.

Cost 3 only becomes a lost wakeup when combined with parking on `WRITE_INDEX` (the change from
`127847f` to `32e70c5`), but 1 and 2 are inherent to the trigger point and would still apply if
the park target were fixed. The mechanism is original to dogsvr in the sense that no public
precedent picks this trigger point; it is not original in the useful sense of covering a case
the standard designs miss.

#### Two drain-reset generations, and they differ on the part that mattered

Reading the history as a single "previous design" hides the important detail:

| | park target | lost-wakeup ABA |
|---|---|---|
| `127847f` | `SEQ_INDEX` — monotonic, incremented by every commit | no |
| `32e70c5` | `WRITE_INDEX` — reset to `0` by `resetIndexes` | **yes** |

`127847f` parked on `SEQ_INDEX`, a counter that only ever increases — which is also what
`thread-stream` does. `32e70c5` moved the park target to `WRITE_INDEX`, a cursor that
`resetIndexes` rewinds to `0`.

That single change is what introduced the **lost-wakeup ABA bug** (ABA = a value goes A → B → A,
so "the value did not change" no longer means "nothing happened"): the consumer samples
`WRITE = 247` and is about to sleep until it changes; a reset plus a re-write brings `WRITE` back
to exactly `247`; the value never "changed", so the futex never wakes the consumer even though
there is data waiting. Full definition, reproduction and severity in
[Defect 2](#defect-2-lost-wakeup-aba-32e70c5-only).

The bug therefore belongs to that one line of change, **not** to drain-reset as a shape — the
earlier drain-reset generation does not have it, and neither does `thread-stream`.

### `thread-stream`: fills to the exact end, then waits for the reader

`thread-stream` (the third implementation) is **also** drain-reset — dogsvr's previous design was
modelled on it. The difference is *when* the reset is allowed to happen. `32e70c5` resets as soon
as the reader catches up, wherever the cursors happen to be. `thread-stream` needs **two**
conditions, in order:

1. `leftover === 0` in `nextFlush` — the write cursor sits on the exact buffer end, and
2. `waitForRead()` then blocks until `READ === WRITE` — the reader has consumed everything.

Only then does `resetIndexes` fire. Condition 1 is what `32e70c5` lacks; condition 2 is shared.

```
W = write cursor (producer)   R = read cursor (consumer)   ▓ = unread   ░ = free
buffer = 4096 B, lines = 395 B (deliberately not a whole divisor of 4096)

STEP 1 — producer fills forward. R trails behind, and that does not stop the writer.
┌───────────────────────────────────────────────────────────┐
│░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░│
└─────────────────▲─────────────────────────────────────▲───┘
 │← consumed by R →R ◄──────── unread ───────────────→ W = 3950
                                                        146 B tail left,
                                                        next line needs 395 B

STEP 2 — the line is written ANYWAY: 146 B fit, the rest must wait. W hits the end.
┌───────────────────────────────────────────────────────────┐
│░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┊▓▓▓│
└─────────────────▲─────────────────────────────────────┬──▲┘
              R = 1185            split line starts here┘   W = 4096 = end
        leftover === 0, so nextFlush() calls waitForRead():
        the producer now BLOCKS until R reaches 4096. It does not refuse.

STEP 3 — R drains everything and lands on W. Only now may the reset fire.
┌───────────────────────────────────────────────────────────┐
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
└──────────────────────────────────────────────────────────▲┘
                                                  R = W = 4096
        READ === WRITE satisfied -> resetIndexes() -> both cursors to 0

STEP 4 — the split line's remaining 249 B are written at offset 0.
┌───────────────────────────────────────────────────────────┐
│▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
└────▲──────────────────────────────────────────────────────┘
 R=0  W = 249   ← second half of the line that began at byte 3950
      (R and W both restarted at 0; W has already advanced by 249)
```

Both cursors sampled live from the real 4.2.0 code, with a deliberately slow sink:

```
   W      R    producer-side backlog
 4096      0            7754 B      W parked at the end, waiting for R
 4096    395            7754 B      R advancing one record at a time
 4096      0            3658 B      (R wrapped to 0: the reset fired)
 3658   3658               0 B      R === W again
```

Every reset was preceded by `WRITE_INDEX` equal to the buffer end — never any other value.

Two consequences, and both explain why this shape works there and would not work unchanged here:

- **A record is split across the end** (STEP 2 → 4). Safe only because the payload is a raw byte
  stream reassembled by a `StringDecoder` on the far side — measured: 40 lines in, 40 valid JSON
  records out, none corrupted. dogsvr's `sab_line` frames *discrete length-prefixed records*, so a
  split would desync the reader permanently. That is exactly why the current design emits a
  padding record instead of splitting.
- **Reaching the end refuses nothing.** `waitForRead` blocks and resets afterwards — it *waits*.
  `write()` returning `false` is a Node-stream backpressure hint, not a rejection: measured 280
  `false` returns out of 300 lines with **0 lines lost**, the overflow held in the producer's JS
  heap (peak 112 KB). dogsvr's `tryWrite === false` is a genuine refusal the wrapper must act on.

### Current: free-running classic ring — cursors never reset, the index wraps

```
tail = write cursor (producer)   head = read cursor (consumer)   ▓ = unread   ░ = free
both are free-running counters; the byte index shown is (cursor & mask)

STEP 1 — tail nears the end; remaining space is too small for the next record
┌───────────────────────────────────────────────────────────┐
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░│
└─────────────────────────────────────────▲──────────────▲──┘
                                        head           tail
                                                        └ only 4 B left: too
                                                          small for a record

STEP 2 — writer pads out the tail and resumes at index 0
┌───────────────────────────────────────────────────────────┐
│▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓│PAD│
└─────▲───────────────────────────────────▲─────────────────┘
    tail                                head
 the front is reused immediately — no reset, no stall
```

Nothing ever resets. `tail` and `head` count upward forever (and do go negative — see
[State header design](#state-header-design)); the byte offset is `cursor & mask`. Space is
reclaimed **continuously**: every record the reader retires immediately becomes writable. When a
record does not fit in the remaining tail, the writer writes a **padding record** (a negative
length the reader skips) and restarts at offset 0, so a record is still never split across the
wrap.

### Adjacent precedent: BipBuffer — out-of-band cousin of the current classic ring

BipBuffer (Simon Cooke, 2003; behind the Rust `bipbuffer` crate, the C `c0x0o/bipbuffer` and
`willemt/bipbuffer` libraries, and the reference algorithm walk at
[stefanmisik.com/post/bip-buffer-made-easy](https://www.stefanmisik.com/post/bip-buffer-made-easy.html))
is the closest public precedent for what dogsvr's *current* ring does — **not** for what
`32e70c5` did. This is worth being explicit about, because early notes filed BipBuffer next to
`32e70c5` on the strength of "both reclaim the front"; on closer reading the two are in different
families and BipBuffer belongs with current dogsvr.

**The mechanism BipBuffer and current dogsvr share: mark the tail as unused, and let the writer
start over at index 0.** They only differ in *where the mark lives*:

|                              | mark stored where     | how the reader knows to skip                                 |
|------------------------------|-----------------------|--------------------------------------------------------------|
| **BipBuffer**                | out-of-band (`active_capacity` shared variable) | reader compares `tail` to `active_capacity`; when reached, wraps to 0 |
| **current dogsvr**           | in-band (a padding record — negative length at the end) | reader walks records; a negative length says "skip to 0"     |

That is the whole difference. Both put a boundary at the point where useful data ends in the tail
region, both let the writer keep producing at index 0 while the reader is still draining the tail,
both move a single cursor per event, and neither needs a seqlock. `active_capacity` and the
padding record are two encodings of the same invariant.

What separates this pair from `32e70c5` / `thread-stream` is that neither of them ever performs a
**two-cursor** rewind while data is in flight. The reader retires records at its own pace; the
writer wraps to 0 at its own pace; the two cursors never have to be updated as one transaction.
That is why the `32e70c5` family needs a seqlock and BipBuffer / current dogsvr do not; it is also
why `32e70c5`'s ABA hazard has no analogue in either.

Three state variables in BipBuffer: `head` (write), `tail` (read), and `active_capacity` — a
*runtime* upper bound on the buffer that can be temporarily shortened when the writer wraps to the
front. The B region is not a second buffer; it is `[0, head)` while `active_capacity` marks where
the A region ends.

**Wrap is triggered only inside `Reserve(n)`, and only when both of the following hold:**

```
1. space_ahead   < n              head 前面剩下的空间装不下这次 Reserve
                                    space_ahead = buffer.size − head    (minus 1 if tail == 0)
2. space_behind  > space_ahead    tail 前面已释放的空间比 head 前面剩下的还多，值得回去
                                    space_behind = tail − 1             (0 if tail == 0)
```

`space_behind = tail - 1` because bytes `[0, tail)` have all been consumed by the reader — that
whole prefix is free. The second condition is a *cost/benefit* check: only when going back to
`0` beats staying at the tail does BipBuffer pay the cost of splitting the buffer into two
regions. Missing either condition means no wrap: if condition 1 fails, the write fits in place;
if condition 2 fails (space is free at the front but not much of it), `Reserve` returns the
short `space_ahead` and the caller decides — this is what makes BipBuffer "lazy" and what stops
it from thrashing.

Worked with a 60-byte buffer, `head = 55, tail = 45`, incoming `Reserve(10)`:

```
head = write   tail = read   active_capacity = current tail-end limit
▓ = unread    ░ = free

STEP 1 — Reserve(10) arrives. space_ahead = 5, space_behind = 44 → both conditions hold.
┌────────────────────────────────────────────────────────────┐
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓░░░░░│
└─────────────────────────────────────────────▲─────────▲───▲┘
 │←────── space_behind = 44 ─────────────→│ tail=45  head=55  buffer.size
                                                     │←──→│   = active_capacity
                                                    space_ahead=5  = 60
        Reserve(10):  space_ahead (5) < 10  ✓        AND   space_behind (44) > space_ahead (5)  ✓
                → wrap: active_capacity locks to head, head jumps to 0

STEP 2 — head wraps to 0; active_capacity SHRINKS from 60 to 55 (the old head value).
         Region A = [tail, active_capacity) = [45, 55). Region B = [0, head) = [0, 10).
┌────────────────────────────────────────────────────────────┐
│▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓┊░░░░│
└─────────▲───────────────────────────────────▲─────────▲───▲┘
       head=10                              tail=45     │    buffer.size
                                                        │    = 60
                                             active_capacity = 55
                                             (was 60; now caps region A;
                                              the ┊ marks the deactivated tail)

STEP 3 — reader consumes region A to its end (tail reaches active_capacity = 55).
         tail resets to 0; active_capacity restored to buffer.size = 60.
         Only region B remains; the state is contiguous again.
┌────────────────────────────────────────────────────────────┐
│▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
└▲────────▲──────────────────────────────────────────────────▲┘
tail=0  head=10                                            buffer.size
                                                           = active_capacity
                                                           = 60
```

Pseudocode of the two hot paths, from the reference walk above:

```
Reserve(n):
    space_ahead  = buffer.size - head - (tail == 0 ? 1 : 0)
    if space_ahead >= n:
        return &buffer[head], space_ahead              # write in region A
    space_behind = (tail == 0) ? 0 : (tail - 1)
    if space_behind > space_ahead:
        active_capacity = head                         # cap region A here
        head = 0                                       # open region B
        return &buffer[0], space_behind
    return &buffer[head], space_ahead                  # caller sees short return

Consume(n):
    new_tail = tail + n
    if head >= tail:                                   # contiguous
        if new_tail < head: tail = new_tail
        else:               head = 0; tail = 0         # empty: both reset
    else:                                              # wrapped (B active)
        if new_tail < active_capacity: tail = new_tail
        else:                                          # A drained
            tail = 0
            active_capacity = buffer.size              # B becomes the new A
```

**Laziness gates when the wrap happens.** BipBuffer checks "is this write going to be worth
wrapping for?" and only wraps when the answer is yes. Three consequences drop out:

- Consumer only freed a few bytes? BipBuffer does nothing — condition 2 fails.
- Consumer has freed most of the front? BipBuffer still does nothing until the next Reserve
  actually needs more room than remains at the tail.
- Consumer fully caught up? Handled by the `head = 0; tail = 0` branch in `Consume` — both
  cursors do reset in that branch, but only on the empty-buffer path (no producer write can be
  in flight at the moment the buffer is empty, so this "two-cursor rewind" is not a live-data
  transaction and needs no seqlock).

**How BipBuffer compares to dogsvr's current classic ring (its actual cousin):**

| | BipBuffer | current dogsvr |
|---|---|---|
| Where the "tail-is-dead" mark lives | out-of-band variable `active_capacity` | in-band record with negative length (padding record) |
| How the reader learns to skip | compares `tail` with `active_capacity`, wraps to 0 when hit | reads a record header, sees negative length, jumps to 0 |
| Cursor arithmetic | plain integers on a byte buffer of any size | free-running counters + `& mask`, buffer size must be power of two |
| Space wasted per wrap | none (mark is out-of-band) | one padding record's worth of bytes (bounded by max record size) |
| Consumer complexity | must handle A→B region transition explicitly | same code path as any other record; padding is skipped in the record loop |
| SPSC concurrency | single-cursor mutations, no seqlock | single-cursor mutations, no seqlock |

The two designs are the same shape with the boundary stored in different places. dogsvr's choice
of in-band padding trades a small amount of buffer space for a simpler reader loop, at the cost
of the power-of-two constraint that comes from indexing with `& mask` on free-running counters —
BipBuffer's plain-integer indexing needs neither the mask nor the size constraint, but requires
the reader to be aware of two regions.

Neither of these is `32e70c5`. That design and `thread-stream` sit in a different family (both
cursors rewound as one transaction, seqlock required, no boundary mark) which BipBuffer does not
belong to despite the "reclaim the front" family resemblance in prose. Filed here as adjacent
precedent for the *current* design, not as the ancestor of the previous one.

### Why the one decision cascades

| | Drain-reset (both generations) | Classic ring (current) |
|---|---|---|
| Space reclaimed | in a batch, only when `write === read` (or at `leftover === 0`) | continuously, per record retired |
| Can refuse while space is free? | **yes** — this is the entire acceptance-rate gap | no, only when genuinely full |
| Needs a reset step | yes, and it is a two-cursor change | no |
| Needs a seqlock | **yes** — to make the two-cursor reset look atomic | no, one writer per cursor |
| Safe to park on the write cursor? | **no** — reset rewinds it (this is Defect 2) | yes, it never rewinds |
| Frame layout | contiguous (or split, in `thread-stream`) | contiguous, one padding record per wrap |
| Reader dispatch | single `toString` / `copy` view | same — padding hides the wrap from the reader |
| Buffer size | any | power of two (for `& mask`) |
| Wasted space | none | one padding record per wrap |

The seqlock row is a chain reaction: drain-reset needs to set `write = 0` and `read = 0`
*together*, and a reader that samples between those two stores sees a corrupt state. That is why
the old code had `SEQ_INDEX` and a retry loop on every `readState`. Remove the reset and the whole
mechanism becomes unnecessary — each cursor then has exactly one writer, and an `Int32` cannot
tear.

Two properties the current design deliberately keeps or gives up:

1. **Contiguous frames — kept.** When a record does not fit in the tail, the writer emits a
   padding record (negative length) and restarts at offset 0. The reader skips padding and never
   sees a straddling frame, so the reader hot path is the same as it was under drain-reset. The
   cost is the occasional wasted tail fragment, bounded by one max-record-size per wrap.
2. **Early back-pressure — given up.** A classic ring keeps the writer running until the buffer
   is truly saturated. The measurements below show the practical difference is small and, in one
   regime, favours the old design.

The last row of the reclaim column is the real dividing line. In both drain-reset designs the
reader's progress is worth nothing until it reaches an all-or-nothing threshold; in the classic
ring it pays off continuously. That is the whole source of the acceptance-rate gap measured in
[Two utilizations, measured](#two-utilizations-measured).

## Why the rewrite was actually justified

The case rests on two correctness defects in the shipped `32e70c5` code plus a measured
producer-side win.

### Defect 1: silent truncation (both drain-reset generations)

`SabLineWriter.tryWrite` encoded through a fixed scratch buffer:
`scratch.write(line, 0, maxBytes, "utf8")`. When a line exceeded `maxBytes` (the logger
configured 64 KiB), `Buffer.write` truncated at a codepoint boundary and returned the *short*
count — which was then framed as if it were the whole line. No error, no marker.

Worse, the truncation drops the trailing `\n`, so the corruption escapes the record. Feeding a
100 KB line followed by a normal one through the shipped old code:

```
old (scratch = 64 KiB, as the logger configured it):
  writes 2 records -> 1 record on the sink, 65 572 B, invalid JSON
  the following record was swallowed into the corrupt line
current: 2 records, 100 034 B and 36 B, both valid JSON
```

Error and fatal lines carry stack traces and serialized context; exceeding 64 KiB is not exotic.
This is silent data corruption that spreads to an adjacent record, and it is the strongest single
reason the old code should not have stayed in production.

The current writer avoids it by claiming an upper bound (`line.length * 3`) before writing and
reconciling the true length in `commit`. A line too large for the whole ring is **refused**
(`tryWrite` returns `false`, wrapper policy decides) rather than truncated.

### Defect 2: lost-wakeup ABA (`32e70c5` only)

> **ABA** is the classic concurrency hazard where a value goes **A → B → A**. An observer that
> only compares values concludes "nothing happened", when in fact something did — the value merely
> came back. The mistake is always the same: using *value equality* to answer *"did an event
> occur?"*. Values can return; events cannot be undone.
>
> The textbook case is a lock-free stack where CAS sees the same head pointer after a
> pop/pop/push cycle and wrongly succeeds. Here the primitive is `Atomics.wait` rather than CAS,
> but the flaw is identical: `Atomics.wait(ptr, v)` means *"sleep while the value still equals
> `v`"*, and what the consumer actually wants to ask is *"has anything been written since I
> looked?"*. Those two questions differ exactly when the cursor can revisit a value.

Parking on `WRITE_INDEX` is unsafe precisely because `resetIndexes` rewinds it — and crucially,
the reset fires **in the reader-keeps-up steady state**, not rarely at wrap time (measured at
1.000 resets per line above). With uniform line lengths that makes `WRITE` land on the *identical*
value every cycle. Writing one 426 B record and fully draining it, repeatedly, gives:

```
WRITE after each (write + drain) cycle:  426, 426, 426, 426, 426, 426
```

A consumer descheduled between its `readState()` and its `waitAsync()` samples 426, and by the
time it parks the value is 426 again:

```
consumer                                  producer
─────────────────────────────────────────────────────────────────────
reads WRITE = 426  ────── A
  (descheduled here — this is the whole window)
                                          tryWrite(): write === read,
                                            so resetIndexes() → WRITE = 0   ── B
                                          writes the record  → WRITE = 426  ── A again
                                          notify() fires, but nobody is parked yet: wasted
  (resumes)
waitAsync(WRITE, 426)
  → still 426, so "no change" → SLEEPS
  → a record is sitting unread, and no further wakeup is coming
```

The notify is not lost because of a missing barrier — it is lost because it fired during the
window, before the consumer parked, and the value it would have signalled is indistinguishable
from the value the consumer sampled.

Reproduced against the real shipped readers by holding that window open through a side channel:

| implementation | park target | parked on | lost wakeup | worker alive during stall |
|---|---|---:|---|---|
| `127847f` | `SEQ_INDEX` | 2 | no | — |
| `32e70c5` | `WRITE_INDEX` | 247 | **yes** | yes, 100 heartbeats |
| current | `TAIL` (free-running) | 256 | no | — |

Severity is bounded, and the reason is worth stating because it is not obvious: once a record is
stranded unread, `write !== read`, so `resetIndexes` **stops firing** and `WRITE` goes back to
increasing monotonically. The value the consumer parked on is left behind by the very next write:

```
reader stuck asleep, writer still logging uniform lines:
  write #1: WRITE=426   READ=0    reset would NOT fire
  write #2: WRITE=852   READ=0    reset would NOT fire
  write #3: WRITE=1278  READ=0    reset would NOT fire
```

Measured recovery: 1 further line, with uniform *and* varied line lengths. So this is a latency
spike, not a permanent hang — the ABA window needs the reset to keep firing, and the stall itself
stops it. It is still a real lost wakeup in a primitive whose whole job is not to lose them, and
it needs only one more coincidence (a consumer that stops logging after the stalled line) to
become indefinite.

### Producer-side cost, decomposed

Three implementations differ in more than one way at once, so a raw old-vs-new number cannot say
*what* paid off. These three variants change one thing at a time. All accept 100 % of lines (a
refused write is much cheaper than an accepted one, so mixing acceptance rates would corrupt the
comparison), same lines, same consumer, median of 15 runs, ±3 % run to run:

| # | variant | encoding path | record header | ring shape | ns per write |
|---|---|---|---|---|---:|
| 1 | old `32e70c5`, as shipped | line → 64 KiB scratch buffer → copy into ring | 4 B length | drain-reset | ~960 |
| 2 | drain-reset, direct write | line → written straight into the ring | 8 B (length + level) | drain-reset | ~695 |
| 3 | current, as shipped | line → written straight into the ring | 8 B + payload 8 B-aligned | classic | ~505 |

**1 → 2 (~1.4×, 260–290 ns) is the encoding path.** The old writer encoded each line into a
scratch `Buffer`, then copied those bytes a second time into the ring. The current writer reserves
space first (`claim`) and has `Buffer.write` encode UTF-8 directly into the ring, so each line is
touched once instead of twice. Note this step also *enlarges* the header 4 B → 8 B, which works
against it — the encoding win alone is larger than the net figure, and the header gives some back.

**2 → 3 (~1.35×, 175–195 ns) is the ring shape**, drain-reset → classic. The classic ring adds an
AND mask per record and padding-record handling, but removes the seqlock: no `SEQ` increment pair
on every commit, no retry loop, and no per-call object allocation in `readState`. On balance the
classic shape is the cheaper of the two here — the mask costs far less than the seqlock saved,
which lays to rest the older folklore that the mask is a per-frame overhead worth worrying about.

Two cautions about reading this table:

- **Do not quote a fixed split** ("the copy was 65 % of the win" or similar). The ratio moves with
  line size and consumer pace. An earlier draft of this note did exactly that and was wrong.
- **Neither step is the biggest lever on this path.** Under a paced producer with a *parking*
  consumer, switching that consumer from `park` to `poll` was worth ~1 600 ns/line — larger than
  the encoding and shape changes combined. Pump mode dominates; see
  [Elision only pays in `poll` mode](#elision-only-pays-in-poll-mode).

What drives the current choice, restated honestly:

1. **Correctness** — the truncation and ABA defects above.
2. **Producer cost** — measurably lower, though less dramatically than first claimed.
3. Reader-side simplicity — preserved via padding records, not lost.
4. Back-pressure timing that matches the wrapper fallbacks — slightly worse now, accepted.

Accepted regressions, stated plainly: a 4 B header became 8 B plus 8 B payload alignment;
`dataBytes` must now be a power of two; and the writer carries mask/padding/unsigned-distance
logic it did not have before.

**None of this means drain-reset was the wrong shape.** A drain-reset ring with an upper-bound
claim, a `SEQ` park target, and `CSTATE` elision would be correct and close in performance, at
better space efficiency. The current design was chosen and measured; the shape was not the
deciding factor.

## Two utilizations, measured

The "utilization" argument that motivated the original framing is worth measuring rather than
asserting, because two distinct metrics hide under that word — and they favour opposite designs.

| | question it answers | who wins |
|---|---|---|
| **Acceptance rate** | of all the lines the producer tried to write, what fraction did the ring take (rather than returning `false`)? | classic ring, by 1–4 pp |
| **Space efficiency** | with the buffer full, how much of it is payload rather than header and padding? | drain-reset, by ~2 pp |

Acceptance rate is the one that matters operationally — a refused line is a line the wrapper must
drop or reroute. Space efficiency only sets the ceiling on how many records fit before refusals
start.

> **`pp` = percentage point**, the unit for the *difference* between two percentages. Going from
> 95.10 % to 99.14 % acceptance is **+4.04 pp** — not "+4 %", which would be the relative change
> (4.04 / 95.10 ≈ 4.2 %). Both quantities in this note are already percentages, so every gap
> between them is quoted in pp to keep the two readings apart.

### Why drain-reset refuses early: worked example

To make the ceiling concrete, consider a 1 MB buffer with average frames of 1 KB and a reader
that lags by ~200 KB steady state:

- Time 0: `write=0, read=0`.
- The writer fills to `write=1 MB` while the reader consumes to `read=800 KB`. The buffer front (0–800 KB) is unused.
- Next write: `dataBytes - write = 0`, refused. Even though 800 KB of physical space is free, the writer is stalled.
- The writer stays stalled until the reader consumes the remaining 200 KB, `write === read` triggers `resetIndexes`, and the cycle restarts.

A classic ring in the same scenario would keep filling the front 800 KB with no stall. So
drain-reset's effective throughput per cycle can be as low as `dataBytes − reader_lag`. That is
the price paid. In dogsvr the reader almost always keeps up, so `reader_lag` is small and stalls
are rare; when the reader does fall behind, the wrapper layer's fallback absorbs the refused
writes.

### Measured: acceptance rate

**What this measures:** of every line the producer offered, the percentage the ring accepted.
Higher is better. Simulated with pino-shaped lines (85 % 150–400 B, 14 % 400 B–1 kB, 1 % 2–8 kB)
into a 4 MiB ring, both designs driven by the *same* consumer model retiring whole records.
"5 % behind" means the consumer retires 95 records for every 100 the producer writes.

| Consumer pace | Classic + padding | Drain-reset | Gap |
|---|---:|---:|---:|
| Keeps up exactly | 100.00 % | 100.00 % | **none** |
| 0.1 % behind | 100.00 % | 99.90 % | +0.1 pp |
| 1 % behind | 100.00 % | 99.02 % | +1.0 pp |
| 5 % behind | 99.14 % | 95.10 % | +4.0 pp |
| 10 % behind | 94.39 % | 90.05 % | +4.3 pp |

Reproducing these numbers requires care: a simulation that drains eagerly (retiring everything
visible on every step) reports 100 % for both designs at every pace and shows no gap at all. The
gap only appears when the consumer retires a *fixed fraction of records produced*, letting a real
backlog form. The absolute percentages also depend on record count and buffer size — what is
stable is the ordering and the rough magnitude, not the exact figures.

### Measured: space efficiency

**What this measures:** with the consumer never running, how many records fit before the ring
refuses, and what fraction of the 4 MiB is payload rather than header and alignment padding.

Two results are worth recording alongside this measurement because they contradict the intuition
that motivated the rewrite: with the consumer keeping up on average but draining in batches of
1 → 8192 records, both designs accept 100 % (coarse batching does not hurt drain-reset); and a
fully stalled consumer favours drain-reset — but on space efficiency, not acceptance.

| framing | records held | payload | of buffer |
|---|---:|---:|---:|
| old, 4 B header | 11 049 | 4 149 991 B | 98.9 % |
| current, 8 B header + 8 B alignment | 10 814 | 4 069 547 B | 97.0 % |

The old framing simply packs more records into the same bytes. This is the ~2 pp regression the
[TL;DR](#tldr) refers to, and it is the one axis on which the previous design is better.

So the honest summary: the classic ring buys 1–4 pp of **acceptance** in one regime, and gives up
~2 pp of **space efficiency** everywhere. If utilization of either kind were the only
consideration, this rewrite would not be worth doing. At the workload that triggered the
investigation — 500 k lines/s on the logger channel — the "consumer chronically slightly behind"
regime does materialise, but the utilization argument is worth a few percentage points, not the
order of magnitude the original framing implied.

## Notify elision is orthogonal to ring shape

**An earlier version of this note was wrong about this, and the error drove the whole
justification.** It claimed free-running cursors are what make notify elision possible, and that
"drain-reset cannot support this: resetting both cursors to zero destroys the parked-on value."

Elision does not depend on the cursors. It depends on `CSTATE` — the consumer publishing whether
it is parked — and on parking on *some* value the producer does not rewind. Drain-reset has such
a value already: the monotonic `SEQ` counter. Tested by building drain-reset with a `SEQ` park
target plus the same `CSTATE` Dekker handshake, over 200 park/wake cycles with idle gaps:

| variant | notify/line | lost wakeups | payload SHA-256 |
|---|---:|---:|---|
| drain-reset, park on `SEQ`, no elision | ~1.03 | 0 | identical |
| drain-reset, park on `SEQ`, **elision** | ~0.005 | 0 | identical |
| current classic ring | — | 0 | identical |

All 8 000 lines arrived byte-identical in every variant. Elision works fine on drain-reset: it
removes >99 % of notifies there too. The reset destroys the parked-on value only if you park on
`WRITE`, which is the `32e70c5` mistake, not a property of the shape.

### Elision only pays in `poll` mode

A second correction to the same claim. "Elision removes 99 %+ of notifies under load" holds for
the **line** channel and not the **msg** channel, because they use different pump modes. Measured
on the real `sab_msg` channel (mode `park`) by counting `Atomics.notify` calls:

| producer spacing | line channel (`poll`) | msg channel (`park`) |
|---|---:|---:|
| back-to-back | 100 % elided | ~97 % elided |
| 3 µs apart | 100 % elided | ~42 % elided |
| 20 µs apart | 100 % elided | ~3 % elided |

A parking consumer is parked most of the time by construction, so the `CSTATE` check finds
`PARKED` and the notify fires anyway. At realistic message spacing the msg channel gets almost
nothing from elision. This is a reason to consider `poll` for that channel, not a reason to
change the ring.

## Operating context

### Wrapper fallback strategy

Every channel using this ring has a fallback path defined by the wrapper, and the primitive
itself carries **no** fallback logic — `sab_ring`, `sab_line`, and `sab_msg` all sit below any
policy layer and let the wrapper decide on `tryWrite === false`.

**Msg channel** (`main_thread/sab_msg_channel.ts` + `worker_thread/sab_msg_channel.ts`)
- On `tryWrite === false`, the wrapper falls back to `MessagePort.postMessage`.
- Semantics: *no message loss*. Fallback trades throughput for correctness — the message goes through, just slower.
- `sabHits` / `fallbackHits` counters expose the ratio for observability.

**Line channel** (`@dogsvr/logger`'s `strategies/central/sab_writer.ts`)
- Two modes gated by `fallbackOnFull`:
  - `"warn+"` (default): lines at level ≥ warn fall back through `MessagePort.postMessage`; lines below warn increment a per-level drop counter.
  - `"drop"`: all refused lines are counted as drops.
- The drop counters are flushed to the main thread every 1 s as a `sabDropReport`, so drops remain observable.
- Semantics: *important logs preserved, verbose logs sheddable*.

### State header design

The current layout is three cursors on separate 64 B cachelines: `TAIL_INDEX` (producer-owned),
`HEAD_INDEX` (consumer-owned), `CSTATE_INDEX` (consumer-published park flag). Cacheline isolation
avoids producer-consumer RFO ping-pong (RFO = read-for-ownership, the cache-coherence traffic
generated when two cores keep writing to the same cacheline and must steal it from each other).

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

### When to revisit

The 2026-09 switch was triggered by sustained utilization climbing, observed as logger drops at
high line rates. The investigation found the utilization ceiling was the lesser problem; the
defects in [Why the rewrite was actually justified](#why-the-rewrite-was-actually-justified)
were the greater one.

Revisit the current design if:

- **Header overhead starts to matter.** The 8 B header plus alignment costs ~3.2 % of a 4 MiB
  ring at 250 B average lines, versus ~1.6 % before. If record sizes shrink substantially
  (say, a metrics channel with 32 B records), that ratio gets bad enough to reconsider the
  frame format — not necessarily the ring shape.
- **A consumer appears that parks constantly.** Notify elision pays off in proportion to how
  busy the consumer is. A channel whose consumer is idle most of the time gets little benefit
  and still pays the header cost. The msg channel is already in this position — see
  [Elision only pays in `poll` mode](#elision-only-pays-in-poll-mode).

One condition listed here previously — "`Atomics.waitAsync` gains a timeout-capable form" —
**has already been met** and should be acted on rather than waited for. Node 24.13 supports the
four-argument form; `Atomics.waitAsync(ta, i, v, 120)` resolves `"timed-out"` after ~123 ms.
That would allow a park/poll hybrid without the `setTimeout` machinery in `sab_pump.ts`, and
would let the msg channel keep park-mode latency while recovering elision.

Telemetry to watch: `sabHits` / `fallbackHits` in the msg wrapper and drop counts in the logger.
Note that `fallbackHits` should now trend toward zero, so it is a weaker signal than it was —
a sustained non-zero value means something is genuinely wrong rather than merely busy.

## thread-stream: what to borrow, what not to

`thread-stream` is the SAB transport underlying pino's worker-thread destination. It is the most
mature published Node SPSC (single-producer, single-consumer — exactly one writing thread and one
reading thread, which is what lets both designs skip locking) SAB channel and covers the same
problem as dogsvr's `sab_line`: shipping UTF-8 log lines from a producer thread to a consumer
thread via `SharedArrayBuffer`. This section covers the line-stream case only. `sab_msg` is
deliberately out of scope — it carries RPC-shaped `Msg` frames (head JSON + body bytes/string), a
different problem with a different design center.

The two **used to share the same L1 shape** — dogsvr's previous design was modelled on
`thread-stream`, and `127847f` even parked on `SEQ_INDEX` exactly as `thread-stream` does. As of
2026-09 they diverge: dogsvr moved to a free-running classic ring, while `thread-stream` still
resets. The full comparison is captured in [The three designs](#the-three-designs) above; this
section only records the pieces that do not fit there. Compared against `thread-stream@4.2.0` as
vendored in `logger/node_modules`.

### Measured: what each transport sacrifices under overload

Same pino-shaped lines, same sink (sonic-boom to a real file), consumer throttled to ~100 k
lines/s while the producer pushes as fast as it can. Delivery verified by counting lines on disk:

| | lines on disk | delivered | producer CPU | throughput | peak producer buffer |
|---|---:|---:|---:|---:|---:|
| `thread-stream` | 60 000 / 60 000 | **100 %** | 7 328 ns/line | 364 k lines/s | 0.3 MiB |
| dogsvr `sab_line` | 10 992 / 60 000 | 18.3 % | **1 958 ns/line** | **1 392 k lines/s** | — |

Neither column is strictly better; they fail differently by design. `thread-stream` never drops a
line, paying with producer heap — and that buffer is genuinely unbounded: a producer that writes
in a tight synchronous loop never lets the `setImmediate` flush run, and **73 MiB of lines
accumulated in the producer's local array** in one measured run. For a long-lived game server
that is an OOM risk, not a safety guarantee.

dogsvr sheds load instead, and the shedding is graded. Under the same overload with the real
`fallbackOnFull: "warn+"` policy:

| level | sent | via SAB | via postMessage | dropped |
|---|---:|---:|---:|---:|
| 20 (debug) | 18 000 | ~4 000 | 0 | ~14 000 (78 %) |
| 30 (info) | 36 000 | ~8 000 | 0 | ~28 000 (78 %) |
| 40 (warn) | 3 000 | ~670 | ~2 330 | **0** |
| 50 (error) | 3 000 | ~670 | ~2 330 | **0** |

The split between SAB and postMessage shifts run to run; what is invariant is the last column.
Every warn/error/fatal line survives via the postMessage fallback; only debug and info are shed.
That is the intended trade for a game server, and it is why `thread-stream`'s no-loss guarantee
is not automatically the better choice here.

The corollary matters for anyone reading `fallbackHits` as a health signal: under overload the
msg channel's fallback is doing real work, and on the line channel a *rising* postMessage rate at
`warn+` is the system behaving correctly, not failing.

### Where the designs agree

Same wait primitive — `Atomics.waitAsync` on the reader side is the correct modern choice, and
both arrived at it independently. They also still agree on the part `32e70c5` got wrong:
`thread-stream`'s worker parks on `SEQ_INDEX`, a counter nothing rewinds. Parking on a cursor
that `resetIndexes` returns to zero is the one thing neither the current design nor
`thread-stream` does.

The two no longer agree on the L1 shape, so the old "two independent implementations converged"
argument no longer applies. This is not evidence dogsvr is right and `thread-stream` is wrong:
the designs optimise for different things. `thread-stream` batches on the producer side, which
amortises the notify cost that dogsvr instead eliminates with a handshake. Batching would have
been a legitimate alternative route to the same goal — see "What not to borrow" below.

### Where dogsvr goes further at the primitive layer

Two of the differences are targeted micro-optimizations dogsvr made after splitting `sab_ring.ts` out from the framing layers, neither adopted by `thread-stream` at time of writing:

- **Cacheline padding for producer/consumer cursors** (`TAIL` / `HEAD` / `CSTATE` on separate 64 B cachelines). `thread-stream`'s three slots (`SEQ` at 2, `WRITE` at 4, `READ` at 8) share one cacheline and suffer producer-consumer RFO ping-pong under contention.
- **Commit path uses one `Atomics.store` plus a conditional `notify`**, not the seqlock's `add / store / add` sequence. The SPSC invariant makes seqlock protection on commits unnecessary — each cursor has a single writer, `Int32` cannot tear. `thread-stream` still pays for the full seqlock on every commit.
- **Notify elision via `CSTATE`.** `thread-stream` notifies unconditionally. Measured cost of a
  notify that actually wakes a parked thread: **4 749 ns**, versus **29 ns** for the store-plus-load
  that replaces it when the consumer is awake. (The earlier "~6 µs vs ~10 ns" figures were the right
  order of magnitude.) Note this only pays in `poll` mode — see
  [Elision only pays in `poll` mode](#elision-only-pays-in-poll-mode).

Whether these matter depends on producer path. dogsvr's per-line writes make the per-commit cost visible; `thread-stream`'s batching amortizes it across many appended chunks.

### Where dogsvr chose differently at the wrapper layer

- **Per-line vs batched producer path.** `thread-stream` collects chunks locally and flushes on `setImmediate`. dogsvr writes per line. This is the largest observable behavioral difference, and it is not a strictly-better choice either way — see "What not to borrow (yet)" below.
- **Backpressure surface.** `thread-stream` exposes Node-stream `'drain'`. dogsvr exposes `tryWrite === false`. Neither is intrinsically better; they match different consumers. Node streams are the natural fit for pino's `DestinationStream` contract on the `thread-stream` side. dogsvr's `SabLogWriter` wants an immediate boolean so it can pick fallback vs drop synchronously per line.
- **Control channel philosophy.** `thread-stream` runs a `postMessage` protocol (`READY`, `FLUSH`, `FLUSHED`, `ERROR`, ID-tagged callbacks) alongside the SAB data channel. dogsvr uses `postMessage` only as the fallback *data* path for lines the SAB refused. See [`sab_transport_layers.md`](sab_transport_layers.md) for the wrapper layer.

### Where dogsvr should borrow

- **Worker `name` option** (PR #191). `new Worker(..., { name })` (Node 20+) surfaces the worker's role in OS-level tooling (`top -H`, `htop`, `perf`, gdb, eBPF). dogsvr's multi-layer fork (pm2 → server → Worker) currently shows only generic `node` process names, which makes OS-side correlation harder. Cheap, non-breaking, worth doing.
- **The "trust the encoder's return value" discipline that `thread-stream` PR #217 arrived at the hard way.** dogsvr's `sab_line.ts` no longer uses a scratch buffer — it claims an upper bound and writes straight into the ring — but the underlying rule is unchanged and now matters *more*: `Buffer.write` truncates silently at a codepoint boundary when it runs out of room, returning a short count with no error and no replacement character. So the claim must cover the worst case (`str.length * 3`), never "however much room is left". Any change that sizes the claim from `.length` alone, or that writes before reserving, reopens exactly the #217 class of bug — which is not hypothetical here: it is precisely [Defect 1](#defect-1-silent-truncation-both-drain-reset-generations), measured in the shipped `32e70c5` code.
- **Graceful handling of records larger than the buffer.** `thread-stream`'s byte-stream framing
  carries a 100 KB line through a 16 KiB SAB intact, because a record may span arbitrarily many
  flushes. dogsvr refuses such a line outright. Refusal is vastly better than truncation, and
  under `fallbackOnFull: "warn+"` a `warn+` line still reaches the sink via postMessage — but
  under `"drop"`, or for an info-level line, an oversized record is simply lost. If oversized
  records ever become routine (large structured payloads, base64 blobs), a chunked continuation
  frame is the fix, not a bigger ring.

### What not to borrow (yet)

- **Batched local-buffer flushing.** `SabLogWriter.write` currently goes straight to SAB per line — no local array, no `setImmediate` deferral. Keeping it that way is the current default, but the reasoning is weaker than it might look, so this is best read as a conservative choice pending measurement rather than a settled decision.

  What per-line protects that batching would give up:
  - **A narrow crash-tail window on the *business worker* side.** If a worker is killed (SIGKILL, OOM, hang detector), any lines still sitting in a local queue would be lost. Per-line writes make sure everything issued before the crash has reached the SAB, where the central isolate can still drain it. This is real but bounded — the pipeline already has a tail-loss window further downstream, at sonic-boom's async buffer inside the central isolate (`sync: false`). Per-line protects the segment *before* the SAB, not the whole path.
  - **Hang-detected-kill diagnostics.** A special case of the above: when the hang detector fires, the interesting lines are the last few before the loop entered. Per-line keeps those in the SAB rather than in a not-yet-flushed local queue. Value depends on how tight the log-then-hang causal chain typically is.

  What per-line gives up that batching would save:
  - **Atomic-op amortization.** Each line pays one `Atomics.store(TAIL)` plus one `Atomics.load(CSTATE)`. Batching would fold N lines into one commit. This gap has **narrowed substantially**: the expensive part used to be the unconditional `Atomics.notify` (measured at 4 749 ns when it woke a parked consumer), and notify elision removes essentially all of those *for the line channel*. What remains is a store and a load, ~29 ns for the pair, which is unlikely to be worth a crash-tail window.
  - **Reader-wakeup coalescing.** This was the strongest argument for batching and it is now largely moot **for the line channel**: measured at 100 % elision in poll mode at every producer spacing tested, because the consumer stays `AWAKE` while traffic flows. It is *not* moot for the msg channel, which parks — see [Elision only pays in `poll` mode](#elision-only-pays-in-poll-mode). Batching (or a poll-mode switch, or a `waitAsync` timeout hybrid) remains a live option there.

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
- [`pinojs/thread-stream`](https://github.com/pinojs/thread-stream) — pino's SAB transport. Uses a drain-reset primitive, the same *family* dogsvr used until 2026-09 — but with a stricter reset condition: `thread-stream` requires the write cursor to reach the exact buffer end (`leftover === 0`) **and then** waits for the reader to catch up, whereas dogsvr's `32e70c5` reset as soon as the reader caught up, wherever the cursors happened to be. See [`thread-stream`: fills to the exact end](#thread-stream-fills-to-the-exact-end-then-waits-for-the-reader). It also differs in that main-thread `write()` buffers chunks into a local array and flushes in batches on `setImmediate`, and buffer-full triggers a Node-stream `'drain'` event rather than an early `tryWrite === false`. PR [#178](https://github.com/pinojs/thread-stream/pull/178) migrated its main-thread wait from `setTimeout` polling to `Atomics.waitAsync` (`sab_pump.ts` uses the same primitive). PR [#217](https://github.com/pinojs/thread-stream/pull/217) fixed a multibyte-UTF-8 boundary bug — see "Where dogsvr should borrow" for why that lesson still binds after the scratch buffer was removed. Version compared here: **4.2.0**, as vendored under `logger/node_modules/thread-stream`.

## How the measurements in this note were produced

Every figure above comes from running the three implementations against each other, not from
estimation. The old implementation was recovered with `git show 32e70c5:src/common/sab_line.ts`
(and `127847f` for the earlier generation), compiled with the same tsconfig, and driven through a
real `worker_threads` consumer. Points worth repeating for anyone re-running them:

- **Compare only at equal acceptance.** A refused `tryWrite` is much cheaper than an accepted one,
  so a variant that drops 20 % of lines looks artificially fast. Pace the producer until every
  variant accepts 100 %, or the CPU-per-line column is meaningless.
- **Isolate the pump mode.** Whether the consumer parks or polls dominates producer cost far more
  than framing or ring shape. Comparing a park-mode reader against a poll-mode one measures the
  pump, not the ring.
- **Verify delivery out-of-band.** Count lines on disk, or hash the payloads. An accepted write is
  not a delivered record, and a lost wakeup shows up as neither an error nor a refusal.
- **A lost wakeup needs its window held open.** The ABA race lives between the reader's
  `readState()` and its `waitAsync()`. Wrapping `Atomics.waitAsync` in the consumer and blocking
  there on a side-channel SAB makes it deterministic; without that it is a nanoseconds-wide window
  that ordinary load will not hit reliably.
- **Distinguish a parked reader from a dead worker.** `waitAsync` promises do not keep a worker's
  event loop alive. Add a heartbeat timer, or an exited worker will masquerade as a lost wakeup.
