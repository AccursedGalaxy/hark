# Review: adversarial review of the breaker stuck-judge before merge

Board task: task-mpri3msy-3fd6fd (workstream: breaker-judge)
You are the final gate before this merges. **Read-only on the implementation** —
produce a verdict (APPROVE, or a list of blocking issues), don't edit code.

## FIRST — get onto the branch under review
Your worktree was cut from `origin/main`. The full work (coder impl + tester's
adversarial tests) lives on `hark/pm-hark/tester-d3d520` (same repo, shared
objects). Pull it in:

```
git reset --hard hark/pm-hark/tester-d3d520
git log --oneline -8     # coder: ed6f901,d6546e9,c6e73fa,2fe83d4 + tester commits
npm test && (cd . && npx tsc --noEmit)   # confirm green before reviewing
```

Review the cumulative diff vs `origin/main`.

## What it does
Replaces the breaker's Trigger-2 (no-commit streak) auto-kill with a time-boxed
Haiku judge (`claude -p --model claude-haiku-4-5`) over a bounded recent-activity
view. `progressing` → re-arm + keep running; `stuck`/`drifting` → flag
(`flaggedReason`) + wake PM once + keep running; judge error/timeout/garbage →
fall back to the original block (fail safe). Triggers 1 (signature) and 3 (hard
ceiling) are unchanged immediate auto-kills, never consult the judge.

## Walk these failure paths adversarially (the high-risk surfaces)
1. **Fail-safe is truly safe**: every judge failure mode (throw, timeout,
   non-zero exit, empty/garbage/unknown-verdict stdout) must end in BLOCK, never
   silently keep a worker running. A judge that hangs must not hang the reconcile
   tick (confirm the 30s time-box actually bounds it).
2. **Trigger isolation**: prove `signature` and `hard_ceiling` trips return
   immediately WITHOUT invoking the judge. A judge call on those paths would be a
   regression (cost + latency on a hard runaway).
3. **Flag lifecycle**: `flaggedAt`/`flaggedReason` set on stuck/drifting; cleared
   the moment the committed diff moves (recovery); judge invoked at most once per
   no-progress window (no re-judge spam each tick).
4. **Escalation correctness**: the once-per-window guard uses `flaggedAt`, NOT
   `headWokeAt` — verify a flagged-then-finished worker STILL wakes the PM on its
   terminal transition (i.e. flagging doesn't suppress the terminal wake).
5. **Subprocess safety**: the judge prompt embeds transcript-derived text — check
   it's passed as an argument/stdin to `claude` (not interpolated into a shell
   string), so worker output can't inject a command. Confirm `execFile` (not
   `exec`) and that a large transcript can't blow the arg limit / is bounded.
6. **Intent-from-transcript invariant**: the activity view comes from the
   assistant-side `tool_use` blocks the controller already reads, never a
   self-report — and it's bounded (last ~N turns), not the whole transcript.
7. **Test quality**: spot-check that the new tests are NOT tautological — each
   should fail if the corresponding branch regressed.

## Verdict
End with a clear **APPROVE** (and a one-line note on confidence) or a numbered
list of **BLOCKING** issues (file:line + why). If you find a real defect, it
becomes a coder redirect — describe it precisely; do not fix it.

## Resilience (MANDATORY — flaky tool IO)
Run tool calls sequentially; retry a single failed call rather than re-batching.

Emit your terminal marker with your verdict.
