You are an INTEGRATOR. Goal: produce ONE clean branch, based on the current `main` tip, that contains the runaway circuit-breaker work from branch `hark/pm-hark/coder-733cdf` fully integrated with the harness-reliability features already on `main` (PR #20). BOTH feature sets must survive and coexist.

CONTEXT — what each side did:
- `main` (PR #20, already merged) added: a new terminal `stopped` lifecycle + an `isTerminalLifecycle` predicate in `src/shared/protocol.ts`; `Orchestrator.stopAgent` (SIGTERM + flip lifecycle, reuses `killTerminalAgent`) in `src/lib/orch/orchestrator.ts`; an `orch status` terminal-worker hide filter; and reconcile-loop changes in `src/server.ts`.
- Branch `hark/pm-hark/coder-733cdf` adds a runaway circuit-breaker: new files `src/lib/orch/breaker.ts` + `src/lib/orch/breaker.test.ts` (these do NOT conflict), plus edits to `src/shared/protocol.ts`, `src/lib/orch/orchestrator.ts`, and `src/server.ts` that DO conflict with #20. The breaker detects N consecutive identical no-op commands and flips the worker's lifecycle to `blocked` with a reason string; the reconcile loop then reaps it.

STEPS:
1. Your worktree is already branched off the current `main` (it includes #20). Merge the breaker branch into it: `git merge hark/pm-hark/coder-733cdf`.
2. Resolve the conflicts in the three files so BOTH features coexist:
   - `src/shared/protocol.ts`: KEEP #20's `stopped` lifecycle + `isTerminalLifecycle`, AND keep B's circuit-breaker additions (e.g. the blocked-reason field/types). `blocked` must remain classified terminal by `isTerminalLifecycle`.
   - `src/lib/orch/orchestrator.ts`: KEEP `stopAgent`/`killTerminalAgent`, AND wire in B's breaker integration.
   - `src/server.ts`: the reconcile loop must do BOTH — SIGTERM terminal workers (including `stopped`) AND run the breaker check that flips a spiraling worker to `blocked`. A worker the breaker flips to `blocked` must then be reaped by the existing terminal-kill path (don't double-kill; reuse the single terminal path).
3. PLAN.md is PM-owned: if the breaker branch modified PLAN.md, DISCARD that change and keep `main`'s version. Your branch must contain NO PLAN.md edits.

CONSTRAINTS:
- Final result = a single coherent branch off current `main`, both features working.
- `npm test` green (including `breaker.test.ts` and #20's tests) + tsc + build clean before you finish.
- Commit the resolution with a clear message. Emit the DONE marker with a concise summary of how you resolved each conflicted file.
