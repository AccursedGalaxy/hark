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
- **Blazing-fast session sync: SHIPPED + deployed 2026-06-10** (PRs #43/#44/#45, board `fast-sync` tasks closed). Server: gzip, ETag/304, transcript parse cache, watcher-backed session index, session-list SSE push, offset-resumable streams. Client: IndexedDB transcript cache + `?after=` deltas + continuity check, localStorage sidebar snapshot, windowed-tail rendering. Measured: 13MB transcript revisit = 30ms cache paint + 31-byte delta (was 4.5MB). Live on :3000 (restart also activated the 8GB heap.conf). Remaining: re-measure `[timing]` logs from the phone over Tailscale; thread closes if it feels instant.
- **Server stability: heap OOM.** The server crashes every 5–8h at Node's 4GB heap limit (GC-thrash → phone timeouts → SIGABRT; was the user's "connection issues"). Mitigated 2026-06-10 with an 8GB `heap.conf` drop-in; root cause unprofiled (`task-mq78q8ko-3fd6d2`) — orchestration removal may shrink the leak surface; re-measure after deploy.
