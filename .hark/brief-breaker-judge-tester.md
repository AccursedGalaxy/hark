# Test: independently verify + harden the breaker stuck-judge

Board task: task-mpri3mq5-0614dd (workstream: breaker-judge)
You are testing a coder's completed implementation. **Do NOT modify the
implementation** — if you find a real bug, report it in your terminal summary
(it becomes a coder redirect), don't fix it yourself.

## FIRST — get onto the coder's branch (hand-wired handoff)
Your worktree was cut from `origin/main`, but the work to test lives on the
coder's branch `hark/pm-hark/coder-7cba42` (same git repo, shared object store).
Pull it into your worktree before doing anything else:

```
git reset --hard hark/pm-hark/coder-7cba42
git log --oneline -5    # confirm you see: 2fe83d4, c6e73fa, d6546e9, ed6f901
```

Then add your test commits on top of that.

## What the change does (so you know what to attack)
Replaces the breaker's Trigger-2 (no-commit streak) auto-kill with a Haiku
stuck-judge. On a `no_progress` trip the controller calls a time-boxed
`claude -p --model claude-haiku-4-5` judge over a bounded recent-activity view:
- `progressing` → re-arm the no-progress window, log a note, keep running;
- `stuck`/`drifting` → record `flaggedReason`, wake the PM once, **keep running**
  (NOT killed);
- judge error / timeout / unparseable verdict → **fall back to the original
  block** (fail safe).
Triggers 1 (signature) and 3 (hard ceiling) are unchanged immediate auto-kills,
never consult the judge. The flag lives on the no-progress window so it clears
when the committed diff moves (recovery).

## Verify first, then harden
1. Run the FULL suite (`npm test`) + both `tsc` runs (server + web) — confirm
   green from a clean checkout of the coder's branch. Report the count.
2. Then add ADVERSARIAL tests (the coder wrote 21; find the gaps). Target:
   - **Fail-safe**: judge throws / times out / returns garbage / empty stdout →
     the worker is BLOCKED (original behavior), never silently let-run.
   - **Recovery**: a flagged worker whose committed diff then moves → flag
     CLEARS (`flaggedAt`/`flaggedReason` undefined) on the next tick.
   - **Judge-once-per-window**: across consecutive ticks within the same
     no-progress window, the judge is invoked at most once (no re-judge spam).
   - **Isolation**: a `signature` trip and a `hard_ceiling` trip NEVER call the
     judge (assert the judge dep is not invoked).
   - **The motivating regression**: a long multi-file *reading* trajectory →
     judge returns `progressing` → worker NOT killed.
   - **Escalation**: a `stuck`/`drifting` verdict wakes the PM exactly once and
     leaves the worker `running` with `flaggedReason` set + surfaced in status.
3. If any test reveals a real defect, STOP and report it — don't patch the impl.

## Acceptance
- Full suite green on the coder's branch + your additions; `tsc` clean (both).
- Your new adversarial tests genuinely exercise the branches above (not
  tautological — each must be able to fail if the impl regressed).

## Resilience (MANDATORY — flaky tool IO)
- Run tool calls SEQUENTIALLY; never bundle writes + commits into one batch.
- Commit each logical group of tests immediately after writing it.
- Retry a single failed call rather than re-batching.

Emit your terminal marker when your tests are committed and the suite is green
(or when you've found a defect to report).
