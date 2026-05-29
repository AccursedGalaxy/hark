# Orchestration: the head-session model

*Status: **Phase 1 + 2 built** (branch `orchestration`). Supersedes the planned
control-panel UI (diff viewer, "Create PR" button, conflict-resolution forms) as
the orchestration **control** surface. Builds on the shipped foundation in
[`orchestration.md`](orchestration.md).*

> **Built (2026-05-29).** Phase 1 core loop + Phase 2 `watch` are implemented and
> tested (TDD, full suite green):
> - `Orchestration.head` (`OrchHead`) + `head_spawned`/`head_notified` events +
>   `OrchAgent.task`/`dependsOn` (`src/shared/protocol.ts`).
> - Folder-trust pre-clear via atomic merge of `~/.claude.json`
>   (`src/lib/orch/trust.ts`).
> - `buildHeadBriefing` (`roles.ts`); `spawnHead` + `createWithHead` + worker
>   `task`/`dependsOn` (`orchestrator.ts`); `--permission-mode auto` + env/PATH
>   injection on spawn (`spawnSession.ts`).
> - Worker→head notification + `onHeadSignal` (head briefing delivery, head
>   metering, head-`DONE`→orchestration-complete) in `controller.ts`.
> - The `hark` CLI (`src/lib/orch/cli.ts` + `bin/hark`):
>   `orch status|watch`, `agent spawn|send|brief|diff|log`; spawn gated to
>   `HARK_ROLE=head`.
> - Server endpoints + reconcile/Stop-hook routing for the head (`server.ts`).
> - Dashboard: create form drops role chips; a Head card surfaces status/metrics.
>
> What remains is **Phase 3 polish** (`hark pr` helper, defaulting head-on) and
> the **live head-led validation** (running the autonomy loop against real Claude
> sessions). Same caveat as the worker autonomy loop: keystroke delivery (head
> briefing, worker→head notifications) is gated behind `HARK_ORCH_AUTONOMY=1`.

## The idea in one line

Each orchestration gets **one Claude Code session as the *head*** (foreman). It
talks to both the worker agents and the user. Main communication routes through
the head in natural language; the user can still drill into any worker directly.

> **Resolved decisions (2026-05-29).**
> 1. **Head spawns workers on demand** with specific tasks — *not* a fixed cold
>    5-role team. The roles become a **palette** the head draws from (it may spawn
>    two coders, skip the documenter, etc.), not a fixed roster.
> 2. **Action surface = `hark` CLI** (Bash-invokable). MCP is a later swap.
> 3. **Head always auto-spawns** on orchestration create. No headless mode going
>    forward (existing headless records must still be handled — see compat note).
> 4. Build path: **refine this spec first**, then Phase 1.

## Why this instead of more UI

hark's thesis is *drive Claude Code through tmux, don't replace the TUI*. A head
session is that thesis applied to orchestration — the coordination layer in the
same idiom as everything else.

It **relocates orchestration judgment** (decompose, assign, dedupe redundant work,
resolve branch collisions, decide what's worth a PR) out of hand-written state
machines and into a reasoning agent that already has `git`, `gh`, and file tools.
The "harvest" work that the UI path required — diff viewer, PR button, conflict
resolution — mostly evaporates: a head session runs `git diff`, judges which branch
wins, and runs `gh pr create` itself. A UI can *show* a conflict; the head can
*resolve* it.

Dogfood evidence (run `orch-mpqus500-733ba9`): with five role-workers spawned cold
off a shared base and no coordinator, **coder and tester both independently
implemented the same `dependsOn` feature** on separate branches that don't merge
cleanly. A head would have dispatched the feature to one worker and pointed the
other at testing *its* branch.

## What carries over unchanged

Worktree isolation, the orchestration store + append-only event log, the hardened
tmux send path (`sendInput`), the Stop-hook marker scan, and the metrics pipeline
all stay. We add a head role and a thin action surface on top, and **delete the
planned React control panel** from the roadmap. Observability UI (see the team at a
glance, drill into a worker) stays — the head replaces the *control* surface, not
the *window*.

## Model

```
Orchestration
├── head   : one CC session (worktree hark/<orch>/head)  ── talks to user + workers
└── agents : N worker CC sessions (role + isolated worktree)   ← unchanged
```

The head is **not** an entry in `agents[]`. It lives on the orchestration record
directly (`Orchestration.head`). This is what keeps it naturally exempt from the
worker nudge loop, which iterates `agents[]`.

### Lifecycle of a run

1. **Create** — user creates an orchestration (just **name, goal, project,
   baseRef** — no role chips; the head decomposes). hark always spawns the head
   session in `hark/<orch>/head`, clears its trust prompt (see Sharp Edge 0), and
   delivers the **head briefing** (goal, the role palette, the action surface,
   mandate: decompose → dispatch → harvest → report; context discipline).
2. **Dispatch** — the head spawns workers *on demand with specific tasks*
   (`hark agent spawn coder --task "…"`), drawing from the role palette and choosing
   how many of each. This is the direct fix for the redundant-work failure.
3. **Run** — workers execute in isolation, hit markers (`[[HARK:DONE]]` /
   `[[HARK:BLOCKED]]` / `[[HARK:HANDOFF]]`).
4. **Notify** — the Stop-hook marker scan, instead of only flipping worker
   lifecycle, **sends the head an inbound tmux message**: role, agentId, branch,
   diffstat, commit count, and the marker summary text. The head wakes and decides
   the next step. This turns the autonomy controller we already built into the
   **event bus** — ~80% of the plumbing exists.
5. **Steer (user)** — the user talks to the head anytime via normal session chat:
   "status?", "have the coder add tests", "open a PR for the best branch". The head
   acts via the CLI / git / gh and reports back.
6. **Close** — the head emits `[[HARK:DONE]]` when the orchestration goal is met →
   hark marks the orchestration `done` and (phase 2) pushes a notification to the
   user. Worker markers control *agent* lifecycle + head notification; head markers
   control *orchestration* lifecycle.

## The action surface (load-bearing build)

A Claude Code session can't call hark's HTTP API out of the box, so the head needs
a way to act. Ship a thin **`hark` CLI** (Bash-invokable, hits the existing
localhost API). hark sets these env vars when spawning the head so the CLI
auto-targets the right run:

```
HARK_ORCH_ID=orch-…     HARK_ROLE=head     HARK_API=http://localhost:3000
```

Commands (start here; all back onto existing or thin-new endpoints):

| Command | Purpose | Output discipline |
|---|---|---|
| `hark orch status` | per-agent role / lifecycle / branch / **diffstat** / last-marker summary / turns·tokens | **lean** — one line per agent, NO transcripts |
| `hark agent spawn <role> --task "…" [--depends-on <id>]` | spawn a worker with a specific charter | returns agentId |
| `hark agent send <id> "…"` | steer / message a worker (reuses `sendToAgent`) | ack |
| `hark agent diff <id> [--stat\|--full]` | worker branch vs base | `--stat` default; `--full` on demand only |
| `hark agent log <id>` | recent commits on the worker branch | compact |
| `hark agent brief <id> "<task>"` | assign next task (re-brief) | ack |
| `hark orch watch` | block until the next worker marker event, print it, exit | one event (phase 2; long-poll) |

`gh pr create` / merges: the head runs `git`/`gh` directly (it has Bash). An
optional `hark pr <id>` convenience wrapper (push branch + `gh pr create --base`)
is phase 3 polish, not core.

> **CLI vs MCP.** Start with the CLI — no server registration, works in any session,
> trivial to test. An MCP server (structured tool calls) is the nicer long-term
> shape and can replace the CLI later without changing the model.

## Context discipline — the make-or-break

The head cannot hold five transcripts × 100+ turns. It must operate like a human
lead: from summaries, pulling detail only when a decision demands it.

- `hark orch status` is deliberately compact (one line/agent).
- Worker→head notifications carry the **marker summary + diffstat + commit count**,
  never the transcript.
- The head reads full diffs / files (`hark agent diff --full`) only when a judgment
  requires it (e.g. resolving a branch collision), and scopes it tight.
- The head briefing says this explicitly: *"You are a lead, not a reader. Work from
  summaries; pull detail only when a decision needs it."*

If we let the head slurp transcripts, it dies in ~20 minutes. This constraint is a
first-class design requirement, not a nicety.

## Sharp edges

**0. Two permission gates, not one** (investigated 2026-05-29, CC v2.1.156). The
dogfood only surfaced the first; an unattended head loop hits both.

  **Gate 1 — folder trust** ("Do you trust the files in this folder?"), once at
  startup. We manually cleared five of these in the dogfood; with head-always +
  spawn-on-demand it must clear unattended for the head AND every worker.
  - `--dangerously-skip-permissions` does **not** affect this gate (it's the
    tool-permission layer — different concern).
  - `-p`/headless skips trust but is **incompatible with our model**: hark spawns a
    *persistent interactive TUI* (`spawnSession.ts`) driven by send-keys; `-p` prints
    and exits. Using it would gut the interaction model we must keep.
  - **CHOSEN: pre-write `~/.claude.json`.** Verified shape:
    `projects["<absolute-worktree-dir>"].hasTrustDialogAccepted = true`. Write the
    entry *before* spawning and the dialog never fires. Undocumented but stable since
    v2.1.x. Caveats: **per-exact-path** (no parent coverage — one entry per head +
    per worker, written at spawn time), and the file also holds `oauthAccount` + live
    state, so the write MUST be an **atomic, merge-preserving read-modify-write**
    (temp + rename; never clobber). Low-severity race if another CC instance flushes
    a different project entry concurrently — acceptable.

  **Gate 2 — tool permissions** (Bash/Edit/etc. mid-run). The dogfood got lucky
  ("no walls hit"); an autonomous loop will eventually block here.
  - **CHOSEN default: `--permission-mode auto`.** A safety classifier auto-approves
    safe tool calls and only prompts on genuinely risky ones (destructive Bash,
    network, etc.). This is the same classifier that gates Claude Code's own auto
    mode. It fits the head model *because* a gated call is no longer a silent hang:
    the worker enters `waiting`/pending, and the marker→notify path escalates it to
    the head (or the user) as "needs a decision." Safe-by-default **with an
    escalation valve**, instead of either silent auto-run or a dead stall.
  - **Opt-in escape hatch: `bypassPermissions`** (≡ `--dangerously-skip-permissions`)
    per-run, for runs the user fully trusts or when the classifier is unavailable.
  - Caveat: auto mode needs the classifier reachable; when it isn't (observed twice
    on 2026-05-29) it falls back to prompting → a *recoverable* stall via the notify
    path, not a hang. Worktree isolation remains the backstop for both modes.

1. **The head is itself a watched session.** Stop hooks fire on it. It must be
   exempt from the worker nudge loop (achieved by keeping it off `agents[]`) and
   its markers must be interpreted at *orchestration* scope, not agent scope.
2. **Context budget** — see above; the ceiling on this whole design.
3. **User↔head↔worker consistency** — if the user pokes a worker directly, the
   head's model goes stale. The head must re-read state via `hark orch status`
   rather than assume. Cheap, but it has to be disciplined (briefed).
4. **Async turn-taking** — steering a worker → minutes of think time. The head says
   "dispatched, I'll report when it lands" and is woken by the marker→notify path;
   it should not busy-poll (use `hark orch watch`).
5. **Spawn must be head-only.** `hark agent spawn` is gated to `HARK_ROLE=head`, so
   a worker can't recursively spawn its own sub-team and fork-bomb the host.
6. **Head markers are orch-scoped.** The marker scanner already keys off
   sessionId/pid; because the head is on `Orchestration.head` (not `agents[]`), the
   controller interprets head `[[HARK:DONE]]` as *orchestration done*, not agent done.
7. **PR creation preconditions.** Opening PRs needs an `origin` remote + authed `gh`.
   The dogfood baseRef was a local branch with no remote — PRs would fail. The head
   must check (and tell the user) rather than assume. Worker branches share the
   object store, so the head runs `git`/`gh` from its own worktree against any branch.
8. **Head is metered like a worker.** Track head tokens/turns and surface them; a
   coordinating head accrues real cost and should be visible, not hidden.

## Concrete change map

- **`src/shared/protocol.ts`** — add `Orchestration.head?: { sessionId?, pid?,
  worktreeDir, branch, briefedAt? }`; extend `OrchEventKind` with `head_spawned`,
  `head_notified`.
- **`src/lib/orch/orchestrator.ts`** — `spawnHead(orchId)` (head worktree + session
  + record + trust-clear); extend worker `spawnAgent` with `task` / `dependsOn`
  (overlaps the inbox `dependsOn` item — coder/tester branches already drafted most
  of this). `createTeam`'s fixed sequential 5-spawn is no longer the entry path —
  the head drives spawning; the create endpoint only makes the record + spawns head.
- **trust-clearing** — a `clearTrust(dir|session)` step (pre-trust config write, or
  prompt-detect-and-accept, or skip-permissions flag — pending Sharp Edge 0). Used
  for both the head and every head-spawned worker.
- **`src/lib/orch/controller.ts`** — in `onAgentSignal`, when the orchestration has
  a head, build a notification and `sendText(headPane, …)` on a worker marker
  (in addition to / instead of the lifecycle flip). Head excluded from
  `decideAutonomyAction`.
- **`src/lib/orch/roles.ts`** — a `buildHeadBriefing(ctx)` (mandate + roster +
  action-surface cheatsheet + context discipline).
- **`src/server.ts`** — endpoints backing the CLI: `POST /orchestrations/:id/head`
  (spawn head), `POST .../agents/:id/send`, `GET .../agents/:id/diff`, long-poll
  `GET .../events?since=` for `hark orch watch`. (`brief` and detail/status already
  exist.)
- **`bin/hark`** (new) — thin Node HTTP client; reads `HARK_ORCH_ID` / `HARK_API`.
- **`web`** — create form drops the role chips (just name/goal/project/baseRef);
  surface the head prominently ("Open head" affordance + head status/metrics).
  Observability only.
- **compat** — existing headless orchestration records (`head === undefined`) must
  keep working: reconcile/controller/summary all guard on the head's presence.

## Phasing

- **Phase 1 (core loop) — DONE.** head role + `spawnHead` + head briefing +
  `hark` CLI (`status` / `send` / `diff` / `spawn` / `brief` / `log`) +
  worker→head marker notification. User↔head chat drives everything; head uses
  raw `git`/`gh` for PRs.
- **Phase 2 — mostly DONE.** `hark orch watch` long-poll ✅; head emits
  orchestration-level `DONE` → orchestration marked `completed` ✅ (user *push*
  notification still pending — Web Push isn't built yet); dashboard head
  surfacing ✅.
- **Phase 3 — pending.** `hark pr` helper, defaulting head-on, polish.

## Spawn env (how `hark` reaches the head)

The orchestrator spawns the head/workers through the existing tmux path with:
- `--permission-mode auto` as the claude invocation (Gate 2 default);
- env `HARK_ORCH_ID` / `HARK_ROLE` / `HARK_API` injected into the session so the
  CLI auto-targets the run (and `HARK_ROLE` gates `agent spawn` to the head);
- the repo's `bin/` prepended to the session `PATH` so `hark …` resolves. The
  `bin/hark` runner imports the compiled `dist/lib/orch/cli.js`, so **`npm run
  build` must run before spawning** orchestration sessions.

Env injection is two-shell-layer aware (`sh -c` → login shell): values are
single-quoted for the login shell, and `$PATH` stays unquoted so it expands
after rc files load. See `buildLoginShellCommand` in `spawnSession.ts`.

## Settled (2026-05-29)

- Worker spawning → **head, on demand** (roles are a palette).
- Action surface → **`hark` CLI**.
- Head activation → **always auto-spawn**.
- Head location → **own worktree `hark/<orch>/head`** (clean tree for git/gh; reads
  all worker branches via the shared object store).

- Folder-trust (Gate 1) → **pre-write `~/.claude.json` per worktree** (atomic merge).
- Tool-permission (Gate 2) → **`--permission-mode auto`** default + `bypassPermissions`
  opt-in escape hatch; gated calls escalate via the marker→notify path.

## Still open (owner: user)

1. **No-remote case:** if the project has no `origin` / `gh` auth, should the head
   stop at "branch ready, here's the diff" (no PR), or should hark help set up the
   remote? Default to the former unless told otherwise.
