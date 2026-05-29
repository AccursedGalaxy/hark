# Brief: Board core — fix two design findings before landing (SF-1, SF-2)

## Resilience header (read first)
Tool IO here is intermittently flaky: blank / dropped / duplicated results, occasional write errors, parallel-batch cascade-cancellation. Run tool calls SEQUENTIALLY; commit each logical piece immediately; retry a SINGLE failed call rather than re-batching; use `/usr/bin/git`.

## Get onto the right code FIRST
The board core + its adversarial test suite are on branch **`hark/pm-hark/tester-af0dd7`** (board store/CLI + 9 passing adversarial tests, 764 green). The dependsOn-at-handoff auto-branching is NOT built, so your worktree starts on pristine base. Before anything else, in your worktree run:
`/usr/bin/git reset --hard hark/pm-hark/tester-af0dd7`
so you build ON TOP of the tested code, then continue on your own branch.

## Context
A Reviewer APPROVED the board core for v1 and surfaced two SHOULD-FIX design findings to fix BEFORE the board holds real data. The board is a SOURCE OF TRUTH that a later reconciliation/silent-drop layer will reconcile against, so both findings are foundational, not polish.

## Fix 1 — SF-1: schema migration path (the source-of-truth durability promise)
The store constructor stamps `user_version` UNCONDITIONALLY with no `ALTER`/migration path. So the "migrate, don't rebuild" promise (the whole reason the board is a durable SoT, unlike the rebuildable `metrics.db`) BREAKS at the first schema bump — a version change would have no path to evolve existing data.
- Add a real migration path: read the current `user_version`, run ordered forward migrations to the target version, stamp it only after. A first schema bump must evolve an existing db WITHOUT data loss.
- Test it: open a db at version N with real rows, bump the schema to N+1, confirm the rows survive and the new shape is present.

## Fix 2 — SF-2: transaction-wrap the read-modify-write ops (concurrency safety)
`setTask`/`link` do read-modify-write that is NOT transaction-wrapped → a lost-update race. Harmless under today's single-PM-writer model, but LOAD-BEARING the moment the reconciliation layer writes concurrently (that layer is already on the roadmap).
- Wrap each read-modify-write op in a transaction (or use an atomic upsert) so concurrent writers can't lose an update. Match the integrity the `task_events` append path already demonstrated under 8-thread concurrency.
- Test it: concurrent `setTask` on the same task from multiple writers converges without a lost update.

## Acceptance criteria
- Both fixes implemented; the 9 existing adversarial tests STILL pass (no regression); 2 new tests added (migration survival; concurrent-setTask no-lost-update).
- Full suite green; tsc clean; small, frequent commits.

## Notes
- Drive to `[[HARK:HANDOFF]]`/`[[HARK:DONE]]` with a clear summary. The human owns the merge; the PM will open the PR.
