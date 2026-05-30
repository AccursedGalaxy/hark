# Session Retrospective — First Genuine Autonomous PM-Head Sprint

**Date:** 2026-05-30 (active ~04:00–05:40 local, then idle-watch until ~12:50)
**Driver:** PM-head session `pm-head-harness`, autonomy **L2 (supervised-auto)**
**Trigger:** User went to sleep, instructed the PM-head to run the backlog autonomously
overnight and dogfood the orchestration harness on hark's own work.
**Scope:** This is hark's *first* end-to-end autonomous orchestration run — one PM-head
dispatching a fleet of role workers (coder/tester/reviewer/researcher) with no human in
the loop, driving each to an open PR. Captured here as a baseline dataset for future
automated runs: per-worker metrics, outcomes, failure taxonomy, and prompt/process nudges.

---

## Headline outcomes
- **17 workers** spawned (12 coder, 3 researcher, 2 tester, 1 reviewer... see roster).
- **9 PRs opened** (#30–#38). 8 clean/mergeable; **#37 (lazy-branch) flagged needs-rework**
  after its own review chain caught 2 blocking defects.
- **3 research/design briefs** (Agent-SDK migration, lazy-branch fix-plan, Layer-2 spec).
- **1 adversarial review** that found 2 real blocking defects before merge.
- **~1,157 worker-turns** and **~10.9M worker tokens** total (head session: +408k).
- **Zero merges** — every landing left to the human, as designed.

## ⭐ The headline finding: fidelity failures dominate cost
The four troubled workers consumed **~9.6M of ~10.9M tokens (≈87%)** yet produced only 2
salvageable PRs and 2 total losses. The eleven clean workers + researchers that produced
**7 PRs + 4 briefs + 1 review used ~1.4M combined.**

| Class | Token range | Example |
|-------|-------------|---------|
| Clean coder run | 40k–134k | issue-#13 (48k), Alt+Enter redo (40k), head-cmd (66k) |
| Research brief | 38k–104k | Agent-SDK (76k), fix-plan (104k) |
| **Wedged / spiraling** | **1.0M–3.2M** | cancel-cascade (3198k), silent hang (3063k), NO_PROGRESS spiral (2313k) |

**Implication:** harness fidelity is not only a quality lever — it is the dominant **cost**
lever. A single wedge costs 20–50× a clean run. Every fidelity fix shipped tonight
(#30–#33) pays back in tokens, not just reliability. This is the strongest quantitative
case yet for the "harness fidelity is the bottleneck" North Star.

---

## Full worker roster (the dataset)

| # | Agent ID | Role | Turns | Tokens | Outcome | Artifact |
|---|----------|------|------:|-------:|---------|----------|
| 1 | mprp3rg5-372c12 | coder | 41 | 89k | DONE | **PR #30** pmGuard heredoc-as-reads |
| 2 | mprpc8jr-883ba2 | coder | 73 | **3198k** | BLOCKED — cancel-cascade (18 cancelled/errored), 0 commits | — (re-dispatched as #5) |
| 3 | mprpcb0m-d9e448 | coder | 114 | 1006k | STOPPED — silent end-of-run hang, work salvaged | **PR #32** deny Task/Agent tools |
| 4 | mprpcdfz-cfcdb1 | coder | 159 | **3063k** | STOPPED — silent end-of-run hang, work salvaged | **PR #33** metrics-db best-effort |
| 5 | mprqge35-b5f620 | coder | 39 | 73k | DONE (retry of #2) | **PR #31** worktree origin-base diff |
| 6 | mprqha37-3c6abb | coder | 61 | 66k | DONE | **PR #34** repo-owned /head + installer |
| 7 | mprqr1pm-2585e9 | coder | 39 | 48k | DONE | **PR #35** thinking-time format (issue #13) |
| 8 | mprqr49x-4099fa | researcher | 38 | 76k | DONE | Brief: Agent-SDK migration (PARTIAL, spike-gated) |
| 9 | mprqr6u1-b6c566 | tester | 41 | 51k | HANDED OFF — **work uncommitted, lost** | — (re-dispatched as #11) |
| 10 | mprqr9bv-47c99b | coder | 130 | 134k | DONE (handed off) | **PR #37** lazy-branch-at-handoff *(needs rework)* |
| 11 | mprr02xi-669cd7 | coder | 31 | 40k | DONE (redo of #9, committed) | **PR #36** Alt+Enter guard + helpers |
| 12 | mprr4aq5-a31a13 | coder | 100 | **2313k** | BLOCKED — NO_PROGRESS spiral, 0 commits | — (re-dispatched as #15) |
| 13 | mprr6otb-bfdaba | tester | 62 | 72k | HANDED OFF — committed test, but forked off main (see depends-on finding) | integration test + tripwire |
| 14 | mprr6rae-522a06 | reviewer | 54 | 98k | DONE | Review: found **B1 TOCTOU + B2 stale-origin-fork** in #37 |
| 15 | mprriy7w-c99000 | coder | 77 | 52k | DONE (retry of #12, committed) | **PR #38** spawn-echo + tmux window names |
| 16 | mprrqhfp-09ba1f | researcher | 49 | 104k | DONE | Brief: lazy-branch B1/B2 fix-plan (file:line precise) |
| 17 | mprrqjyr-7b35f3 | researcher | 49 | 457k | DONE | Brief: Layer-2 reconciliation detector design spec |

Raw transcripts: `~/.claude/sessions/<session-id>.json(l)`. Per-tool-call transport
classification: the schema-v3 `turns`/`tool_calls` tables (Layer-1 detector, PR #29) —
joinable on agent/session id for the next level of analysis.

---

## Failure taxonomy (3 distinct fidelity modes, now evidenced not inferred)
1. **Cancel-cascade wedge** (#2, 883ba2) — one tool error cascades into "Cancelled" on
   every later call. The breaker (286172d) caught it at the cliff (18 errors) instead of
   the original 206-turn spiral. *The fix works, observably.* Re-dispatch succeeded clean.
2. **Silent end-of-run hang** (#3, #4) — worker finishes the code (commits land) but the
   session hangs before emitting DONE. The error-cascade breaker does **not** catch this
   (no errors, just a quiet freeze). Detected only by turn-count staying identical across
   polls. Work salvaged via `hark agent stop` + PR from the committed branch.
3. **NO_PROGRESS spiral** (#12, a31a13) — 100 turns of varied probing, never commits, the
   breaker's no-progress trigger reaps it. Burned 2.3M tokens for nothing.

Open detector gap: there is no live signal for mode #2 (silent hang). Worth a watchdog on
turn-count stalls, distinct from the error-cascade trigger.

---

## Process / prompt-quality nudges (actionable for next runs)
- **Tell every worker to COMMIT.** Tester #9 did a real refactor + 8 tests and never
  committed — `hark agent diff` was empty and the work died with its pane. Re-dispatched
  with an explicit commit instruction → became PR #36. Fix at the source: make worker
  roles auto-commit before emitting DONE, *or* bake "commit your work" into every brief.
- **Commit-early defeats the NO_PROGRESS false-positive.** The lazy-branch impl (#10)
  survived 130 turns only because its brief said "commit a WIP scaffold early." A prior
  attempt (historical 0d582f) was false-positive-reaped at 40 turns of legit research.
  Adding "if you're reading many files without writing code, commit a minimal slice" to
  research-heavy coder briefs measurably helped.
- **Keep angle brackets out of briefs.** A dispatch was blocked by the pure-PM guard
  because the brief text contained literal `<role>`/`<id>` — read as tree-redirections
  (PR #30 fixes that class for `<<`, but `>` in prose still trips it). Phrase briefs in
  plain words.
- **Retry transient wedges, don't redesign.** Both #2 (cancel-cascade) and #12 (spiral)
  succeeded on a clean re-dispatch of the *same* brief. The wedge was the worker, not the
  task. Cheap retry beats re-scoping.
- **`--depends-on` is metadata-only today** — see finding below. Until lazy-branch lands,
  a depends-on review chain must be told to `git fetch` the upstream branch explicitly,
  or use `hark orch set-base`.

## The poetic blocker
The lazy-branch test+review chain was spawned `--depends-on` the impl — but `--depends-on`
is metadata-only today: dependents fork off `orch.baseRef` (main), **not** the upstream's
HEAD. So tester #13 reviewed *main*, didn't see the impl, and concluded "feature
unimplemented" — the exact bug the impl fixes. The reviewer (#14) only succeeded because it
hunted down the diff manually. **The harness's own missing feature blocked it from
reviewing the fix for that feature.** (Board: `task-mprrgqkz`. The fix is PR #37 +
`task-mprrgqi8`.)

---

## Follow-up: make this capture automatic
This retrospective was assembled by hand from `hark orch status --all`. The data that
matters most for improving prompts and triaging issues — per-worker turns, tokens,
outcome, transport-classified tool-call record — already lives in the schema-v3 metrics
store. A `hark session report [--since <run>]` that emits exactly this table (+ the cost
breakdown and failure taxonomy) at the end of an autonomous run would turn every future
sprint into a labeled dataset for prompt/quality iteration. Tracked on the board.
