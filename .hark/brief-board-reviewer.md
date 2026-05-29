# Brief: Reviewer — board core (gate before PR)

## Resilience header (read first)
Tool IO here is intermittently flaky: blank / dropped / duplicated results, occasional write errors, parallel-batch cascade-cancellation. Run tool calls SEQUENTIALLY; retry a SINGLE failed call rather than re-batching; use `/usr/bin/git`.

## What you are reviewing
Branch **`hark/pm-hark/tester-af0dd7`** — the board core (`src/lib/orch/boardStore.ts`, `boardCli.ts`, wiring in `bin/hark`/`cli.ts`) PLUS a Tester's 9 adversarial tests. Inspect with `/usr/bin/git diff main...hark/pm-hark/tester-af0dd7`. You are READ-ONLY — produce a verdict, do not land.

## Why this review matters
This store is the PM's operational substrate AND becomes the *instrument* a later silent-drop reconciliation layer reconciles against. So correctness here is load-bearing for everything built on top. The Tester already verified the two headline properties (upsert idempotency; task_events append-only/lossless under 8-thread concurrency) and they held. Your job is NOT to re-run that — it's to (a) confirm those tests genuinely exercise what they claim, and (b) review everything the tester wasn't scoped to.

## Hunt these specifically
1. **Are the tester's guarantees real?** Does the concurrency test exercise ACTUAL concurrent writers (not serialized)? Do the idempotency tests truly re-apply the same op and assert convergence? A green test that doesn't exercise the property is worse than no test — it manufactures false confidence.
2. **Source-of-truth integrity.** The board is a SOURCE OF TRUTH, not a derived projection like `metrics.db`. Confirm it lives where a metrics rebuild/wipe can NOT clear it (separate db file/path), and that nothing treats it as rebuildable.
3. **Schema fitness for what's coming.** `depends_on` (edges — representable for the lazy-branch work?), `status` enum (matches `backlog→ready→in-progress→review→done`+`blocked`?), `assignee`/`workstream` (the per-project, cross-orchestration attribution the measurement needs — NOT scoped per-orchestration). Flag any shape that would force a migration later.
4. **CLI correctness + reuse.** `set` as keyed upsert, `add/list/show/link/assign/close` — sane, consistent with `hark agent` conventions, reusing the metricsDb sqlite patterns rather than reinventing them.

## Deliverable
A crisp verdict: **APPROVE** or **CHANGES REQUESTED** (each finding concrete + located). If you find a SCHEMA-level issue that would force a later migration, call it out as a design finding, not just a nit — it needs to reach the PM. Hand back via `[[HARK:HANDOFF]]`/`[[HARK:DONE]]` with the verdict in your summary. The human owns the merge.
