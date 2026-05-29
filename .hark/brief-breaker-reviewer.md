# Brief: Reviewer — breaker hardening, adversarial on the false-negative path

## Resilience header (read first)
Tool IO here is intermittently flaky: blank / dropped / duplicated results, occasional write errors, parallel-batch cascade-cancellation. Run tool calls SEQUENTIALLY; retry a SINGLE failed call rather than re-batching; use `/usr/bin/git`.

## What you are reviewing
Branch **`hark/pm-hark/coder-d64f0b`** — hardening of the runaway circuit-breaker (`src/lib/orch/controller.ts`, `controller.test.ts`, `src/shared/protocol.ts`). Inspect it with `/usr/bin/git diff main...hark/pm-hark/coder-d64f0b` (or check it out read-only). You are READ-ONLY — review and produce a verdict, do not land.

## Why this review matters more than usual
The breaker is the ONE safety component whose failure mode is silent and unattended: a bad task-store throws errors you see immediately; a breaker that fails to trip is invisible until a worker has burned millions of tokens. It is also self-referential — it is the thing meant to catch a spiral, so if its own logic is wrong, nothing above it catches that during an unattended run. So your job is not "does it look reasonable" — it is to find the path where it SILENTLY fails to trip.

## Hunt these specifically (adversarial — assume there IS a hole)
1. **False-negative path.** Is there ANY sequence where a worker burns significant tokens/turns without tripping a single trigger (signature, progress-based, or the hard ceiling)? Construct it concretely or prove it's closed.
2. **No-op-commit laundering.** Can a worker reset the progress baseline with a trivial/empty commit while spiraling between commits? Verify "progress" is keyed on MEANINGFUL diff change, not mere commit count. If it's commit-count-based, that's a finding.
3. **Threshold-straddling.** What's the interaction between the no-progress rule and the hard token/turn ceiling — can a worker sit JUST under both simultaneously and still burn? Walk the boundary.
4. **The 7.6M scenario.** Is there a test that actually reproduces the original miss (147 turns, varied probes, zero commits) and proves it NOW trips? If not, that's a gap.

## Deliverable
A crisp verdict: **APPROVE** (with the false-negative path explicitly walked and closed) or **CHANGES REQUESTED** (each finding concrete + reproducible). Hand back via `[[HARK:HANDOFF]]`/`[[HARK:DONE]]` with the verdict in your summary. The human owns the merge.
