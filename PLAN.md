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

- **Orchestration layer** (branch `orchestration`) — multi-agent glue on the existing foundation. **Backend complete + dashboard shipped**: hardened tmux send path, `git worktree` isolation, 5 role charters + briefing builder, store + event log, orchestrator service, autonomy controller (marker scan, self-review loop, metrics) wired into server (3s reconcile + Stop-hook), endpoints, and a web dashboard (list / spawn form / agent cards / metrics / event timeline) reachable from the rail. Active autonomy opt-in via `HARK_ORCH_AUTONOMY=1`. Worktree flow verified vs a real repo; UI verified in-browser. See `docs/orchestration.md`. 465 tests green + web build clean; not merged to main.
  Last step before merge: validate the active autonomy loop against live Claude sessions, then decide whether to default it on.

## Next

*Committed, not started. No hard cap, but if this list exceeds ~7 items
it has become a dumping ground — flag it and force triage back into Now
or out of the doc.*

- **Capture modal: image attachment** — drag-and-drop and Ctrl+V paste in the capture textarea, mirroring the session composer's upload flow.
- **Passive "modified by another session" indicator** — `PlanPanel` shows a small dot when `planMtime` advanced since this view's last fetch. Designed-but-deferred during the project-state build.
- **Web Push** — service worker + VAPID for closed-app mobile notifications. Last open item from the original Phase 2+ list.
- **Orchestration: validate active autonomy on live sessions** — exercise `HARK_ORCH_AUTONOMY=1` against real Claude Code sessions: confirm briefing delivery only fires after trust clears, the self-review nudge loop terminates, and `costUsd` gets populated (currently tokens/turns + briefed→updated autonomy time are wired; per-agent cost needs the pricing table from `web/src/lib/usage.ts` shared server-side). Then decide whether to default it on, and merge `orchestration` → main.

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
- [2026-05-29 13:35] Orchestration agent isolation is too flat: every agent's worktree is branched off `baseRef` at creation, so Tester/Reviewer/Documenter get a pristine copy of base and can't see the Coder's work — the exact code they exist to test/review/document. Fix: model agent dependencies (`dependsOn`) so a downstream agent's worktree derives from the upstream agent's branch HEAD, resolved at **handoff time** (lazy spawn/rebase when the upstream hits `[[HARK:HANDOFF]]`/`[[HARK:DONE]]` and has committed) — not at orchestration creation. This is the missing half of the HANDOFF marker (today it only flips lifecycle to `review`, moves no code). Keep one worktree per agent — never share a live tree (concurrent writers collide; git refuses the same branch in two worktrees).
