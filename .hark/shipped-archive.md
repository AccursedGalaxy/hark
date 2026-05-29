# Shipped (archive)

*Older `Shipped` entries from `PLAN.md`, rotated out as the live section
stays bounded at 10. Newest first within this file too — append at the
top when rotating. Git history is the real archive; this file is just
the readable trail for cold starts that want more than 10.*

- **Alt+Enter → newline in chat composer** (first PM-Head dogfood item) — `Composer.tsx` `onKeyDown` gains an `e.altKey` branch that splices `\n` at the caret via `commitSlashEdit` before the submit branch; footer hint now `↵ / ⌥↵ newline`. Shipped via worker `hark/pm-hark/coder-fc18f5` (`fd2380e`, +15/-1), human fast-forward-merged into `pm-head-harness`. The run dogfooded the harness end-to-end and surfaced 3 real bugs (worker-never-terminated spin loop, no node_modules in worktrees, `hark pr` assumes base on remote) — see Inbox.
- Orchestration teardown now kills each agent's + the head's session process (new `killSession` dep, SIGTERM to the pane pid) *before* removing its worktree — fixes the live-`:3000`-validation finding that a running `claude` orphaned and held its worktree dir busy, leaving the directory behind. Tolerant of an already-dead/null pid. 524 green.
- Head-session orchestration model (Phase 1+2) validated live on `:3000` (2026-05-29): head spawned unattended, both permission gates cleared (folder-trust pre-clear + `--permission-mode auto`), head briefed → `hark agent spawn coder` → coder committed + DONE → `head_notified:done` → orchestration completed (~46k tok). Implementation: `Orchestration.head`, atomic folder-trust pre-clear, `buildHeadBriefing`, `spawnHead`/`createWithHead`, worker `task`/`dependsOn`, env+`--permission-mode auto` spawn injection, worker→head notifications + `onHeadSignal`, the `hark` CLI (`bin/hark`) + backing endpoints, `orch watch` long-poll, dashboard head surfacing.
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
