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

- **Harness fidelity is the bottleneck.** → board `harness-fidelity`. Workers run less reliably inside the harness than native Claude Code; nothing downstream (saturation, the board's payoff) matters until that's fixed. Goal: a hark worker runs as beautifully as native CC. First dominant failure mode now diagnosed + fixed + deployed (`286972d`): a benign tool error (grep exit-1) wedged worker sessions into permanent "Cancelled" on every later tool call (206-turn spiral) → fixed via a cancel-cascade breaker trigger + worker skip-perms + roles.ts tooling defaults. Detector-half instrumentation (`task-mprl3ptb`, `ready`) is the next lever — makes such failures legible instead of inferred.
- **PM-Head harness is LIVE on `main`** (deployed). → board workstreams. Single canonical trunk; the whole stack is here (orchestration layer + head-session model + PM-Head phases + interaction features + base-drift fix). Dogfood the harness on hark's own backlog, parked behind the fidelity work. Deploy = rebuild + `systemctl --user restart hark.service`.
- **The board is the operational source of truth.** → `hark board`. Inbox captures, task status, deps, ownership, and the shipped log (done tasks carry `closed_at` + `closed_by`) all live on the per-project board; PLAN is narrative only. Binding design = the `## RESOLVED` section of `.hark/board-plan.md`. Cold-start "what just happened" = `hark board list status=done` + git log.
