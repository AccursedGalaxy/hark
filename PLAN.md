# hark — PLAN

*Living state of this project. Hark reads it at every session start;
sessions keep it accurate as they work. Each section opens with its
contract in italics — those lines are binding.*

## North Star

*What this project is for. 2–4 sentences. Slow-changing — only edit when
the vision actually shifts.*

hark is a notification and remote-control hub for Claude Code sessions running on this host. It reads `~/.claude/sessions/*.json` + per-session transcript JSONL and drives sessions via `tmux send-keys`, so any active session is reachable from any device on the tailnet without replacing the TUI. The point is attention triage and full mobile control — coexistence with terminal use, not replacement. On top of that single-session control, hark is growing an **orchestration layer**: running multiple sessions as a coordinated team of role-playing agents (Researcher/Coder/Tester/Documenter/Reviewer), each in an isolated git worktree, driven autonomously via the same tmux path — turning hark into a power tool for managing a whole project's worth of agents.

## Now

*Active threads being shipped right now. Hard cap: 3 items. One bullet
per thread; one line of context allowed beneath it.*

- **Orchestration layer** (branch `orchestration`) — multi-agent glue on the existing foundation. Landed: hardened tmux send path, `git worktree` isolation, 5 role charters + briefing builder, file-backed store + event log, orchestrator service (worktree+spawn+roles, DI, rollback), and server endpoints (`POST/GET /api/orchestrations[/:id]`, teardown). Verified end-to-end against a real git repo (worktrees created + torn down). See `docs/orchestration.md`.
  Next: autonomy controller (Stop-hook marker scanning + briefing delivery past the trust prompt) → frontend dashboard. All tested (437 green); not yet merged to main.

## Next

*Committed, not started. No hard cap, but if this list exceeds ~7 items
it has become a dumping ground — flag it and force triage back into Now
or out of the doc.*

- **Capture modal: image attachment** — drag-and-drop and Ctrl+V paste in the capture textarea, mirroring the session composer's upload flow.
- **Passive "modified by another session" indicator** — `PlanPanel` shows a small dot when `planMtime` advanced since this view's last fetch. Designed-but-deferred during the project-state build.
- **Web Push** — service worker + VAPID for closed-app mobile notifications. Last open item from the original Phase 2+ list.
- **Orchestration: autonomy controller** — (a) briefing delivery: once a spawned agent's session registers and clears its trust prompt, send `orchestrator.briefingFor(...)` via the hardened `sendInput` path, then set lifecycle `running`. (b) on `Stop`/`SubagentStop` for an orchestration-owned session, scan the transcript tail for `[[HARK:DONE/BLOCKED/HANDOFF]]` markers (`src/lib/orch/roles.ts`) and advance/nudge/block the agent; bounded self-review loop; record interventions + metrics into `events.jsonl`. Correlate agent.pid/sessionId to a live session via the existing pid→pane resolution.
- **Orchestration: frontend** — orchestration dashboard (agents, lifecycle, live metrics/cost/autonomy time), spawn flow, and per-orchestration event-log timeline. New `useOrchestrations` hook mirroring `useSessions`.

## Shipped

*Newest first. Keep the last 10 lines here; move older entries to
`.hark/shipped-archive.md`. Git history is the real archive — this
section exists to answer "what just happened" for a cold start, not
to be complete.*

- Sidebar Live/Idle dot collision resolved: Idle is now a hollow jade ring (inset box-shadow), so it stays distinct from Live across every accent preset — including jade-accent, where both would otherwise be the same filled green.
- Pending prompt no longer disappears on a second client: `noteTranscriptEvents` Phase 2 only fires on `assistant` events, so a queued-prompt `user` event with `ts > requestedAt` (replayed when any client opens the transcript stream) can no longer broadcast `pending=undefined` to every connected client.
- Mobile horizontal-overflow fix: markdown tables wrap in a scroll container, `.md pre` clamped, transcript and slash menu pin `overflow-x: hidden` to defeat the implicit `auto` from `overflow-y`.
- Sidebar ASKING pill no longer sticks on stale `status="waiting"`; `deriveState` requires a real pending payload (b3dc80e).
- Bootstrap-from-codebase directive added to the CLAUDE.md managed block (7220b74).
- Project-state feature: per-repo `PLAN.md`, capture shortcut, project grouping, idempotent `CLAUDE.md` block (5c34c1f).
- Settings popover moved into the sidebar footer (d5bf559).
- Context rail with per-message token accounting + cost metrics (1d4954a).
- Hardware-keyboard detection so the composer doesn't double-trigger send (a2dcd78).
- Touch + iOS PWA behavior pass (b3ccc8a).
- Question / prompt cards optimized for narrow viewports (96782d0).
- Narrow-layout overflow fix in the transcript view (b5731ac).
- AI-title support: Claude's `ai-title` row surfaced as the session label (7a3b844).

## Inbox

*Raw captures, timestamped as `- [YYYY-MM-DD HH:MM] text`. The required-pass
section: every line must be gone or tagged before this session ends.*

- *Relevant to current work → incorporate, then remove the line.*
- *Otherwise → promote (to Now / Next), delete (noise), or keep with a
  one-word reason in brackets: `[blocked]`, `[maybe]`, `[waiting-on-X]`.*
- *A bare untagged line surviving past session end is the signal that
  the previous session failed its pass — triage it first.*

- [2026-05-27 18:40] easy issue to implement https://github.com/AccursedGalaxy/hark/issues/13 [maybe]
- [2026-05-27 18:46] typing bubbles for claude code inside the session view [maybe]
