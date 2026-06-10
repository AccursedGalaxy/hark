# hark — PLAN

*Living narrative of this project — vision, direction, and what's moving right
now. Hark reads it at every session start. Task state — inbox captures, backlog,
in-flight work, and the shipped log — lives on the **board** (`hark board`), NOT
here; this file carries only the North Star and a compact Now. Each section opens
with its contract in italics — those lines are binding.*

## North Star

*What this project is for. 2–4 sentences. Slow-changing — only edit when
the vision actually shifts.*

hark is a notification and remote-control hub for Claude Code sessions running on this host. It reads `~/.claude/sessions/*.json` + per-session transcript JSONL and drives sessions via `tmux send-keys`, so any active session is reachable from any device on the tailnet without replacing the TUI. The point is attention triage and full mobile control — coexistence with terminal use, not replacement — with sessions, conversations, and full history loading blazing fast on every device. Multi-agent orchestration is explicitly out of scope (driver-os owns it; hark's orchestration layer was removed 2026-06).

## Now

*The few threads actively moving right now. Hard cap: 3 bullets, one line of
context each. Each points at a board workstream — granular task status,
dependencies, and ownership stay on the board (`hark board list`), not in the
bullet. Everything else — backlog, captures, shipped work — is on the board.*

- **Refocus: orchestration removed.** → board `refocus`. Direction shift (user, 2026-06-10): driver-os owns multi-agent orchestration; hark is purely remote session management. PR 1 (branch `refocus/drop-orchestration`) deletes the whole orch layer (~7k lines: PM-head, workers, worktrees, autonomy controller, metricsDb telemetry, decision hooks) and keeps the board (now `src/lib/board/`, CLI is board-only). Deploy must rerun `npm run install-hooks` (strips the legacy synchronous PreToolUse/UserPromptSubmit curls) and drop the `autonomy.conf` systemd drop-in (keep `heap.conf`).
- **Blazing-fast session sync.** → board `fast-sync`. Make conversations/sessions/history load instantly on every device (phone over Tailscale is the benchmark). PR 2 = server quick wins: gzip, ETag/304, transcript parse cache (kills the triple full-file read per open), watcher-backed session index, session-list push over the existing `/api/events` SSE (3s polling → 30s fallback). PR 3 = local-first: IndexedDB transcript cache + `?after=<offset>` deltas (`readFromOffset` already exists) + lastUuid continuity check, windowed-tail rendering for huge transcripts. Plan: `~/.claude/plans/elegant-orbiting-kite.md`.
- **Server stability: heap OOM.** The server crashes every 5–8h at Node's 4GB heap limit (GC-thrash → phone timeouts → SIGABRT; was the user's "connection issues"). Mitigated 2026-06-10 with an 8GB `heap.conf` drop-in; root cause unprofiled (`task-mq78q8ko-3fd6d2`) — orchestration removal may shrink the leak surface; re-measure after deploy.
