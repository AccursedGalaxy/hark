# Coder task: Tool-call transport detector — LAYER 1 (transcript-only)

Board task: `task-mprl3ptb-b58ee9` (workstream `harness-fidelity`, priority high).
This implements the **detector half** of tool-call instrumentation. Scope is **layer 1
only** (transcript-only detector). Layer 2 (board reconciliation / `--for`) is a
SEPARATE later task — do NOT build it here.

## Why
PR #25 (capture half) persists **intent only** — the assistant-side `tool_use` blocks —
and discards every result-side signal. So today we cannot tell apart three worker
failure classes: **hark-drop** (our tmux transport lost/mangled the call),
**platform-transient** (Claude/platform hiccup), **worker-misread** (worker
misunderstood a result). The signals to discriminate them are ALREADY parsed into the
`TranscriptEvent[]` the reconcile loop reads each tick — they're just dropped before
they reach SQLite. This task persists them and adds a pure classifier.

## Architecture seam (verified by research — cites are starting points, confirm in code)
- Capture today: `captureTurns(events)` pure projection at `src/lib/orch/metricsDb.ts:386-411`
  walks the transcript, emits a `CapturedTurn` from each assistant event's `tool_use`
  blocks only — it NEVER inspects `tool_result` events. Tables `turns` + `tool_calls`
  (`metricsDb.ts:125-159`); `tool_calls` has NO outcome column. `SCHEMA_VERSION` at
  `metricsDb.ts:32`. The DB is explicitly **rebuildable** (`metricsDb.ts:15-31`) — a
  schema bump wipes + re-ingests from transcripts; no migration needed.
- Signals already parsed but discarded, in `TranscriptEvent` (`src/shared/protocol.ts`):
  - `ToolResultEvent` (`protocol.ts:685-701`): `toolUseId` (join key back to a `tool_use`
    block / `tool_calls.call_id`), `isError`, typed `meta` (e.g. `bash.interrupted`).
  - `AssistantEvent` (`protocol.ts:703-723`): `stopReason`, `isApiError`, `retryAttempt`.
  - `indexToolResults(events)` (`protocol.ts:735-743`) already builds the
    `toolUseId -> ToolResultEvent` map you need to pair intent with outcome.
- Wiring: detector runs at the SAME seam as capture — `ingestMetrics` in
  `src/server.ts:1838-1909`, over the already-read `agentEvents`/`headEvents`. NO new
  transcript reads.

## What to build

### PR-1 (commit set 1): capture-extend — the precondition
- Bump `SCHEMA_VERSION` 2 -> 3 (rebuildable DB; deletes + re-ingests, no migration code).
- Add result-side columns:
  - `tool_calls`: `result_seen INTEGER`, `is_error INTEGER` (optional `result_ts`).
  - `turns`: `is_api_error INTEGER`, `retry_attempt INTEGER`.
- Extend `captureTurns` (or a sibling `captureTurnsWithOutcome`) to pair each `tool_use`
  against `indexToolResults(events)` and read the assistant-turn error flags. Keep it a
  **pure projection** (testable without a DB — matches the established pattern).
- Test: a *dropped* result yields `result_seen=0` while the intent row still exists
  (guards the intent-from-transcript invariant).

### PR-2 (commit set 2): the transcript-only classifier + read API
- Pure exported `classifyToolCalls(events)` (in `metricsDb.ts`, or a new
  `src/lib/orch/detector.ts` if it grows) returning a per-call class:
  `ok | hark_drop | platform_transient | worker_misread_candidate`.
- Discriminator logic:
  - result **absent** + session continues (a LATER turn exists) -> `hark_drop` candidate.
  - result absent BUT issuing turn flagged `isApiError`/`retryAttempt` (or `stop_reason`
    in {max_tokens, pause_turn}) -> `platform_transient` (platform self-reported).
  - result **present + isError** and worker proceeds as success -> `worker_misread_candidate`
    (deterministic flag only — see decision 2 below; do NOT wire a judge).
  - result present + clean -> `ok`.
- **Tail guard (Gap B):** only classify a call as drop-candidate once a later turn
  exists; the detector must be **re-entrant** — re-classify on later ticks so an
  in-flight call's `result_seen` can flip 0->1. (This is why the outcome is a mutable
  column, not an append-only verdict — see decision 1.)
- **Batch awareness (Gap E):** `tool_calls.batch_size`/`batch_position` already exist.
  Treat a batch where calls at position >= N all lack results as a `hark_drop` sub-class
  (cascade-cancel), distinct from a single random drop.
- Add the **first query API** to `MetricsDb` (it is write-only today — no `SELECT` over
  `turns`/`tool_calls` exists anywhere) to read outcomes back. Query API only — **no
  `hark orch status` / UI surface** in this task (decision 4).
- Invoke the classifier from the `ingestMetrics` seam, persisting outcomes via PR-1's
  columns.

## PM decisions (these resolve the research brief's open questions — treat as settled)
1. **Verdict storage = mutable outcome column** on `tool_calls`, re-classified per tick
   (NOT an append-only table) — required for the Gap-B tail re-entrancy.
2. **worker-misread = deterministic flagged-candidate only** for v1. Do NOT wire the
   Haiku judge; leave that as a documented follow-up.
3. **`--for` annotation / board reconciliation = OUT OF SCOPE.** That is layer 2, a
   separate gated task. Do not add a board join key here.
4. **Surface = query API on `MetricsDb` only.** No UI / `orch status` exposure yet.

## Acceptance criteria
- `SCHEMA_VERSION` is 3; deleting the metrics DB and re-ingesting rebuilds with the new
  columns populated from transcripts.
- `captureTurns` (or sibling) is a pure function; a dropped-result fixture yields
  `result_seen=0` with the intent row intact.
- `classifyToolCalls(events)` returns the four classes per the discriminator above,
  honors the tail guard (re-entrant) and batch/cascade sub-class.
- `MetricsDb` has a query API returning per-call outcomes.
- Tests cover: clean call -> ok; dropped result + later turn -> hark_drop; api-error turn
  -> platform_transient; error result -> worker_misread_candidate; in-flight tail call
  NOT misclassified as a drop; cascade batch detected.
- All existing tests stay green. Small, reviewable commits (capture-extend first, then
  classifier+query).

The full architecture findings brief (with all cites) lives at
`/home/aki/.hark/worktrees/hark/orch-mpr2dzv5-c5db65/agent-mprmmk3k-97bd14/.hark/brief-instrumentation-detector.md`
if you want the complete reasoning — but this brief is self-sufficient.
