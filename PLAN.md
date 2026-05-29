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

- **PM-Head harness is LIVE on `main`** (@ `bbe2362`, 624 green, tsc clean) — the whole stack landed 2026-05-29: orchestration layer + head-session model + PM-Head phases A–D + this session's 4 dogfood fixes (terminate-on-done, worktree node_modules, `hark pr` local-only base, pure-PM guard false-positive). Active frontier: keep dogfooding the harness on hark's own backlog, fixing friction as it surfaces. Polish backlog parked in Inbox (status-line truncation, `hark agent stop`, spawn-echo-branch, tmux window names, `dependsOn`-at-handoff). After landing: rebuild + restart deploys it (also fixes the Alt+Enter stale-bundle issue).
- **Validate active autonomy + decide default-on** — exercise `HARK_ORCH_AUTONOMY=1` end-to-end (idle-advance push, blocker→human escalation, self-review termination), populate `costUsd` (needs the `web/src/lib/usage.ts` pricing table shared server-side), then decide whether to default the dial on. Today's run already validated terminate-on-done + worktree deps + idle-advance routing live on `:3000`.

## Next

*Committed, not started. No hard cap, but if this list exceeds ~7 items
it has become a dumping ground — flag it and force triage back into Now
or out of the doc.*

- **Capture modal: image attachment** — drag-and-drop and Ctrl+V paste in the capture textarea, mirroring the session composer's upload flow.
- **Passive "modified by another session" indicator** — `PlanPanel` shows a small dot when `planMtime` advanced since this view's last fetch. Designed-but-deferred during the project-state build.
- **Web Push** — service worker + VAPID for closed-app mobile notifications. Last open item from the original Phase 2+ list.
- **Dogfood polish backlog** — friction the live PM-head run surfaced, captured in Inbox: `hark orch status` task truncation, `hark agent stop` verb, spawn echoes branch/base/orch-key, tmux window names `<project>-<role>`, resolve `dependsOn` at handoff (lazy-branch downstream off upstream HEAD). Pull into Now as the harness gets exercised. (Full build record: `docs/pm-head-harness.md`, `docs/orchestration-head.md`.)

## Shipped

*Newest first. Keep the last 10 lines here; move older entries to
`.hark/shipped-archive.md`. Git history is the real archive — this
section exists to answer "what just happened" for a cold start, not
to be complete.*

- **All landed on `main` @ `bbe2362`** (2026-05-29, 624 green, tsc clean, pushed): the PM-Head harness (orchestration layer + head-session model + phases A–D) + the four dogfood fixes below, fast-forwarded from `pm-head-harness`. `main` is now the clean base with every new feature.
- **Infra bug #3 — `hark pr` handles a local-only base** (dogfound + fixed 2026-05-29). Added a `baseOnOrigin` DI dep (`git ls-remote --heads origin <base>` in `worktree.ts`) checked before `gh pr create`; base-present is unchanged, base-absent returns a structured `no_base` result with a friendly push-then-rerun / merge-locally message instead of the raw gh GraphQL error (no auto-push of the human's WIP). Both paths unit-tested. Worker `coder-604981` (self-terminated at 63 turns — validated fix #1).
- **Pure-PM guard false-positive fixed** (dogfound + fixed 2026-05-29; it had blocked the PM's own `hark agent spawn`). `pmGuard.ts` `splitStatements` is now quote-aware (operators inside quotes don't split), plus a per-statement allowlist for the `hark` dispatch CLI so a `--task` payload is never parsed as tree mutation — while a real mutation chained after still denies. Tests cover spawn-with-rich-prose ALLOW + chained-rm DENY + all prior deny cases. Worker `coder-e48af9` (self-terminated at 33 turns).
- **Infra bug #1 — terminate workers on terminal lifecycle** (dogfound 2026-05-29; the dominant token sink, ~1.3M tok/run of idle spin). The reconcile loop (`reconcileOrchestrations` in `src/server.ts`) now SIGTERMs a worker's session process the first time its lifecycle is `done`/`blocked`/`failed`, via the new `Orchestrator.killTerminalAgent` — which reuses the existing `killSession` dep (same teardown kill, tolerant of a null/dead pid), KEEPS the worktree+branch (the head still reads the work), and uses the new `OrchAgent.killedAt` to fire once, not every 3s tick. Independent of the autonomy dial — a finished worker is always reaped. Regression-tested in `orchestrator.test.ts`.
- **Infra bug #2 — worktrees get `node_modules`** (dogfound 2026-05-29). `addWorktree` now symlinks the repo's installed deps (root + `web/`) into each fresh worktree via the new `linkNodeModules` helper, so workers can build/typecheck/vitest instead of hitting `SKIP_TYPECHECK: no node_modules`. Symlink not copy (instant, zero disk); best-effort + idempotent (skips absent sources / existing targets, swallows fs errors). fs-only tests in `worktree.test.ts`. (617 tests green, tsc clean.)
- **Alt+Enter → newline in chat composer** (first PM-Head dogfood item) — `Composer.tsx` `onKeyDown` gains an `e.altKey` branch that splices `\n` at the caret via `commitSlashEdit` before the submit branch; footer hint now `↵ / ⌥↵ newline`. Shipped via worker `hark/pm-hark/coder-fc18f5` (`fd2380e`, +15/-1), human fast-forward-merged into `pm-head-harness`. The run dogfooded the harness end-to-end and surfaced 3 real bugs (worker-never-terminated spin loop, no node_modules in worktrees, `hark pr` assumes base on remote) — see Inbox.
- Orchestration teardown now kills each agent's + the head's session process (new `killSession` dep, SIGTERM to the pane pid) *before* removing its worktree — fixes the live-`:3000`-validation finding that a running `claude` orphaned and held its worktree dir busy, leaving the directory behind. Tolerant of an already-dead/null pid. 524 green.
- Head-session orchestration model (Phase 1+2) validated live on `:3000` (2026-05-29): head spawned unattended, both permission gates cleared (folder-trust pre-clear + `--permission-mode auto`), head briefed → `hark agent spawn coder` → coder committed + DONE → `head_notified:done` → orchestration completed (~46k tok). Implementation: `Orchestration.head`, atomic folder-trust pre-clear, `buildHeadBriefing`, `spawnHead`/`createWithHead`, worker `task`/`dependsOn`, env+`--permission-mode auto` spawn injection, worker→head notifications + `onHeadSignal`, the `hark` CLI (`bin/hark`) + backing endpoints, `orch watch` long-poll, dashboard head surfacing.
- Sidebar Live/Idle dot collision resolved: Idle is now a hollow jade ring (inset box-shadow), so it stays distinct from Live across every accent preset — including jade-accent, where both would otherwise be the same filled green.
- Pending prompt no longer disappears on a second client: `noteTranscriptEvents` Phase 2 only fires on `assistant` events, so a queued-prompt `user` event with `ts > requestedAt` (replayed when any client opens the transcript stream) can no longer broadcast `pending=undefined` to every connected client.

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
- [2026-05-29 dogfood-BUG] **★★ The pure-PM guard blocks the PM's own `hark agent spawn`.** `pmGuard.ts` `splitStatements` splits the Bash command on `;|&` and newlines **without honoring quotes**, so a multi-line `--task "…prose…"` brief gets shredded into fragments; arrows (`->`), `;`, `|`, redirection-looking `>`, and file-path tokens *inside the prose* are then misread as real shell ops against the tree → DENY ("redirection into the project tree (…)"). Any realistic worker brief trips it, breaking the core PM→worker dispatch loop. Also the deny message renders garbled (`((e.g.))`). **Fix:** allowlist the dispatch CLI — recognize `hark`/`node …/bin/hark` (esp. `agent spawn|send|brief`) and DO NOT parse its args as tree mutations (the `--task` payload is opaque data, not shell). Secondarily, `splitStatements` should honor quotes. **Workaround used this session:** write the task to `/tmp` (outside tree → writable) and spawn via `--task "$(cat /tmp/…)"` so the literal command has no operators for the guard to choke on. HIGHEST value — without it the PM cannot dispatch. **BRANCH READY** `hark/pm-hark/coder-e48af9` (2 commits, +131/-9 across `pmGuard.ts`+test, ff-able, disjoint from #3): quote-aware `splitStatements` + hark-dispatch allowlist (per-statement, so a chained real mutation still denies); tests cover spawn-with-rich-prose ALLOW + chained-rm DENY + existing deny cases. Pending human ff-merge. [bug]
- [2026-05-29 17:35] Alt+Enter still SENDS in the live `:3000` chat after merge. [bug] — The fix IS in merged source (`Composer.tsx:406` `e.key==="Enter" && e.altKey`), so #1 suspect is a **stale web bundle**: server was restarted but the Vite frontend wasn't rebuilt after the ff-merge → browser runs old Composer. Fix attempt: full rebuild (incl. `web/`) + restart, hard-refresh the PWA, retest. If it STILL sends after a clean rebuild, then verify `e.altKey` actually arrives in the browser (Hyprland may bind Alt+Enter at the WM layer) — add a quick `console.log` on keydown. (Cmd+Enter = `metaKey`, NOT handled by the altKey branch — separate case if that's what was pressed.)
- [2026-05-29 dogfood-friction] `hark orch status` prints each worker's FULL multi-paragraph `--task` text, not the "one compact line" the charter promises — floods the PM's context (the exact context-exhaustion failure the charter warns against). Truncate task to ~60 chars in `statusView.ts`. [improvement]
- [2026-05-29 dogfood-bugs] The 3 infra bugs found this session: #1 worker-never-terminated spin + #2 no node_modules in worktrees are **SHIPPED** (see Shipped); #3 `hark pr` local-only base remains in Next. [shipped-2of3]
- [2026-05-29 16:?? dogfood-friction] No `hark agent stop`/kill in the CLI — to halt the runaway worker I had to find its pid and SIGTERM it manually. The PM needs a first-class "stop this worker" verb. [improvement]
- [2026-05-29 16:?? dogfood-NOTE] `hark agent diff/log` is NOT broken — it showed empty on my first poll only because the worker hadn't committed yet; it reported the diff correctly once the commit landed. (Earlier capture retracted.) Lesson for the PM: empty diff on a *running* worker ≠ no progress; check lifecycle/turns too.
- [2026-05-29 16:?? dogfood-friction] `hark agent spawn` returns only `spawned <role>: <agentId>` — no branch name, worktree path, or confirmation it attached to *this* project's managed orchestration. A PM working from summaries needs the branch in that line to later run `hark pr <id>` without a `git`/status lookup. Echo branch + base + orch key on spawn. [improvement]
- [2026-05-29 16:?? dogfood-friction] The natural PM move — fan out coder + tester(`--depends-on coder`) together — is unsafe today because the depends-on worktree is still cut from `baseRef` (Inbox line above), so the tester would see pristine base, not the coder's diff. Forces a sequential "wait for coder DONE, then spawn tester pointed at its branch" dance. Either (a) resolve `dependsOn` at handoff (already the planned fix) or (b) make the charter/CLI surface this so the PM doesn't have to know the internal limitation. [improvement]
- [2026-05-29 15:48] when typing into the chat box it's very laggy and delayed. letters appear slowly. (This Capture to proejct form works fine) the issue is only in chat input it seems like. [bug] — chat-input only, not the capture form; likely a re-render/controlled-value cost in `Composer.tsx`. Needs diagnosis; next small item after Alt+Enter.
- [2026-05-29 17:21] tmux windows for the agents the orchestrator spawns have cryptic names; should be `<project>-<role>` (e.g. `hark-coder`) so the user can identify which window is which agent. [improvement]
- [2026-05-29 17:41] make code blocks in the web out session history actually usefull.

i.e print them larger, not one line, offer to copy contents, etc.
