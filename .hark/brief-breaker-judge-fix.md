# Fix: prevent duplicate judge invocation + duplicate PM escalation under overlapping reconcile ticks

Board task: task-mpri2qfs-3184f9 (workstream: breaker-judge) — a reviewer-approved
fast-follow on the stuck-judge you'll find already on the branch.

## FIRST — get onto the approved branch
The impl + all tests + review live on `hark/pm-hark/tester-d3d520`. Pull it into
your worktree, then add your fix on top:

```
git reset --hard hark/pm-hark/tester-d3d520
git log --oneline -8     # impl (ed6f901,d6546e9,c6e73fa,2fe83d4) + tester commits
npm test                 # confirm green (~810) before changing anything
```

## The defect (precise, from the reviewer)
`reconcileOrchestrations` (`src/server.ts:~2024`) runs on a bare
`setInterval(…, 3000)` with NO in-flight guard. `checkCircuitBreaker` now persists
`flaggedAt` only AFTER the judge subprocess resolves (2–5s, up to the 30s ceiling).
While that `await` is outstanding, an overlapping reconcile tick re-enters for the
SAME agent, still sees `flaggedAt == null` (the guard at `controller.ts:~1049`),
and launches a DUPLICATE judge subprocess → DUPLICATE PM escalation for one
no-progress window. Not safety-breaking (never a wrong kill/spare) but it
undercuts the feature's whole point — judicious, once-per-window PM paging.

## Fix (pick the cleaner of the reviewer's two options)
- **Preferred — in-flight guard:** track agents with a judge call currently
  outstanding (e.g. an in-memory `Set<agentId>` in the controller); if an agent
  is already being judged, the re-entrant tick skips (does nothing) rather than
  launching a second judge. Clear the entry in a `finally`.
- **Alternative — optimistic flag:** persist `flaggedAt` BEFORE awaiting the
  judge so a concurrent tick's `flaggedAt != null` guard short-circuits; then if
  the verdict is `progressing`, CLEAR `flaggedAt` (re-arm) and if `stuck/drifting`
  fill `flaggedReason`. (Careful: this path must still clear correctly on a
  `progressing` verdict — don't leave a worker spuriously flagged.)

Whichever you choose, preserve ALL existing behavior: fail-safe still blocks on
judge error, triggers 1+3 still never consult the judge, the flag still clears on
committed-diff recovery, and the terminal PM wake (`headWokeAt`, separate from
`flaggedAt`) is untouched.

## Acceptance
- A NEW regression test that reproduces the concurrency: two overlapping
  `checkCircuitBreaker` invocations for the same agent while the first judge
  `await` is still outstanding → the judge is invoked **once** and the PM is
  escalated **once**. It must fail against the current code and pass with your fix.
- Full suite green (≥810 + your test); both `tsc` runs clean.

## Resilience (MANDATORY — flaky tool IO)
Run tool calls sequentially; commit each logical piece immediately; retry a single
failed call rather than re-batching.

Emit your terminal marker when the fix + test are committed and the suite is green.
