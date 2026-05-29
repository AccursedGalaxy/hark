# Implement: lazy-branch downstream worktree off upstream HEAD at handoff

Board task: task-mprhjuiy-782a28 (workstream: depends-on-handoff)

## Problem
The orchestrator already supports a `dependsOn` field on `OrchAgent` (stored,
threaded through `spawnAgent`), so a downstream worker can be spawned
`--depends-on <upstreamAgentId>`. BUT the downstream worktree is still cut from
`baseRef` (the pristine base), so a depends-on tester sees clean base — NOT the
upstream coder's diff. And today the `[[HARK:HANDOFF]]` / `[[HARK:DONE]]` marker
only flips the upstream's lifecycle to `review`; it moves no code to the
downstream.

## Goal
When an upstream worker that HAS downstream dependents hits a handoff/done
terminal marker AND has committed work on its branch, lazily create (or
re-point) each waiting downstream worker's worktree so it branches off the
UPSTREAM's branch HEAD — not off `baseRef`. So a tester spawned
`--depends-on <coder>` actually sees the coder's diff when it starts.

## Constraints / invariants (do not violate)
- **One worktree per agent — NEVER share a live tree.** Each downstream gets its
  OWN worktree branched off the upstream branch HEAD.
- **Lazy:** the downstream's real worktree is created/re-pointed at handoff time
  (when upstream has committed), not at spawn time. A downstream spawned before
  its upstream commits must WAIT (stay pending) rather than fork pristine base.
- **Idempotent + fire-once under the 3s reconcile loop** — branch-off fires once,
  not every tick. Mirror the existing `killedAt` / `headWokeAt` fire-once record
  patterns rather than inventing a new mechanism.
- **Best-effort fallback:** if the upstream has NO commits at handoff, fall back
  to current behavior (base fork) with a clear note/event — do NOT crash.
- **Zero regression** to existing single-worker / no-dependents behavior.

## Acceptance criteria
- A coder→tester chain where the tester is spawned `--depends-on <coder>`: after
  the coder commits and emits `[[HARK:HANDOFF]]` (or `[[HARK:DONE]]`), the
  tester's worktree HEAD is the coder's branch tip — tester `git log`/diff shows
  the coder's commits as its base, and tester edits stack on top.
- A unit/integration test proving (a) the downstream worktree base == upstream
  branch HEAD at handoff (not `baseRef`), and (b) the re-branch fires ONCE (no
  repeated re-branch on subsequent reconcile ticks).
- Existing tests stay green; `tsc` clean.

## Where to look (locate exact code yourself)
- The `dependsOn` field on `OrchAgent` + its threading through `spawnAgent`.
- Worktree creation: `addWorktree` / `resolveWorktreeBase` (worktree.ts).
- The marker → lifecycle transition (`[[HARK:HANDOFF]]`/`[[HARK:DONE]]` → `review`)
  in the reconcile loop / controller, and the fire-once records already there.

## Resilience (MANDATORY — this environment has flaky tool IO)
- Run tool calls **SEQUENTIALLY**. Do NOT bundle writes + commits into one
  parallel batch — one failure cancels the whole batch and loses your work.
- Commit each logical piece **immediately** after writing it.
- If a single tool call fails, retry THAT call — do not re-batch.

Work in small commits on your isolated branch. When the implementation is
committed and tests are green, emit your terminal marker.
