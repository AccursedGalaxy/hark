# Shipped (archive)

*Older `Shipped` entries from `PLAN.md`, rotated out as the live section
stays bounded at 10. Newest first within this file too — append at the
top when rotating. Git history is the real archive; this file is just
the readable trail for cold starts that want more than 10.*

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
- Smooth-scroll tool capsules into view when expanded (1c78ef4).
- PWA manifest + spawn-session PID tracking for pending-row auto-focus (da1751f).
- Task-list panel + native key-sequence delivery for AskUserQuestion (f06562b).
