Harden the harness against the flaky-tooling SPIRAL that just burned a worker to 147 turns / 7.6M tokens / ZERO commits without the circuit-breaker ever tripping. Two deliverables — COMMIT EACH SEPARATELY, in the order below (so a transient failure can't cost you both).

## IMPORTANT — you are building the anti-spiral fix; do not spiral yourself
The tool IO in this environment is currently flaky: blank/dropped/duplicated tool output, occasional `Error writing file`, and — most destructive — PARALLEL TOOL BATCHES where one failed call cancels the WHOLE batch (including git commits). So:
- Run tool calls SEQUENTIALLY. Do NOT bundle many writes/commits/checks into one parallel batch.
- git-commit each deliverable IMMEDIATELY after it's done, before starting the next.
- On a blank or errored tool result, retry that ONE call — don't re-issue a batch.
Locate code yourself; verify against current `main` (#22/#23 merged).

## DELIVERABLE 1 (do FIRST, commit alone) — worker tooling-resilience defaults in the role prompt
Find where the worker/coder role system prompt is built (likely `src/lib/orch/roles.ts`). Add a tight block (a few lines, matching the existing prompt voice) that EVERY worker receives:
- Run tool calls SEQUENTIALLY rather than bundling many into one parallel batch — in this harness a single failed call cancels the entire parallel batch, so bundling writes + git commits together risks losing all work.
- git-commit each logical piece IMMEDIATELY after creating/editing it, so a transient tool failure costs only the current step.
- On a blank/errored tool result, retry that single call rather than re-issuing a batch.
Commit this first — it's small and high-value; bank it before the harder change.

## DELIVERABLE 2 (commit separately) — progress-based breaker + hard ceiling
Today the circuit-breaker (`src/lib/orch/controller.ts`, `BreakerState` in `src/shared/protocol.ts`) trips on N consecutive IDENTICAL no-op command signatures. It MISSED the real runaway above because the worker's probe commands were VARIED (different greps/echoes/`/tmp` round-trips), evading the identical-signature check.
- Make the breaker PROGRESS-based: trip when a worker has gone N turns (or K reconcile ticks / tool calls) with NO new commits AND no diff change — regardless of whether commands repeat. Use commit-count + diffstat as the progress signal (`branchGitSummary` in `worktree.ts` already computes both); the breaker already tracks a progress baseline (`progressKey`/`baseline`) — extend it.
- ADD a hard ceiling: if a worker exceeds a max-turns OR max-token budget, trip regardless. Pick sensible named constants well below the 7.6M-token disaster (document them). A worker must never silently burn millions of tokens.
- KEEP the existing identical-signature trip too (defense in depth) — this ADDS the progress + ceiling triggers, it does not remove the old one.
- On any trip, flip lifecycle to `blocked` with a clear reason string (e.g. "circuit-breaker: no progress in N turns" / "circuit-breaker: turn/token ceiling"); the existing reconcile reaper handles termination. The reason must persist on the record (the `blockedReason`/`summary` fields exist) so it surfaces in status/notification.

## Acceptance / constraints
- Unit tests (vitest): breaker trips on no-progress-over-N with VARIED commands + no commits/diff change; does NOT trip when commits or diff advance; trips on the hard turn/token ceiling; the existing identical-signature behavior still works; role-prompt guidance is present.
- Do NOT touch PLAN.md (PM-owned). `npm test` green + tsc clean. Small, separate commits (Deliverable 1, then 2).
- Emit the DONE marker with a concise summary: what changed in the role prompt, the new breaker triggers + chosen constants, files touched.
