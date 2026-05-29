# Brief: Focused Reviewer — verify the board's SF-1/SF-2 fixes are genuinely closed

## Resilience header (read first)
Tool IO here is intermittently flaky: blank / dropped / duplicated results, occasional write errors, parallel-batch cascade-cancellation. Run tool calls SEQUENTIALLY; retry a SINGLE failed call rather than re-batching; use `/usr/bin/git`.

## Scope — NARROW. Do not re-review the whole branch.
Branch **`hark/pm-hark/coder-53e509`** is the board core. Its v1 architecture + the two headline properties (upsert idempotency; task_events append-only/lossless under concurrency) were ALREADY independently reviewed and APPROVED — do NOT re-litigate them. Your job is ONLY to verify that two SHOULD-FIX findings, fixed by the same coder who then graded their own fix, are GENUINELY closed (not just green). A coder self-grading a foundational fix is exactly where a green-but-wrong test hides. Inspect with `/usr/bin/git diff main...hark/pm-hark/coder-53e509`, focusing on the fix commits and their tests.

## Verify SF-1 — schema migration path (the source-of-truth durability promise)
The finding: the constructor stamped `user_version` UNCONDITIONALLY with no migration path, so the "migrate-not-rebuild" SoT promise would break at the first schema bump.
- Confirm the fix is a REAL forward-migration path: read current `user_version` → run ordered migrations up to target → stamp only after. Not a no-op, not a rebuild-in-disguise, not a stamp-without-migrating.
- Confirm the test actually proves it: opens a db at version N WITH REAL ROWS, bumps schema to N+1, asserts the rows SURVIVE and the new shape is present. A test that creates a fresh db and checks the version does NOT discharge this.

## Verify SF-2 — transaction-wrapped read-modify-write (concurrency safety)
The finding: `setTask`/`link` read-modify-write wasn't transaction-wrapped → lost-update race; load-bearing once the reconciliation layer writes concurrently.
- Confirm each read-modify-write is genuinely atomic now — a real transaction (or atomic upsert) that SERIALIZES concurrent writers, not just a transaction that wraps a read with no write-conflict protection.
- Confirm the test exercises REAL concurrency (multiple actual concurrent writers on the same task) and would actually CATCH a lost update — i.e. it would fail against the pre-fix code. A serialized "concurrent" test that never races does not discharge this.

## Deliverable
A crisp verdict per fix: **CLOSED** (with the specific evidence — the migration evolves data, the txn serializes writers, the tests would catch the original bug) or **NOT CLOSED** (concrete reason + what's still open). Hand back via `[[HARK:HANDOFF]]`/`[[HARK:DONE]]` with both verdicts in your summary. READ-ONLY — do not land. The human owns the merge.
