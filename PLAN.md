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

- **Orchestration layer** (branch `orchestration`) — multi-agent glue on the existing foundation. **Backend + dashboard + head-session model (Phase 1+2) built**: hardened tmux send path, `git worktree` isolation, role charters + briefing builder, store + event log, orchestrator service, autonomy controller (marker scan, self-review loop, metrics) wired into server (3s reconcile + Stop-hook), endpoints, web dashboard. **Head-session model** layered on top: every orchestration spawns a coordinating *head* Claude session (own worktree `hark/<orch>/head`, folder-trust pre-cleared via atomic `~/.claude.json` merge, `--permission-mode auto`) that decomposes the goal, spawns workers on demand, and is driven via a thin `hark` CLI (`bin/hark`: `orch status|watch`, `agent spawn|send|brief|diff|log`). Worker→head marker notifications + head-`DONE`→orchestration-complete wired. Dashboard drops role chips, surfaces the head. See `docs/orchestration-head.md`. 521 tests green + build clean; not merged to main.
  **Dogfooded live (2026-05-29, isolated `:3999` instance, `HARK_ORCH_AUTONOMY=1`):** a head-led run on this repo completed end-to-end — head spawned unattended (folder-trust cleared, no dialog), auto-briefed, ran `hark agent spawn coder` via the CLI, the worker wrote+committed `DOGFOOD.md` and hit DONE, the worker→head notification fired, and the head emitted orchestration-DONE → `completed`. Metrics: head 9 turns / 21.7k tok, coder 8 turns / 23.1k tok. Caught + fixed two real bugs: head-worktree teardown leak, and large multi-line briefings parking unsubmitted in the TUI (paste/Enter race — fixed in `sendKeys.ts`).
  Last steps before merge: Phase 3 polish (`hark pr`, default head-on), decide whether to default autonomy on, and resolve the no-remote PR case (spec open question).

## Next

*Committed, not started. No hard cap, but if this list exceeds ~7 items
it has become a dumping ground — flag it and force triage back into Now
or out of the doc.*

- **Capture modal: image attachment** — drag-and-drop and Ctrl+V paste in the capture textarea, mirroring the session composer's upload flow.
- **Passive "modified by another session" indicator** — `PlanPanel` shows a small dot when `planMtime` advanced since this view's last fetch. Designed-but-deferred during the project-state build.
- **Web Push** — service worker + VAPID for closed-app mobile notifications. Last open item from the original Phase 2+ list.
- **Orchestration: validate active autonomy on live sessions** — exercise `HARK_ORCH_AUTONOMY=1` against real Claude Code sessions: confirm briefing delivery only fires after trust clears, the self-review nudge loop terminates, and `costUsd` gets populated (currently tokens/turns + briefed→updated autonomy time are wired; per-agent cost needs the pricing table from `web/src/lib/usage.ts` shared server-side). Then decide whether to default it on. (`orchestration` → `main` already merged 2026-05-29 @ 9ce1467.)
- **Orchestration: head-session model — Phase 3 + live validation** (spec: `docs/orchestration-head.md`). Phase 1 (head role + `spawnHead`/`createWithHead` + head briefing + `hark` CLI + worker→head notification) and Phase 2 (`hark orch watch` long-poll + head-`DONE`→orchestration-complete + dashboard head surfacing) are **built and unit-tested**, dogfooded against a real repo with a fake spawner. Remaining: **(a)** ~~validate the live keystroke loop~~ DONE 2026-05-29 — live-validated on `:3000` end-to-end (head spawned unattended, both gates cleared, briefed → `hark agent spawn coder` → coder committed + DONE → `head_notified:done` → completed); also fixed a teardown process-orphan bug found there; **(b)** Phase 3 polish: `hark pr` helper (push branch + `gh pr create --base`), decide on defaulting head-on; **(c)** the no-remote PR case (still-open question in the spec). NOTE: `hark` CLI requires `npm run build` before spawning (bin/hark imports `dist/`).
- **★ NEXT UP — PM-Head Orchestration Harness** (full build spec: **`docs/pm-head-harness.md`** — START HERE; reasoning trail in `docs/orchestration-head.md` §"Direction"). Turn the shipped head-session engine into a first-class, semi-autonomous project harness: a **persistent, project-scoped, pure-PM session** that ideates with you, owns `PLAN.md` as its externalized brain, and dispatches the existing worker team to ship/test fast — never mutating your working tree, never interrupting your thinking. **All major design decided:** persistent PM = a role any session resumes by reading PLAN; pure-PM read-only tree (PreToolUse-hook enforced); git-safety via worktree/integrator/PRs with the human owning the final land; three-tier signals (routine→pull via a `UserPromptSubmit` delta hook at turn boundaries; blocker→escalate to the human via hark notifications; pipeline-advance→idle loop reusing the existing event-push so the head never blocks); a per-project **autonomy dial** (L0 propose → L3 background, default **L2 supervised-auto**) as the tunable-autonomy knob. **Build it in vertical slices** (see spec §7): **Phase A** "the PM you talk to" = promotion (`hark head init`/`/head` attaches the current session as project head + CLI env-fallback) + PM charter (`roles.ts`) + pure-PM enforcement hook → START HERE; **B** newsroom projection + delta hook; **C** idle loop + dial + blocker→human; **D** integration helpers (`hark pr`/integrator) + managed-project mode. Most substrate is already shipped — the gap is 9 bounded items (spec §6). **Two open decisions** (spec §8): default autonomy level (proposed L2) and newsroom scope (all orchestrations vs one active feature).

## Shipped

*Newest first. Keep the last 10 lines here; move older entries to
`.hark/shipped-archive.md`. Git history is the real archive — this
section exists to answer "what just happened" for a cold start, not
to be complete.*

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
- [2026-05-29 13:35] [next] Orchestration agent isolation is too flat: every agent's worktree is branched off `baseRef` at creation, so a downstream agent gets a pristine copy of base and can't see the upstream's work — the exact code it exists to test/review/document. **Partial:** the head model added the `dependsOn` field on `OrchAgent` (stored, threaded through `spawnAgent`), but the worktree is still branched off `baseRef`. Remaining: resolve `dependsOn` at **handoff time** — when the upstream hits `[[HARK:HANDOFF]]`/`[[HARK:DONE]]` and has committed, branch the downstream worktree off the upstream's branch HEAD (lazy), not off base. Less urgent now that a reasoning *head* dispatches work (it can point a worker at the right branch), but still the right fix for the HANDOFF marker (today it only flips lifecycle to `review`, moves no code). Keep one worktree per agent — never share a live tree.
- [2026-05-29 15:48] when typing into the chat box it's very laggy and delayed. letters appear slowly. (This Capture to proejct form works fine) the issue is only in chat input it seems like.
- [2026-05-29 15:49] I want "Alt+Enter" to go to next line as well in chat input just like in the claude code CLI.
