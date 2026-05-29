# Brief: Tester — board core, load-bearing properties

## Resilience header (read first)
Tool IO here is intermittently flaky: blank / dropped / duplicated results, occasional write errors, parallel-batch cascade-cancellation. Run tool calls SEQUENTIALLY; commit each logical piece immediately; retry a SINGLE failed call rather than re-batching; use `/usr/bin/git`.

## Get onto the right code FIRST
The implementation under test is on branch **`hark/pm-hark/coder-e3bff0`** (board core: `src/lib/orch/boardStore.ts`, `boardCli.ts`, + tests). The dependsOn-at-handoff auto-branching is NOT built yet, so your worktree starts on pristine base. Before doing anything else, in your worktree run:
`/usr/bin/git reset --hard hark/pm-hark/coder-e3bff0`
so you are testing the coder's actual code, then build on your own branch from there.

## Mandate (adversarial — try to BREAK these two properties, not confirm them)
You are the gate on the two properties the whole board architecture leans on. A later reconciliation / silent-drop-detection layer is built ON TOP of these, so a subtle break here corrupts everything above it silently.
1. **Upsert idempotency.** Prove `set <id> field=value` applied repeatedly converges to one row — no duplicates, no error on re-apply, no drift. Attack it: re-apply the same op N times; interleave re-applies with other ops; re-apply after a partial/failed-looking write. The property that must hold: a `set` whose result you didn't see is SAFE to re-run.
2. **`task_events` append-only + lossless under CONCURRENCY.** Prove concurrent appends (same task and different tasks) never lose an append and never overwrite. Attack it: hammer parallel writers; check count + ordering integrity. Serial-only tests do NOT discharge this — you must exercise concurrent writers.

## Deliverable
- Stress tests for both properties added as regression guards on your branch.
- If a property HOLDS: report "verified" with the tests as evidence.
- If a property BREAKS: report the exact failing scenario precisely; fix it ONLY if the fix is small and obvious, otherwise hand back a crisp bug report for the coder.
- Full suite green + tsc clean after your additions.

## Notes
- A Reviewer will gate after you. Drive to `[[HARK:HANDOFF]]` (or `[[HARK:DONE]]`) with a clear summary of what you verified/broke. The human owns the merge.
