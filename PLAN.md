# hark — PLAN

*Living state of this project. Hark reads it at every session start;
sessions keep it accurate as they work. Each section opens with its
contract in italics — those lines are binding.*

## North Star

*What this project is for. 2–4 sentences. Slow-changing — only edit when
the vision actually shifts.*

hark is a notification and remote-control hub for Claude Code sessions running on this host. It reads `~/.claude/sessions/*.json` + per-session transcript JSONL and drives sessions via `tmux send-keys`, so any active session is reachable from any device on the tailnet without replacing the TUI. The point is attention triage and full mobile control — coexistence with terminal use, not replacement.

## Now

*Active threads being shipped right now. Hard cap: 3 items. One bullet
per thread; one line of context allowed beneath it.*

- **Bootstrap-from-codebase line in `CLAUDE.md` block** — closes the design gap surfaced 2026-05-27: an empty `PLAN.md` doesn't auto-populate because the contract says "as state changes," not "on first read of a skeleton."
  Edit landed in `src/lib/projectConstants.ts` (5 lines); 391 tests green; uncommitted.

## Next

*Committed, not started. No hard cap, but if this list exceeds ~7 items
it has become a dumping ground — flag it and force triage back into Now
or out of the doc.*

- **Fix sidebar "Claude is waiting for your input" false positive** — the rail shows this on every live session once clicked. Likely an attention/promptKind clear that isn't firing on selection.
- **Capture modal: image attachment** — drag-and-drop and Ctrl+V paste in the capture textarea, mirroring the session composer's upload flow.
- **Passive "modified by another session" indicator** — `PlanPanel` shows a small dot when `planMtime` advanced since this view's last fetch. Designed-but-deferred during the project-state build.
- **Web Push** — service worker + VAPID for closed-app mobile notifications. Last open item from the original Phase 2+ list.

## Shipped

*Newest first. Keep the last 10 lines here; move older entries to
`.hark/shipped-archive.md`. Git history is the real archive — this
section exists to answer "what just happened" for a cold start, not
to be complete.*

- Project-state feature: per-repo `PLAN.md`, capture shortcut, project grouping, idempotent `CLAUDE.md` block (5c34c1f).
- Settings popover moved into the sidebar footer (d5bf559).
- Context rail with per-message token accounting + cost metrics (1d4954a).
- Hardware-keyboard detection so the composer doesn't double-trigger send (a2dcd78).
- Touch + iOS PWA behavior pass (b3ccc8a).
- Question / prompt cards optimized for narrow viewports (96782d0).
- Narrow-layout overflow fix in the transcript view (b5731ac).
- AI-title support: Claude's `ai-title` row surfaced as the session label (7a3b844).
- Smooth-scroll tool capsules into view when expanded (1c78ef4).
- PWA manifest + spawn-session PID tracking for pending-row auto-focus (da1751f).

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
