# Brief: Breaker hardening — progress-based tripping + hard ceiling

## Resilience header (read first)
Tool IO in this environment is intermittently flaky: blank / dropped / duplicated tool results, occasional write errors, and parallel-batch cascade-cancellation (one failed call in a batch voids the whole batch, losing all of it). To survive it:
- Run tool calls SEQUENTIALLY. Do NOT bundle multiple writes/commits into one parallel batch — one failure cancels all and you lose work.
- Commit each logical piece IMMEDIATELY once it's green. Small, frequent commits.
- If a single call returns blank or errors, RETRY that ONE call. Never re-issue the whole batch.
- Use `/usr/bin/git` for git.

## Intent
The runaway circuit-breaker (`src/lib/orch/controller.ts`) currently trips on N CONSECUTIVE IDENTICAL no-op command signatures. A live worker spiraled to **147 turns / 7.6M tokens with ZERO commits and never tripped**, because its probe commands were VARIED (different greps/echoes/tmp round-trips) — the signature heuristic slid right past. The breaker is the safety component that makes unattended saturation safe; a signature-blind breaker means an unattended run is just a more expensive spiral. This is the long pole for everything downstream.

## Scope
1. **Progress-based tripping (signature-INDEPENDENT).** Trip on N turns / K tool calls with NO new commit AND no diff change against the worker's progress baseline. The breaker already tracks a `progressKey` baseline — key the trip off ACTUAL progress (commits + diff), not command signature. This catches the varied-probe spiral the current heuristic misses.
2. **Hard per-worker ceiling.** A token/turn ceiling that trips REGARDLESS of progress — a final backstop so no worker can burn unbounded even if every other heuristic is fooled.
Keep the existing signature-based trip as ONE trigger among several (do not regress it); add these as additional, independent triggers. On trip: flip the worker to `blocked` with a clear reason; the existing reaper kills it.

## Adversarial concerns to address head-on (a Reviewer will probe these SPECIFICALLY)
- **False-negative path:** is there ANY way a worker burns significant tokens without tripping a single trigger? Walk it explicitly and close it.
- **Interaction between the no-progress rule and the hard ceiling:** can a worker sit JUST under both — e.g. occasionally committing a trivial/no-op change to reset the progress baseline while burning tokens between commits? Strongly consider keying "progress" on meaningful DIFF change, not merely commit count, so a no-op commit can't launder a spiral.

## Acceptance criteria
- Unit tests for: (a) a VARIED-probe no-progress spiral now TRIPS (the 7.6M scenario); (b) a worker making real progress (commits + diff advancing) does NOT trip (no false positive); (c) the hard ceiling trips a worker sitting just under every other threshold.
- tsc clean; full suite green; small, frequent commits.

## Notes
- A Reviewer will follow on your branch, briefed adversarially on the false-negative path. Write your tests to pre-empt it.
- Intent-level brief: find the breaker logic in `controller.ts` and its tests yourself.
- Drive to an open PR (`hark pr`). The human owns the merge.
