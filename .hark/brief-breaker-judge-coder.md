# Implement: replace the breaker's Trigger-2 auto-kill with a Haiku stuck-judge

Board task: task-mpri2qfs-3184f9 (workstream: breaker-judge)
**Full spec — read it first: `.hark/breaker-judge-plan.md`** (resolved design).

## Why this exists (motivating bug)
The circuit-breaker just killed a coder at 40 turns / 86k tokens while it was
doing legitimate, non-repeating research across 7 files — Trigger-2
(`DEFAULT_NO_PROGRESS_TURNS=40`, no committed-diff) mislabeled front-loaded
reading as a "varied-probe spiral." A commit-counter can't tell convergent
research from a spiral. Give Trigger-2 a brain.

**START HERE:** a prior attempt built solid scaffolding before it was
interrupted. Re-apply it FIRST (see "## STARTING POINT" at the bottom — it adds
the `trigger` discriminator, the `flaggedAt`/`flaggedReason` window fields, and
the status-line field), commit it immediately, then continue with the judge.
The breaker thresholds have been relaxed for this work (no-progress turns=100,
turn ceiling=250, token ceiling now counts real non-cache tokens), so you have
ample runway — but still commit each piece as you go.

## Exact seams (so you can start writing fast — verify, then edit)
- `src/lib/orch/controller.ts`:
  - `~:146-147` — `DEFAULT_NO_PROGRESS_TURNS=40`, `DEFAULT_NO_PROGRESS_TOOL_CALLS=80`.
  - `~:156` — `DEFAULT_HARD_TURN_CEILING=120` (+ token ceiling).
  - `~:303-337` — the three triggers in `checkCircuitBreaker`: Trigger 3 (hard
    ceiling, checked first), Trigger 2 (no-commit streak — `:321-337`, the one to
    change), Trigger 1 (signature window).
  - Find where the caller consumes `{tripped, reason}` and flips lifecycle →
    `blocked` (the reaper then kills). Trigger-2 must stop flowing into that path.
- `src/server.ts` — where the controller/breaker is invoked from the reconcile
  loop; where the head is woken (`headWokeAt` fire-once, the wake-up fix). The
  judge call + PM escalation wire in here or in the controller as you see fit.
- The existing `claude` CLI spawn (grep for how the server launches `claude` to
  drive sessions) — reuse it for the judge subprocess
  (`claude -p "<prompt>" --model claude-haiku-4-5`). If a direct Anthropic API
  call is already wired, prefer that.
- `src/lib/orch/metricsDb.ts` — the capture-half `tool_calls`/`turns` tables hold
  the distilled per-turn activity (name/target/channel) to feed the judge. Prefer
  reading that over re-parsing the transcript.
- `src/shared/protocol.ts` — `isTerminalLifecycle` (single source of truth for
  terminal states) if you add a non-terminal "flagged" lifecycle.

## What to build (see the design doc for the full contract)
1. Trigger-2 streak fires → invoke a time-boxed Haiku judge on the bounded
   recent-activity view + task brief → structured
   `{verdict: progressing|stuck|drifting, reason}`.
2. `progressing` → reset the no-progress window baseline, let it run, log a note.
3. `stuck|drifting` → do NOT kill: surface the worker as flagged in `orch status`
   with the reason, wake the PM once (`headWokeAt`), keep the worktree+session.
4. Judge error/timeout → FALL BACK to the current block behavior (fail safe).
5. Triggers 1 and 3 stay immediate auto-kills — never gated on the judge.
6. Judge runs ONLY when Trigger-2 fired (cost-bounded); no re-judge until the PM
   acts or the hard ceiling trips.

## Acceptance criteria
- A worker reading 7 distinct files for 40+ turns with no commit is judged
  progressing and NOT killed (the motivating regression).
- A varied-probe spiral is judged stuck (or caught by Trigger 1 / the ceiling) and
  the PM is woken.
- Judge error/timeout → block (fail safe); hard ceiling still trips regardless.
- Existing breaker suite (70 tests) stays green; the 7.6M-token integration test
  STILL trips; `tsc` clean.

## Resilience + commit discipline (MANDATORY — and self-protective here)
- Run tool calls SEQUENTIALLY — never bundle writes + commits into one parallel
  batch (one failure cancels the whole batch and loses work).
- **Commit your first compiling scaffolding within your first few edits, then
  commit each logical piece immediately.** This is doubly important: the breaker
  you are fixing currently kills at 40 turns with no committed diff — frequent
  small commits both follow good practice AND keep you safely under that trigger
  while it still exists.
- If a single tool call fails, retry THAT call — do not re-batch.

Work in small commits on your isolated branch. Emit your terminal marker when the
implementation is committed and the test suite is green.

## STARTING POINT — recovered scaffolding (re-apply first, then commit)
A prior attempt produced these exact, correct additions before it was killed
mid-write. Re-create them as your FIRST step (re-type the edits — line numbers may
have shifted slightly), then `git commit` immediately, then continue with the
judge invocation + Trigger-2 gating + escalation + fallback + tests.

```diff
--- src/lib/orch/controller.ts
@@ export interface BreakerDecision {
   tripped: boolean;
   reason?: string;
+  // Which trigger fired (only meaningful when tripped). The controller gates ONLY
+  // `no_progress` on the stuck-judge; `signature` and `hard_ceiling` stay
+  // immediate auto-kills, never gated on a judge.
+  trigger?: "signature" | "no_progress" | "hard_ceiling";
   snapshot: BreakerState;
@@ export function decideCircuitBreaker(input: BreakerInput): BreakerDecision {
   const baseline = sigReset ? repeatCount : prior.baseline;
+  // The stuck-judge flag lives on the no-progress window: carry it forward while
+  // the window holds (committed diff unchanged), drop it the moment the window
+  // resets (worker advanced its diff -> resumed real progress). This makes
+  // "re-judge only once per window" and "clear the flag on recovery" fall out of
+  // the same reset the no-progress trigger already keys on.
+  const flaggedAt = progressReset ? undefined : prior?.flaggedAt;
+  const flaggedReason = progressReset ? undefined : prior?.flaggedReason;
   const snapshot: BreakerState = {
     ...
     progressTurns,
     progressToolCalls,
+    flaggedAt,
+    flaggedReason,
   };
   // tag each trigger return with its discriminator:
   if (turns >= hardTurnCeiling)   return { tripped: true, trigger: "hard_ceiling", ... };
   if (tokens >= hardTokenCeiling) return { tripped: true, trigger: "hard_ceiling", ... };
   //   ...and tag the signature return "signature" and the no-progress return "no_progress".

--- src/shared/protocol.ts
@@ export interface BreakerState {
   progressTurns?: number;
   progressToolCalls?: number;
+  // Set when the Haiku stuck-judge flagged this worker (verdict stuck/drifting)
+  // after the no-progress trigger fired. The worker is NOT killed on a flag — it
+  // stays `running`, surfaced in `orch status` with `flaggedReason`, the PM woken
+  // once. Both fields live on the no-progress window so they CLEAR the moment that
+  // window resets (committed diff moved -> real progress). While set they also gate
+  // re-judging: the judge runs only once per no-progress window.
+  flaggedAt?: number;
+  flaggedReason?: string;
 }
@@ export interface AgentStatusLine {
   reason?: string;
+  // The Haiku stuck-judge's reason when a still-RUNNING worker has been flagged.
+  // Distinct from `reason` (terminal): a flagged worker keeps running, so the PM
+  // sees the flag and can steer or stop it. Cleared once the worker resumes
+  // committed progress.
+  flaggedReason?: string;
 }
```
