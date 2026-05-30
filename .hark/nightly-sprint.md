# Nightly Autonomous Sprint — Playbook

**Authored:** 2026-05-30 ~03:49 by PM-head session (pm-head-harness), user asleep.
**Fires:** ScheduleWakeup at ~04:29. User cannot reply until morning — make every
call yourself, escalate nothing, **never land/merge** (PRs only; human owns merge).

This is the deterministic dispatch plan. On each wake-up: read this file, run
`hark orch status`, harvest finished workers (review diff → `hark pr` → close board
task), then dispatch the next wave. Re-arm `ScheduleWakeup` (~1200–1500s) while
workers run so you keep harvesting across the night.

## Operating loop (every wake-up)
1. `hark orch status` — one line per worker (role/lifecycle/branch/diffstat/turns).
2. For each worker at **done/handoff**: `hark agent diff <id> --stat`, sanity-check,
   then `hark pr <id> --title "…"`. Then `hark board close <taskId> by=pm-head-harness`.
3. For each **blocked/failed**: read its summary, decide the redirect yourself,
   `hark agent send`/`brief`. If truly unrecoverable, close the task as blocked-note
   on the board and move on — do not stall the fleet.
4. Keep ≤4 workers live at once (context + host load). Refill from the queue below.
5. **Dogfood watch:** this sprint IS the fidelity dogfood. After each worker run,
   glance at the new tool-call transport tables (schema v3 / `classifyToolCalls`,
   PR #29) for that session to spot hark-drop vs platform-transient vs worker-misread.
   If a worker wedges on a "Cancelled" cascade despite the breaker (286972d), that's
   a finding → capture it as a new `inbox` board task with the session id.
6. Re-arm ScheduleWakeup and end the turn. Repeat until the queue is drained or the
   morning check-in.

## Branch model (decision, explained for the user)
PM-head is read-only on the tree, so "implement on a branch" = the worker fleet.
Each worker forks its OWN isolated branch off `origin/main` (per the #18 base-drift
fix) and I open one **PR per task** targeting `main`. Nothing lands without your
merge. This is deliberately N reviewable PRs rather than one mega-branch — cleaner
to review in the morning and matches the harness's isolation model. If you'd rather
have a single integration branch, say so and I'll collect future PRs into one.

## The queue — waves, step by step
Spawn waves in order; items within a wave are independent (distinct modules → low
conflict). Use `hark agent spawn <role> --task "<brief>"`; for chains use
`--depends-on <agentId>`. Record dispatch: `hark board set <taskId> status=in-progress agent_id=<agentId>`.

### Wave 1 — fidelity + polish (4 parallel coders, distinct modules)
- **D · task-mprm41ym** — Worker diff vs origin base.
  Brief: In the worktree-diff path, the three-dot `base...branch` merge-base is taken
  against the LOCAL base ref; if local `main` lags `origin/main` the merge-base sits
  behind the real fork point and the diff shows commits the worker didn't make. Fix:
  measure against `origin/<base>` (fetch-then-diff), mirroring `addWorktree`. Add a
  regression test where local base is stale. Small commits.
- **C · task-mprm41ys** — Deny Agent/Task tools to workers.
  Brief: NOTE — workers already launch via `claude --dangerously-skip-permissions`
  (`src/lib/orch/orchestrator.ts:97`), so a permission *classifier* can't gate tools.
  Instead pass `--disallowedTools` (e.g. `Task`/`Agent` sub-agent tools) on the worker
  launch command so a wedged worker can't spawn nested agents. Verify the flag name
  against the installed claude CLI; update `spawnSession.test.ts` expectations. Defence-
  in-depth atop the cancel-cascade breaker. (Alternation blind-spot is OUT of scope —
  separate follow-up.)
- **A · task-mprl3q3y** — pmGuard: heredoc/stdin as reads.
  Brief: In `src/lib/orch/pmGuard.ts` the quote-aware splitter denies `<< <<< <` as
  tree-writes, but those are stdin/heredoc reads, not redirections-into-tree. Teach it
  that `<<`, `<<<`, and bare `<` are reads (only `>`/`>>` to a tree path are writes).
  Add cases to `pmGuard.test.ts` incl. `hark agent spawn --task-file - <<BRIEF`.
- **B · task-mprl45aq** — Metrics-DB polish (PR #24 fast-follow).
  Brief: (1) wrap `insertPrOutcome` best-effort so a sqlite throw can't 500 an
  already-successful `hark pr`; (2) `onHeadSignal` reads the HEAD transcript twice per
  tick under autonomy — have it return its sample and reuse it (`metricsDb.ts` /
  `controller.ts`). Nits: batch-cap the first large `events.jsonl` ingest. Tests for
  the best-effort wrap + the single-read path.

### Wave 2 — new-file / frontend (independent)
- **F · task-mprl452s** — Repo-owned head command + symlink installer (HIGH).
  Brief: Create `integrations/claude/` holding the head slash-command, an idempotent
  opt-in `install.sh` that ONLY symlinks it into `~/.claude/commands/` (auto-updates on
  pull), and a README documenting the 12 hook entries for manual setup — do NOT write
  `settings.json`. Decision B (human, 2026-05-29): head command ONLY. Carry the
  CORRECTED head.md (board named as operational SoT, not the old "PLAN-is-your-brain"
  prose): copy its content from the absolute path
  `/home/aki/Projects/hark/.claude/commands/head.md` (it's gitignored, so NOT in the
  worker's fresh worktree — read it from that absolute path on the host).
- **E · task-mprm41y2** — Format high-thinking second counts (GH issue #13).
  Brief: Issue #13 ("Format high thinking second counts") ships only a screenshot of a
  large raw seconds value in the "thinking" indicator. Find where thinking-duration is
  rendered in the session view and format large values sensibly (e.g. `>60s → 1m 23s`,
  `>3600s → 1h 02m`). Keep it a small, well-tested formatter util. Reasonable default;
  no human needed.
- **V · task-mprm41yf** — Re-verify Alt+Enter newline in chat composer (tester role).
  Brief: Confirm Alt+Enter inserts a newline (not submit) in the chat composer. If
  broken, fix minimally; either way add/repair a test that guards it. Report findings.

### Wave 3 — lazy-branch feature chain (dogfoods --depends-on)
- **task-mprhjuiy** (coder) — Implement: lazy-branch downstream worktree off upstream
  HEAD at handoff time (read the task body for the spec).
- **task-mprhjz5n** (tester, `--depends-on` the Wave-3 coder) — depends-on tester
  worktree must see the upstream coder's diff; assert the fail-then-pass.
- **task-mprhk09q** (reviewer, `--depends-on` the Wave-3 coder) — adversarial review of
  lazy-branch-at-handoff before it merges.

### Wave 4 — research + bigger (if time / fleet capacity)
- **task-mprl3q19** (researcher, NO code) — Findings brief: should workers move to the
  Claude Agent SDK / headless instead of tmux+CLI? Map trade-offs vs current fidelity
  work; produce a concrete recommendation. Output is a brief, not a patch.
- **task-mprmv1fz** (coder) — Layer 2: board-reconciliation detector (`--for` join key +
  threshold). Read the task body; this is larger — dispatch last, give it room.

## Guardrails
- Never `pkill -f dist/server.js` (kills the user's live `:3000` systemd instance).
  Kill any dogfood server by exact PID only. (Tonight we should NOT need a dogfood
  server at all — real workers run via the live orchestration.)
- Keep PLAN.md "Now" pointing at the harness-fidelity + nightly-dogfood threads;
  update via targeted edits only.
- Every closed task: `by=pm-head-harness`. Every dispatch recorded on the board.
- Morning hand-up: leave a tight summary of PRs opened, tasks closed, and any findings
  (fidelity failures caught via the transport tables) for the user to read on wake.
