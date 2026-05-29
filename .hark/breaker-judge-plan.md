# Design: replace the breaker's blunt no-progress kill with a Haiku stuck-judge

*Status: RESOLVED design, 2026-05-30. Owner: PM-head + human. Motivated by a live
false-positive: coder `agent-mprhkpdf-0d582f` was killed at 40 turns / 86k tokens
while doing legitimate, non-repeating research across 7 files — Trigger-2
(`DEFAULT_NO_PROGRESS_TURNS=40`) mislabeled front-loaded reading as a
"varied-probe spiral."*

## The core change
The breaker (`src/lib/orch/controller.ts`) has three triggers. Only Trigger-2
misfires. Keep the other two as auto-kill; give Trigger-2 a brain.

| Trigger | Today | After |
|---|---|---|
| 1. Signature repetition (same probe N×) | auto-block | **unchanged** — cheap, precise, correctly silent on real research |
| 2. No-commit streak (`DEFAULT_NO_PROGRESS_TURNS=40`, `…TOOL_CALLS=80`) | auto-block, label "varied-probe spiral" | **becomes the *trigger to invoke the judge*, not a verdict** |
| 3. Hard ceiling (`DEFAULT_HARD_TURN_CEILING=120` / token cap) | auto-block | **unchanged** — absolute runaway backstop; immune to a hung/wrong judge |

When the Trigger-2 streak fires, do NOT block. Instead invoke a cheap Haiku judge
on the worker's recent activity. The judge decides converging-vs-stuck; only a
stuck/drifting verdict escalates — and it escalates to the PM, it does not kill.

## The judge
- **How it runs:** a subprocess `claude -p "<prompt>" --model claude-haiku-4-5`
  (hark already shells out to the `claude` CLI to drive sessions — reuse that
  path; no new API-key wiring). Verify the exact invocation against how the
  server already spawns `claude`; if a direct Anthropic API call is already wired,
  use that instead. Time-box the call; on judge error/timeout, fall back to the
  OLD behavior (block) so a broken judge never makes the system *less* safe.
- **What it sees (bounded — never the raw growing transcript):** the task brief +
  a distilled activity view since the last commit (or last ~20 turns): the
  sequence of tool calls (name + target) and short assistant-text snippets. The
  capture-half instrumentation already records per-turn `tool_calls`
  (name/target/channel) in `metrics.db` — prefer reading that distilled stream
  over re-parsing the transcript. Honors the intent-from-transcript invariant.
- **Output (structured):** `{ verdict: "progressing" | "stuck" | "drifting",
  reason: "<one line>" }`. Prompt it with the distinction we learned: reading new
  files / new code toward the task = progressing; repeating probes, no new
  information, or wandering off the brief = stuck/drifting.

## Escalation (judge says stuck/drifting)
- Do NOT kill the worker and do NOT discard its worktree/context.
- Make it **visible + PM-woken, not terminal:** surface the worker as flagged in
  `hark orch status` with the judge's reason, and wake the PM once via the
  existing fire-once head-wake channel (`headWokeAt`, from the wake-up fix). The
  PM then intervenes: `hark agent send` to steer ("you've mapped enough — start
  writing"), or `hark agent stop` to confirm the kill.
- Pick the minimal mechanism for "flagged": a new non-terminal lifecycle value
  is fine if it's cleanly threaded through `isTerminalLifecycle` (protocol.ts),
  status rendering, and the reconcile loop — but a flagged-event + PM-wake that
  leaves lifecycle `running` is also acceptable for the MVP. Whatever you choose,
  the worker must NOT be auto-reaped on a flag.
- **MVP scope:** flag + escalate + keep-running (the hard ceiling still bounds any
  token leak between flag and PM response). True suspend/resume of the worker
  process is a deliberate FOLLOW-UP, out of scope here.
- If judge says **progressing:** reset the no-progress window baseline (re-arm
  Trigger-2 for the next streak) and let the worker run. Log a note event.

## Invariants / constraints
- Triggers 1 and 3 stay as immediate auto-kills — never gated on the judge.
- Judge failure/timeout → fall back to the current block behavior (fail safe).
- The judge runs ONLY when Trigger-2 already fired (cost-bounded — not per turn).
  Once flagged-and-escalated, do not re-judge until the PM acts or the hard
  ceiling trips.
- Keep all existing breaker tests green; the 7.6M-token varied-probe integration
  test must STILL trip (via signature/ceiling, or via the judge returning stuck).

## Acceptance criteria
- A worker that reads 7 distinct files for 40+ turns with no commit is judged
  **progressing** and is NOT killed (the regression that motivated this).
- A worker re-running varied no-op probes (the 7.6M case) is judged **stuck** (or
  caught by Trigger 1 / the ceiling) and the PM is woken.
- Judge error/timeout falls back to block; hard ceiling still trips regardless.
- Existing breaker suite stays green; tsc clean.
