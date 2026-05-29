Build PHASE 0 of hark's central metrics datastore: a queryable SQLite DB that AUGMENTS (does not replace) the existing JSON store, so we can dogfood the harness with rich, queryable data. This is grounded by a prior read-only research brief — its verified `file:line` anchors are below; trust them but confirm as you go.

## CRITICAL — tooling is flaky right now; a prior attempt at this task spiraled to 7.6M tokens / 0 commits and lost everything. Do NOT repeat that:
- Run tool calls SEQUENTIALLY. Do NOT bundle many writes / commits / checks into one parallel batch — in this harness a single failed call cancels the ENTIRE parallel batch (including your git commits), which is exactly how the prior attempt lost all its work.
- git-commit each logical piece IMMEDIATELY after it's done (shared usage.ts → metricsDb.ts + its test → server.ts ingestion → PR outcomes), so a transient glitch can only cost the current step, never the whole build.
- On a blank or errored tool result, RETRY THAT ONE CALL — do not re-issue a batch and do not assume failure and rebuild from scratch.
- Verify against current `main` first (#22/#23 are merged).

## Goal
Stop losing the rich data hark already reads. Today: no DB; `~/.hark/orchestrations/<id>/orchestration.json` is an overwrite-snapshot and `events.jsonl` is the only time-series; `costUsd` is NEVER computed (always 0); per-tick metrics are overwritten so there's no token/cost time-series. Build a derived, rebuildable read-model in SQLite, ingested off the existing reconcile loop.

## Hard design constraints
- **AUGMENT, don't replace.** The JSON files stay the source of truth (the live server, head, and CLI all depend on them). The SQLite DB is a DERIVED read-model that can be rebuilt from `events.jsonl` + transcripts. Do NOT change the JSON write path or the existing record shapes as your primary mechanism.
- **Zero new dependencies.** Use Node's built-in `node:sqlite` (CONFIRMED working on the live runtime, Node v25.8.0 — `DatabaseSync`). Do not add `better-sqlite3` or any dep.
- DB file: `~/.hark/metrics.db` (respect any HARK dir env override the store already uses; mirror `store.ts`'s base-dir logic).
- Rebuildable: include a `schema_version` pragma and tolerate "delete the DB and re-ingest" — nothing in the DB is authoritative.
- Keep IO-free pure logic (schema DDL strings, the cost calculator, row mappers) separate and unit-testable, matching the codebase's existing "pure builders up top, thin runtime wrappers below" pattern (see `worktree.ts`).

## Phase 0 schema (SQLite)
Create these tables (Phase 1 tables `turns`/`tool_calls` are OUT of scope):
- `orchestrations(id PK, name, goal, project_root, project_name, base_ref, status, managed, autonomy_level, created_at, updated_at)` — upserted snapshot.
- `agents(id PK, orch_id, role, branch, worktree_dir, session_id, pid, lifecycle, task, depends_on, blocked_reason, summary, briefed_at, killed_at, head_woke_at, created_at, updated_at)` — upserted snapshot. Model the head as an agent row with role='head' (or a parallel `heads` table — your call, keep it simple).
- `events(id PK, ts, orch_id, agent_id, kind, message, data_json)` with INDEX(orch_id, ts) and INDEX(kind) — mirrors `events.jsonl` 1:1, append-only.
- `token_samples(id PK, session_id, agent_id, orch_id, ts, input_tokens, output_tokens, cache_read, cache_creation, turns, cost_usd, model)` with INDEX(session_id, ts) — **append a NEW ROW each ingest tick** (this is the time-series that fixes the overwrite data-loss). cost_usd computed at ingest.
- `pr_outcomes(id PK, orch_id, agent_id, ts, status, url, base_ref, branch, message)` — record ALL statuses.

Join key (verified): `agents.session_id` ↔ `token_samples.session_id`. session_id is null until backfilled by the pid→sessionId correlation (`correlation.ts:36-58`, applied at `server.ts:1789-1793`). Ingestion MUST tolerate null session_id and dedupe on session_id.

## Deliverables (4)
1. **The DB + schema** — a new module (e.g. `src/lib/orch/metricsDb.ts`) that opens `~/.hark/metrics.db`, applies the schema idempotently (CREATE TABLE IF NOT EXISTS + schema_version), and exposes typed upsert/insert helpers. Open once, reuse the handle.
2. **Ingestion off the existing reconcile loop.** Hook into `reconcileOrchestrations` (`server.ts:1778-1851`) — it ALREADY iterates active orchestrations, backfills session ids, and reads each transcript for metrics (`controller.ts:555-565`). Add an ingest step that per tick: (a) upserts `orchestrations` + `agents` snapshots; (b) INSERTs a `token_samples` row (append, never overwrite) from the already-read transcript metrics; (c) tails `events.jsonl` into `events` from a stored byte offset (mirror the offset-read pattern in `transcript.ts:563-592`) — idempotent + cheap. Reuse the transcript read that already happens; do not double-read.
3. **Compute `cost_usd`** from model id + token counts (input/output/cache-read/cache-creation). REUSE the existing pricing table at `web/src/lib/usage.ts` — share it server-side rather than inventing a second table (extract it to a shared location both the web bundle and the server import, or mirror it in a shared module; do NOT fork two divergent price tables). Write cost into each `token_samples` row. (Also fine to populate `metrics.costUsd` on the in-memory/JSON record using the same calculator, since that field exists and is always 0 today — but the DB is the durable home.)
4. **Persist ALL PR outcomes.** Today only `status:"created"` logs an event (`server.ts:1552-1561`); the other `PrResult` statuses (`no_remote`/`no_base`/`no_gh`/`error` — see `pr.ts:84-89`) are dropped. Extend the `/pr` endpoint to INSERT a `pr_outcomes` row for EVERY result status (and keep the existing event for created). merged/conflict are human/gh-side and out of scope for now — just leave those columns for later.

## Acceptance / constraints
- Unit tests (the codebase uses vitest): the cost calculator (model+tokens → USD, incl. cache rates) with table-driven cases; schema applies idempotently; token_samples APPENDS (two ingests of the same session yield two rows, not one overwrite); pr_outcomes records a non-`created` status; ingestion tolerates a null session_id. Keep DB tests on `:memory:` or a tmpdir DB.
- Do NOT touch PLAN.md (PM-owned).
- Do NOT break the existing JSON store or its tests. `npm test` green + tsc clean (root) + web tsc clean if you touch `web/`. Small commits.
- Emit the DONE marker with a concise summary: files added/changed, the final schema, where cost comes from, and any deviation from this brief + why.
