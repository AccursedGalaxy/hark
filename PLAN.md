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

- **Refocus: orchestration removed — COMPLETE 2026-07-02.** → board `refocus`. driver-os owns multi-agent orchestration; hark is purely remote session management (PR #42 deleted the orch layer, 2026-06-10). Verification done: runtime seam clean, `autonomy.conf` dropped, install-hooks rerun (no legacy sync curls in settings.json); dead integration/docs surface (/head command, agents-overview.html, stale README) removed in PR #48. Only host debris left: ~80 orphaned orch-era worktrees under `~/.hark/worktrees/hark/` (Robin to prune).
- **Sidebar declutter / UX cleanup — started 2026-07-07.** → board `ux-polish` (`task-mrapauwj-435100`). Root cause: `/api/projects` dumps the never-evicting `projectCache`, so dead scratchpad projects render forever; sidebar also lacks a real NEEDS YOU section and activity-sorted groups. Fix delegated to driver-agent (server filter to live-session projects + Sidebar restructure + quieter cards).
- **Blazing-fast session sync: SHIPPED + deployed 2026-06-10** (PRs #43/#44/#45, board `fast-sync` tasks closed). Server: gzip, ETag/304, transcript parse cache, watcher-backed session index, session-list SSE push, offset-resumable streams. Client: IndexedDB transcript cache + `?after=` deltas + continuity check, localStorage sidebar snapshot, windowed-tail rendering. Measured: 13MB transcript revisit = 30ms cache paint + 31-byte delta (was 4.5MB). Live on :3000 (restart also activated the 8GB heap.conf). Re-measured 2026-07-02 under emulated phone conditions (60–150ms RTT, 4× CPU throttle, headless mobile Chromium): warm revisit = 24–32ms cache-paint + one-RTT delta, latency-insensitive. Thread closed; optional one-tap sanity check from the real phone.
- **Server stability: heap OOM — root-caused 2026-07-02.** The leak lived in the orchestration reconcile loop deleted by the refocus (3s full-transcript re-reads per active orchestration): zero OOMs in the 21 days since that deploy vs. a 5–8h crash cycle before, and a 3-round soak of the remaining read paths converges at ~260MB RSS. `task-mq78q8ko-3fd6d2` CLOSED 2026-07-02: 8GB `heap.conf` crutch removed, service restarted on Node defaults (Robin-authorized deploy; also activated auth + attention tiers on :3000). CI heap-regression guard protects against recurrence.
