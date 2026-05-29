# Orchestration — multi-agent layer

The orchestration layer turns hark from a single-session remote control into a
power tool for running **multiple Claude Code sessions as a coordinated team**.
It is glue on top of the existing foundation, not a rewrite: every agent is
still an ordinary Claude Code session driven by `tmux send-keys`. The
interaction model is unchanged — orchestration adds isolation, roles, autonomy,
and bookkeeping around it.

> Status: **backend complete + dashboard shipped + head-session model built**
> (branch `orchestration`). The libraries, orchestrator service, autonomy
> controller, server endpoints + reconcile loop, and the web dashboard all exist
> and are tested. On top of that, the **head-session model** is built (Phase 1+2)
> — each orchestration spawns a coordinating *head* Claude session that decomposes
> the goal, spawns workers on demand, and is driven via the `hark` CLI. See
> [`orchestration-head.md`](orchestration-head.md). What remains: validating the
> active autonomy loop against live Claude sessions before defaulting it on. See
> PLAN.md.

## The model

```
Orchestration  (a named mission against one git repo)
  └── Agent     (a role, an isolated worktree+branch, a Claude Code session)
        └── events.jsonl  (decisions, checkpoints, blocks, failures, metrics)
```

- **Orchestration** — a mission (`name` + `goal`) targeting one project
  (`projectRoot`). Agents branch off `baseRef`. (`Orchestration` in
  `src/shared/protocol.ts`.)
- **Agent** — one role, pinned to its own git worktree + branch, backed by one
  Claude Code session. Carries a `lifecycle` and accumulated `metrics`.
  (`OrchAgent`.)
- **Event log** — an append-only JSONL stream per orchestration. The audit
  trail: `decision`, `checkpoint`, `blocked`, `handoff`, `failure`, `metric`,
  lifecycle transitions. (`OrchEvent`.)

Persistence follows hark's "everything is a file, no database" rule. Runtime
state lives under `~/.hark/`:

```
~/.hark/orchestrations/<orchId>/orchestration.json   # the record (agents inline)
~/.hark/orchestrations/<orchId>/events.jsonl         # append-only audit log
~/.hark/worktrees/<project>/<orchId>/<agentId>/      # isolated checkouts
```

Worktrees live *outside* any repo's working tree, so they never appear in the
parent's `git status` or get committed by accident.

## Isolation — worktree per agent

`src/lib/orch/worktree.ts` wraps `git worktree`. Each agent gets:

- a branch namespaced under `hark/<orch>/<role>-<shortId>` (slugified to a
  always-valid git ref), and
- a directory under `~/.hark/worktrees/...`, created with
  `git worktree add -b <branch> <dir> <baseRef>`.

Agents edit, stage, and commit fully independently; the user's main checkout is
never touched. Cleanup is `git worktree remove --force` + optional branch
delete + `git worktree prune` for directories deleted out from under git.

The module is split the way the rest of hark is: pure argv builders + porcelain
parsers up top (unit-tested without a repo), thin `execFile` wrappers at the
bottom.

## Roles

Five roles, defined in `src/lib/orch/roles.ts`:

| Role | Mission |
|------|---------|
| **Researcher** | Maps the problem space, produces a findings brief with file:line citations. |
| **Coder** | Implements on the isolated branch in small commits, keeps the build green. |
| **Tester** | Writes/runs tests + linter + type-checker, reports real results. |
| **Documenter** | Updates docs and PLAN.md to match what actually shipped. |
| **Reviewer** | Adversarially reviews the diff, gives a prioritized verdict. |

A role is a **charter**, not a different model — mission, operating rules, and a
**definition of done** (the role's self-review checklist). `buildAgentBriefing`
renders all of this into the first message sent to the agent's session over the
unchanged tmux path. The briefing also tells the agent its isolated
branch/worktree and the autonomy protocol below.

## Autonomy — markers, checkpoints, self-review

Agents signal state by printing **marker tokens** the controller scans for in
the transcript:

- `[[HARK:DONE]]` — finished and self-reviewed against the definition of done.
- `[[HARK:BLOCKED]]` — needs a human decision (the question precedes it).
- `[[HARK:HANDOFF]]` — output is ready to pass to another role.

This is the seam for the **stop-hook controller** (next increment): hark
already installs `Stop`/`SubagentStop` hooks (`src/lib/installHook.ts`) that
POST to `/api/hook`. The controller will, on an agent's Stop, read its
transcript tail, and:

- see `DONE` → mark the agent `done`, advance the pipeline (e.g. Coder → Tester
  → Reviewer);
- see `BLOCKED` → mark `blocked`, surface the question for the human (existing
  attention machinery), record an `intervention` when resumed;
- see neither → the self-review loop: nudge the agent to continue toward its
  definition of done (a bounded number of times, default 3), then escalate to
  `blocked` — the "don't stop until the condition holds" pattern hark's own
  `/goal` uses.

This is implemented in `src/lib/orch/controller.ts`: `decideAutonomyAction` is
the pure policy, `AutonomyController.onAgentSignal(stopped)` the IO shell.
`src/server.ts` wires it — a 3 s reconcile loop backfills session ids
(`correlation.ts`, matching live sessions to agents by pid), refreshes metrics,
and drives delivery; the `/api/hook` `Stop` path triggers a turn-boundary
decision.

**Active autonomy is opt-in** via `HARK_ORCH_AUTONOMY=1`, because it types real
keystrokes (briefings, nudges) into live sessions on your behalf. With it off,
orchestrations still spawn agents and the dashboard still tracks metrics; you
deliver briefings yourself with `POST .../agents/:agentId/brief` and drive each
agent through the normal session view (the unchanged tmux-send model).

**Plan-as-code:** the briefing instructs each agent to record significant
decisions; those, plus lifecycle transitions, land in `events.jsonl`.

## Metrics — document everything

`AgentMetrics` (per agent) accumulates from the transcript and lifecycle:

- tokens (input/output/cache-read/cache-creation) and `costUsd` — reusing the
  existing usage accounting (`web/src/lib/usage.ts`, `MessageUsage`);
- `autonomyMs` — wall-clock spent running (excluding blocked time);
- `interventions` — how many times a human had to step in;
- `turns`.

Roll-ups (success rate across agents, total autonomy time, cost per
orchestration) are derived from these + the event log.

## What's hardened in the foundation

The tmux send path (`src/lib/sendKeys.ts`) — the thing we explicitly keep — was
hardened for multi-agent fan-out, where many sends race across many panes:

- **Per-pane serialization.** Concurrent sends to one pane queue through a
  promise lock, so two clients (or two controller actions) can't interleave
  their keystrokes into one garbled prompt. Distinct panes still run
  concurrently. The whole composer payload (attachments → text → Enter) goes
  through as one atomic operation (`sendInput`).
- **Copy-mode escape.** Before sending, hark probes `#{pane_in_mode}` and
  cancels any active mode — the classic "I typed but Claude never saw it" bug
  when the pane is scrolled up.
- **Existence check + structured errors.** The same probe verifies the pane
  exists; a gone pane fails fast as a `TmuxSendError` (fatal), instead of
  silently succeeding.
- **Bounded retries + timeouts.** Transient tmux failures retry with short
  backoff; every invocation has a timeout so a wedged tmux can't hang a request.

## Module map

```
src/shared/protocol.ts          # wire types: Orchestration, OrchAgent, AgentMetrics, OrchEvent, AgentRole
src/lib/sendKeys.ts             # hardened tmux send path (sendInput, withPaneLock, preflight)
src/lib/orch/worktree.ts        # git worktree isolation
src/lib/orch/roles.ts           # role charters + briefing + autonomy markers
src/lib/orch/store.ts           # file-backed registry + append-only event log
src/lib/orch/orchestrator.ts    # service: worktree + spawn + roles + head, DI, rollback
src/lib/orch/controller.ts      # autonomy: marker scan, self-review loop, metrics, head signals
src/lib/orch/correlation.ts     # match live sessions to agents + head by pid
src/lib/orch/trust.ts           # atomic merge-preserving ~/.claude.json folder-trust pre-clear
src/lib/orch/cli.ts             # pure hark-CLI planner + response formatters
src/lib/orch/statusView.ts      # build the lean OrchStatusView for `hark orch status`
bin/hark                        # the hark CLI runner (thin fetch+IO over cli.ts)
src/server.ts                   # endpoints + reconcile loop + Stop-hook wiring
web/src/hooks/useOrchestrations.ts        # polling hook (list + detail)
web/src/components/OrchestrationPanel.tsx # dashboard: list, spawn form, agents, metrics, events
```

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/orchestrations` | Create + staff a team. Body: `{ name, goal, projectKey, baseRef?, roles? }`. `projectKey` must be a project the server already resolved from a live session (no arbitrary paths). `roles` defaults to the full team. |
| `GET` | `/api/orchestrations` | List orchestrations, newest first. |
| `GET` | `/api/orchestrations/:id` | One orchestration record + its `events.jsonl`. |
| `POST` | `/api/orchestrations/:id/teardown` | Remove all agent worktrees, archive the orchestration (branches kept). |
| `POST` | `/api/orchestrations/:id/agents/:agentId/brief` | With no body: deliver an agent its role briefing and mark it running. With `{ task }`: re-brief the worker with its next task. |

### Head-session model endpoints (back [`orchestration-head.md`](orchestration-head.md))

The create endpoint above now spawns a **head** session (no `roles` — the head
decomposes the goal and spawns workers itself). The `hark` CLI hits these:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/orchestrations/:id/status` | Lean status view (one line/agent + head, with diffstat). `hark orch status`. |
| `GET` | `/api/orchestrations/:id/events?wait=1` | Long-poll: block until the next event, return it. `hark orch watch`. (`?since=<count>` without `wait` for an immediate slice.) |
| `POST` | `/api/orchestrations/:id/head` | (Re-)spawn the head session. Idempotent when a live head exists. |
| `POST` | `/api/orchestrations/:id/agents` | **Head-only** (gated by `x-hark-role: head`): spawn a worker `{ role, task, dependsOn? }`. `hark agent spawn`. |
| `POST` | `/api/orchestrations/:id/agents/:agentId/send` | Steer a worker with a free-text message. `hark agent send`. |
| `GET` | `/api/orchestrations/:id/agents/:agentId/diff?mode=stat\|full` | Worker branch vs base. `hark agent diff`. |
| `GET` | `/api/orchestrations/:id/agents/:agentId/log` | Recent commits on the worker branch. `hark agent log`. |
