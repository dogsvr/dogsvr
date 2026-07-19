# `src/common/` directory discipline

For **dual-subpath packages** (`@dogsvr/dogsvr`, `@dogsvr/logger`, and any future package with the same shape), `src/common/` has one job: hold code that both the main-thread half and the worker-thread half genuinely import. That's the whole rule. Anything else — even if it "looks shared" or is paired by convention — belongs elsewhere.

This note explains what the rule protects, how to audit against it, the reshaping recipe when a directory drifts, and the reference examples.

## The rule

> A file lives in `src/common/` **iff** both `src/main_thread/` and `src/worker_thread/` value-import it.

Corollaries:

- **Filename suffixes `_main` / `_worker` are a smell.** They advertise single-sidedness. The correct location is `src/main_thread/xxx.ts` or `src/worker_thread/xxx.ts` — or, if the two halves are one strategy family, a top-level subdir (see below).
- **Type-only imports don't count as import.** A file that both sides `import type { X } from '.../foo'` but only one side `new`s or calls into is single-sided. `tsc` erases the type import; the emitted `.js` never `require`s it.
- **The rule is not about physical proximity.** A file two levels deep that both sides import is common; a file at the top of `src/common/` that only main imports is not.

## Why this matters

`src/common/` is a semantic signal: *"this code participates in both thread contexts."* When the directory accretes single-sided files, the signal turns to noise, and every future reader (Claude sessions included) has to re-derive from `grep` which files actually straddle the two subpaths. The cost compounds — subpath boundaries also govern the [SAB transport layers](sab_transport_layers.md) and the [subpath single-sided rule](subpaths.md), and both start from "what's in `src/common/`?"

`logger/src/common/strategies/` (7 files, 5 single-sided) was the trigger for this rule in 2026-07. The fix was structural, not cosmetic — see the reshaping recipe below.

## Auditing a `src/common/` directory

For each file under `src/common/`, run:

```sh
grep -rn 'from "\.\./common/<file>' src/main_thread/ src/worker_thread/
```

- Both sides hit → keep in `common/`.
- Only one side hits → does not belong in `common/`; relocate.
- Zero sides hit but re-exported through `src/common/index.ts` → the file is part of the `./common` subpath's public surface (external consumers import it). Keep it, but confirm the re-export is intentional.

Ask three questions per file:

1. **Who imports it?** (grep)
2. **Are both sides actually using the runtime symbols?** (not just types)
3. **If no, where should it move?**

## Reshaping recipe: paired strategy families

When the structural need is *"each strategy has a main half and a worker half, and the two must evolve in lockstep"* — logger's `inline` vs `central` modes are the canonical example — the correct shape is a **top-level subdir**, not nested inside `common/`:

```
src/
├── main_thread/
│   ├── index.ts
│   └── setup.ts              # picks a strategy at runtime
├── worker_thread/
│   ├── index.ts
│   └── setup.ts              # picks a strategy at runtime
├── strategies/
│   ├── strategy.ts           # shared interface
│   ├── inline/
│   │   ├── main.ts
│   │   └── worker.ts
│   └── central/
│       ├── main.ts
│       ├── worker.ts
│       ├── isolate_entry.ts
│       └── protocol.ts
└── common/                   # ← genuinely-shared primitives only
```

Two things fall out of this layout:

- The two `setup.ts` files are the only place the subpath single-sided rule ([subpaths](subpaths.md)) actually applies: each `setup.ts` sits inside one subpath and picks its own strategy half. `strategies/` internals do not value-import any dogsvr subpath, so they are unconstrained.
- Filenames drop `_main` / `_worker` suffixes; the directory carries the sidedness. `strategies/central/main.ts` reads better than `common/strategies/central_main.ts`.

## Anti-patterns (fix on sight)

| Symptom | Reshaping |
|---|---|
| `common/xxx_main.ts` + `common/xxx_worker.ts` paired | Move to `xxx/{main,worker}.ts` under `src/`, or split into `main_thread/xxx.ts` + `worker_thread/xxx.ts`. |
| `common/strategies/` / `common/handlers/` / `common/transports/` subdir where files are mostly single-sided | Promote the subdir to `src/strategies/` (etc.) — one level up out of `common/`. |
| A file in `common/` that only one side imports | Move it to the importing side's directory. |

## Reference examples

**Positive — `dogsvr/src/common/`** (as of 2026-07): 13 files, all cross-imported or re-exported through the `./common` subpath. No nested subdirs. Files:

- Logger contract: `logger_types.ts`, `logger_console.ts`, `logger_proxy.ts`
- Message + transport: `message.ts`, `sab_ring.ts`, `sab_line.ts`, `sab_msg.ts`
- Shared infra: `shutdown.ts`, `transaction.ts`, `broadcast_types.ts`, `thread_stats_types.ts`, `tracing_types.ts`
- Subpath barrel: `index.ts`

`sab_ring.ts` and `sab_line.ts` are re-exported through `common/index.ts` for the `@dogsvr/dogsvr/common` subpath — see [subpaths](subpaths.md).

**Negative (repaired) — `logger/src/common/strategies/`** (pre-2026-07): 7 files, 5 single-sided. Reshaped to `logger/src/strategies/{inline,central}/{main,worker,…}.ts`. `common/` now holds only genuinely-shared primitives.

## Scope: which packages this applies to

Applies:

- Dual-subpath framework packages: `@dogsvr/dogsvr`, `@dogsvr/logger`, and any future package with `./main_thread` + `./worker_thread` subpaths.

Does not apply:

- `example-proj/src/shared/` — business-app shared dir. Speculative sharing across three servers is fine; "who currently imports this" is the wrong metric when the code is meant to evolve across servers.
- `cl-tsrpc/src/shared/protocols/` — directory name is a `tsrpc-cli` convention. Do not rename.
- Single-subpath packages (`cl-grpc`, `cfg-luban`, `cfg-luban-cli`, `example-proj-client`, `example-proj-cfg`, `example-proj-stress/bots`) — no main/worker split, so the rule does not produce a distinction.
