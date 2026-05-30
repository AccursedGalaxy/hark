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

- **Harness fidelity is the bottleneck.** → board `harness-fidelity`. Workers run less reliably inside the harness than native Claude Code; nothing downstream (saturation, the board's payoff) matters until that's fixed. Goal: a hark worker runs as beautifully as native CC. First dominant failure mode now diagnosed + fixed + deployed (`286972d`): a benign tool error (grep exit-1) wedged worker sessions into permanent "Cancelled" on every later tool call (206-turn spiral) → fixed via a cancel-cascade breaker trigger + worker skip-perms + roles.ts tooling defaults. Detector-half instrumentation **landed** (PR #29 merged: schema v3 + `classifyToolCalls`, `task-mprl3ptb` done) — fidelity failures are now legible (hark-drop vs platform-transient vs worker-misread) instead of inferred. Next lever: *use it* — dogfood worker runs through the new tool-call tables to surface the next dominant failure mode from data, not inference.
- **PM-Head harness is LIVE on `main`** (deployed). → board workstreams. Single canonical trunk; the whole stack is here (orchestration layer + head-session model + PM-Head phases + interaction features + base-drift fix). Dogfood ran a heavy overnight sprint (2026-05-30): the harness drove its own backlog and banked **9 PRs** — #30–36 + #38 mergeable (pmGuard heredoc, worktree origin-base diff, deny Task/Agent tools, metrics-db best-effort, repo-owned `/head`, issue-#13 thinking-time format, Alt+Enter guard, spawn-echo+tmux-window-names DX) + **#37 lazy-branch-at-handoff built and adversarially reviewed but flagged NEEDS-REWORK** (2 blocking defects: B1 TOCTOU double-materialize race, B2 dependent forks stale `origin/` tip — fix-list on board `task-mprrgqi8`). It also surfaced real fidelity data now on the harness-fidelity backlog: a cancel-cascade wedge, two silent end-of-run hangs, two NO_PROGRESS spirals, and the depends-on review chain self-invalidating because `--depends-on` is metadata-only today (the exact bug #37 fixes). A human-gated **SDK-migration decision** is parked (`task-mprr02rx`: spike recommended). Deploy = rebuild + `systemctl --user restart hark.service`.
- **Self-telemetry is a first-class pillar.** → board `observability` (epic `task-mps9cpcb`). Data about the PM-head's own runs is the prerequisite for *any* optimization, validation, or non-code issue detection — without it we fly blind. Mandate (user, 2026-05-30): every `/head` session is captured automatically and completely from the moment it starts, for its whole lifetime, regardless of duration, at worker-parity fidelity. The first autonomous run proved the payoff (fidelity failures = 87% of token cost) but the data was hand-assembled. Now reviewing + upgrading the capture/logging pipeline; near-term levers = `hark session report`, head↔worker capture parity, costUsd (always 0 today), and a live silent-hang detector. (Board remains the operational SoT — settled, binding in CLAUDE.md.)
