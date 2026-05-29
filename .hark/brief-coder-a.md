Two related improvements to make the PM's `hark orch status` surface honest and controllable. Both live in the hark orchestration CLI/server stack — locate the code yourself (CLI in bin/hark, orch endpoints in the server, orchestrator/store under src/lib/orch/*).

PART 1 — add `hark agent stop <agentId>`
Today there is NO way to halt a wedged/zombie worker from the CLI; the PM must hunt its pid and SIGTERM by hand (dangerous: `pkill -f dist/server.js` also kills the live :3000 server). Add a `stop` verb that:
- SIGTERMs that worker's session process AND flips its lifecycle to a terminal state. Reuse the EXISTING terminal-kill path — the same killTerminalAgent/killSession machinery the reconcile loop uses to reap done/blocked/failed workers. Do not re-implement killing.
- KEEPS the worktree + branch (the PM still inspects the work) — identical to existing terminal-kill behavior.
- Is idempotent: stopping an already-terminal worker, or one whose pid is already dead, must NOT error — just report the current state.
- Fixes the zombie case: a worker whose pid is already dead but still shows `running` must, after `stop`, show a terminal lifecycle in `orch status`. (This is the live researcher-0bb21b symptom — status currently lies.)
- Is wired CLI verb -> backing endpoint -> orchestrator method, matching how the other `hark agent` subcommands are structured.

PART 2 — default-hide stale done-workers from `orch status`
Landed/terminal workers re-clutter the PM's primary surface. Make `hark orch status` HIDE terminal workers (done/blocked/failed/stopped) by default, and add a `--all` flag to show everything. Active workers (running/briefed/review/etc.) always show. Do NOT delete records — just filter the default view.

CONSTRAINTS:
- Follow existing patterns; keep changes minimal and idiomatic to the surrounding code.
- Add/extend unit tests: stop flips lifecycle + is idempotent on a dead/terminal pid; status default-hides terminal workers and --all reveals them.
- `npm test` green + tsc clean before you finish. Small commits.
- Emit the DONE marker with a concise summary of what changed (files + behavior) when finished.
