# hark — PLAN

*Living narrative of this project — vision, direction, and what's moving right
now. Hark reads it at every session start. Task state — inbox captures, backlog,
in-flight work, and the shipped log — lives on the **board** (`hark board`), NOT
here; this file carries only the North Star and a compact Now. Each section opens
with its contract in italics — those lines are binding.*

## North Star

*What this project is for. 2–4 sentences. Slow-changing — only edit when
the vision actually shifts.*

hark is a notification and remote-control hub for Claude Code sessions running on this host. It reads `~/.claude/sessions/*.json` + per-session transcript JSONL and drives sessions via `tmux send-keys`, so any active session is reachable from any device on the tailnet without replacing the TUI. The point is attention triage and full mobile control — coexistence with terminal use, not replacement. On top of that single-session control, hark is growing an **orchestration layer**: running multiple sessions as a coordinated team of role-playing agents (Researcher/Coder/Tester/Documenter/Reviewer), each in an isolated git worktree, driven autonomously via the same tmux path — turning hark into a power tool for managing a whole project's worth of agents.

## Now

*The few threads actively moving right now. Hard cap: 3 bullets, one line of
context each. Each points at a board workstream — granular task status,
dependencies, and ownership stay on the board (`hark board list`), not in the
bullet. Everything else — backlog, captures, shipped work — is on the board.*

- **Harness fidelity is the bottleneck.** → board `harness-fidelity`. Workers run less reliably inside the harness than native Claude Code; nothing downstream matters until a hark worker runs as beautifully as native CC. The dominant failure is the **cancel-cascade**: one tool error (a bare `grep` that matches nothing → exit-1) cascades into permanent "Cancelled" on every later call. A breaker (`286972d`) now reaps it at the cliff (vs the original 206-turn spiral), and detector instrumentation landed (PR #29: schema v3 + `classifyToolCalls`) so failures are legible. **Doctrine refined + deployed 2026-05-30:** (a) *trust Claude's built-in tool reasoning* — `roles.ts` no longer prescribes tools (#40); the real cause was workers not loading the **deferred** Grep/Glob and shelling out to bare `grep`; (b) *lean briefs beat bloated ones* — a 3-sentence brief shipped #39 where a 6-slice monster spiraled to 0 commits at 101 turns. The cascade still recurs (`task-mpsa80q3`) — it's a harness transport bug hark can't fix; we control the **trigger** (lean briefs + tool-loading), not the bug.
- **Fork-from-branch + PR stacking** (the current build). → board `orchestration` (epic `task-mps9onop`). Long autonomous sessions stack up unmerged PRs; a later task that needs an earlier-but-open PR's files is stranded by forking from `main`. Designed + adversarially validated (`.hark/designs/base-selection-system.md`): the PM owns base selection — default `main`, `--base` onto an open PR when a task needs unmerged code, integrator for diamonds. Shipping as **lean slices**, one small PR each: slice 1 (`--base` forks the worktree) merged as **#39**; slice 2 — the **keystone** (persist baseRef per-agent + thread the diff/log/pr read paths off it; the gap both reviewers flagged) — is tester-verified green, **merged (#41) and deployed**; next = visibility (surface "stacks on PR #X") + docs, then the decision-gated slices (`pr/N` resolution, staleness, linked-vs-integration strategy). *Overnight-dogfood open items now live on the board:* 11 PRs merged total, **`#37` lazy-branch needs-rework** (fix-plan `task-mprrgqi8`), SDK-migration decision parked (`task-mprr02rx`). Deploy = `npm run build` + `systemctl --user restart hark.service`.
- **Self-telemetry is a first-class pillar.** → board `observability` (epic `task-mps9cpcb`). Data about the PM-head's own runs is the prerequisite for *any* optimization, validation, or non-code issue detection — without it we fly blind. Mandate (user, 2026-05-30): every `/head` session is captured automatically and completely from the moment it starts, for its whole lifetime, regardless of duration, at worker-parity fidelity. The first autonomous run proved the payoff (fidelity failures = 87% of token cost) but the data was hand-assembled. Now reviewing + upgrading the capture/logging pipeline. State (verified 2026-05-30, researcher agent-mpslqs3d): head capture is at worker-parity; costUsd is now computed live (`controller.ts:626`, `f54d47c`) — the old "always 0" is fixed. Remaining near-term levers = `hark session report` (does not exist yet) and a live silent-hang detector (absent). (Board remains the operational SoT — settled, binding in CLAUDE.md.)
