# Brief: Board core — keyed task store + `hark board` CLI

## Resilience header (read first)
Tool IO in this environment is intermittently flaky: blank / dropped / duplicated tool results, occasional write errors, and parallel-batch cascade-cancellation (one failed call in a batch voids the whole batch, losing all of it). To survive it:
- Run tool calls SEQUENTIALLY. Do NOT bundle multiple writes/commits into one parallel batch — one failure cancels all and you lose work.
- Commit each logical piece IMMEDIATELY once it's green. Small, frequent commits.
- If a single call returns blank or errors, RETRY that ONE call. Never re-issue the whole batch.
- Use `/usr/bin/git` for git.

## Intent
Build the first-class task store that becomes the PM's operational substrate (the "board"). It replaces brittle PLAN.md prose edits with atomic, id-addressed operations. Reuse the `node:sqlite` layer already shipped for metrics (PR #24 — see `src/lib/orch/metricsDb.ts` and its `.test.ts`): same dependency, same patterns, NO new dependency, NO daemon.

## Scope
1. A SQLite-backed task store. IMPORTANT: the board is a **SOURCE OF TRUTH**, not a derived/rebuildable projection like `metrics.db`. So it must NOT live anywhere that a metrics rebuild/wipe would clear it — use a separate db file (your call on path; mirror metricsDb's base-dir logic so HARK_ORCH_DIR overrides still work). Schema (refine as you build):
   - `tasks(id PK, title, body, status, assignee, workstream, priority, depends_on, orch_id, agent_id, created_at, updated_at, closed_at)` — `assignee` = role | agentId | workstream; `depends_on` = task id(s); status flow: `backlog → ready → in-progress → review → done` (+ `blocked`).
   - `task_events(id PK, task_id, ts, kind, message, data_json)` — APPEND-ONLY history; never overwritten.
2. A thin `hark board` CLI mirroring `hark agent`: `add / list / show / set / link / assign / close`. `set <id> field=value` is a keyed upsert on the task id.

## Load-bearing correctness properties (this is WHY the board exists — primary acceptance criteria, not optional polish)
- **`set` (upsert) MUST be idempotent.** Applying the same `set <id> field=value` repeatedly converges to the same row — never duplicates, never errors on re-apply. This is the property that makes the board survivable under the flaky IO above: a `set` whose result you didn't see is SAFE to re-run. Test it directly: N repeated applications == one application.
- **`task_events` MUST be append-only and lossless under concurrent writes.** Two writers appending events (same or different tasks) never lose an append and never overwrite. Test it under concurrency, not just serially.
These two properties are load-bearing for a later reconciliation / silent-drop-detection layer that will be built ON TOP of this store. Get them subtly wrong and the architecture above breaks *silently*. Treat them as the headline deliverable.

## Acceptance criteria
- Unit tests for the CLI verbs + schema; tsc clean; full suite green.
- EXPLICIT tests proving (a) upsert idempotency under repeated application, and (b) `task_events` append-integrity under concurrent writes.
- Small, frequent commits.

## Notes
- A Tester and Reviewer will follow on your branch (the Tester briefed specifically on idempotency + append-integrity). Write those tests well — they will be adversarially verified.
- Intent-level brief: locate the metrics sqlite patterns and the `bin/hark` CLI wiring yourself. Don't wait on the PM for line numbers.
- Drive to an open PR (`hark pr`). The human owns the merge.
