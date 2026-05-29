# PM-Head Orchestration Harness — build spec

*Status: **Phases A–D built** (branch `pm-head-harness`, 2026-05-29; not merged).
This is the target architecture for turning hark's shipped head-session engine
into a first-class, semi-autonomous project harness: a persistent
product-manager session that ideates with you, owns `PLAN.md`, and dispatches a
worker team to ship/test fast — without ever surprising your working tree or
interrupting your thinking.*

> **Build progress.**
> - **Phase A — DONE (unit-tested + dogfooded on `:3999`).** Promotion (`hark
>   head init` → `POST /api/head/promote`, charter returned as the command's
>   stdout so nothing is force-typed; `/head` slash command in `.claude/commands/`),
>   the CLI env-fallback (`GET /api/head/resolve?cwd=` resolves the project's
>   managed head when `HARK_ORCH_ID` is unset, unlocking `agent spawn`), the PM
>   charter (`buildPmHeadBriefing` in `roles.ts`), and the pure-PM `PreToolUse`
>   enforcement hook (`pmGuard.ts` — denies `Write`/`Edit`/`NotebookEdit`/
>   `MultiEdit` outside PLAN.md + `.hark/`, and tree-mutating `git`/`rm`/redirects
>   in Bash; wired into `/api/hook` via a stdout-preserving decision-hook command,
>   gated to `managed` head sessions only). New protocol: `Orchestration.managed`
>   + `autonomyLevel` (+ `AutonomyLevel`/`DEFAULT_AUTONOMY_LEVEL=L2`).
> - **Phase B — DONE (unit-tested + dogfooded on `:3999`).** The newsroom
>   projection (`newsroom.ts` — a project-level, filtered, cursored merge over
>   the per-orch `events.jsonl`, spanning ALL the project's active
>   orchestrations per §8.2), `GET /api/projects/:key/newsroom?since=` (dashboard
>   feed, diffstat-enriched server-side), and the `UserPromptSubmit` delta hook
>   (injects "TEAM NEWS since your last turn" as `additionalContext`, advances a
>   per-head `newsCursor`, gated to managed head sessions). Worker transitions
>   are fed to the newsroom via `agent_lifecycle` events (decoupled from any
>   push); a managed head pulls — `notifyHead` no longer pushes into a managed
>   head's live pane (invariant: nothing force-types). Charter gains a news-triage
>   section (surface-now vs note-to-PLAN).
> - **Phase C — DONE (unit + integration-tested; dial dogfooded on `:3999`).**
>   The per-project autonomy dial (`POST /api/orchestrations/:id/autonomy` +
>   `hark head autonomy <L0|L1|L2|L3>`, default L2). Mode-based routing for a
>   managed head's worker transitions (`decideHeadRouting`): blocker → escalate
>   to the human (`escalateToHuman` — pages via the existing attention layer, a
>   needs-you Notification on the head session; always wired); pipeline advance →
>   pull while the conversation is active, or an autonomous advance-push
>   (`buildAdvancePush`/`pushHeadTurn`) once idle (no human prompt past 90s) and
>   the dial is L2/L3; L0/L1 idle → wait. `lastHumanAt` (set each
>   UserPromptSubmit) drives the active/idle decision. The push path is wired
>   ONLY under `HARK_ORCH_AUTONOMY=1` (it types into the session); escalation is
>   not (it doesn't). **Full idle-loop + escalation LIVE validation needs real
>   worker sessions under autonomy — deferred to the existing live-validation
>   thread; logic is integration-tested with fakes.**
> - **Phase D — DONE (unit-tested; registry + wiring dogfooded on `:3999`).**
>   `hark pr <agentId> [--title]` → `POST .../agents/:agentId/pr` (`pr.ts`:
>   pushes the branch + `gh pr create --base`, NO checkout against root; degrades
>   to a ready-branch + diff with no `origin`, push-only with no `gh` — human
>   still lands). Integrator-worker pattern + `hark pr` taught in the charter.
>   Managed-mode registry: `GET /api/projects/:key/head` (managed? dial? head
>   status?); dashboard surfaces a "PM · <dial>" badge in the orchestration list
>   + a "PM-head / autonomy <Lx>" row in the detail view. **The `hark pr`
>   happy-path (real push + PR) needs a worker branch + remote — folds into the
>   live-validation thread; all four preparePr branches are unit-tested.**
>
> **Enforcement boundary (honest scope).** The `PreToolUse` guard is airtight on
> the `Write`/`Edit` surface (LLM agents mutate files almost exclusively through
> those tools — path resolution is exact). The Bash parse (tree-mutating `git`,
> `rm`, `sed -i`, `>` redirects) is a best-effort backstop layered on the charter
> + the read-only-by-construction posture, not a sandbox; obfuscated shell
> mutation is charter-bounded, not hook-blocked. This matches §3.8's explicit
> hook scope ("Edit/Write/mutating-git"). Setup note: requires `npm run build`
> and re-running `install-hooks` so the `PreToolUse` decision hook is wired, and
> `hark` on PATH for promotion from an arbitrary session.

*Reasoning trail (why each decision): `docs/orchestration-head.md` §"Direction: the
persistent PM-head". The shipped engine this builds on (head spawn, workers,
worktrees, `hark` CLI, marker scan, autonomy controller, dashboard, trust
pre-clear): `docs/orchestration-head.md` (Phase 1+2, built). This doc is the
actionable blueprint — START HERE.*

## 1. What it delivers

- **Ideate** — open Claude Code in a project, chat with a PM that reasons about
  features/bugs/direction and captures to `PLAN.md` live.
- **Ship** — when you converge, the PM decomposes the work and dispatches isolated
  workers, reviews their diffs, integrates, and hands you a PR / ready branch.
- **Test** — verification is delegated to workers (each runs its own tests) or a
  dedicated tester worker.
- **Fast** — workers run in parallel; the pipeline advances in the background while
  you're away, bounded by an autonomy dial you set.

## 2. Decided foundations (do not re-litigate)

1. **Persistent, project-scoped PM-head**, not a task-scoped executor. "Head" is a
   **role any session resumes by re-reading `PLAN.md`** — the durable brain is
   `PLAN.md` + inbox + issues, not the session's context window. (Solves
   context-longevity.)
2. **Pure PM — never writes or runs code.** Read-only on the working tree;
   `Write`/`Edit` scoped to `PLAN.md` + coordination files only; enforced by a
   `PreToolUse` hook, not trust. (Makes the tree safe by construction.)
3. **Git-safety:** reads in place; all mutations routed to an integration worktree
   (`git -C`) / integrator worker / PRs-from-branches; the final fast-forward
   **landing stays the human's**.
4. **Notifications:** routine → pull; blocker → escalate to the human; pipeline
   advance → idle loop (see §3.5). Nothing ever force-types into a live conversation.

## 3. Architecture

```
YOU (founder) ── converse ──▶ PM-HEAD ── dispatch ──▶ WORKERS (n, isolated worktrees)
  ▲  ▲                        (1/project,                  │ markers (done/blocked/handoff)
  │  └─ dashboard (ground truth, badges)                   ▼
  │                           owns PLAN.md) ◀─ newsroom bus ┘  (project-level, filtered, cursored)
  └──────── blocker page (hark notifications) ◀────────────┘
```

### 3.1 Durable state (outlives every session)
- `PLAN.md` — PM brain + human board (North Star / Now / Next / Shipped / Inbox).
- GitHub issues — finer-grained task tracking (optional).
- per-orch `events.jsonl` — raw append-only team event log (built).
- worktrees + branches under `~/.hark/worktrees` (built).
- **per-project orchestration registry** — which head + orchestrations are live for a
  project (new; small extension of the store).

### 3.2 The PM-head
- **One per project**; a role, not a fixed session. Promoted from *your* existing
  session (lives in the main working dir — sees your live WIP read-only), not spawned
  fresh in a worktree.
- **Charter** (evolve `buildHeadBriefing` in `roles.ts`): PM persona — owns `PLAN.md`
  (targeted edits, Now capped at 3, drain Inbox), holds the North Star, reasons
  before dispatching, decides per item **you-apply vs propose-patch-in-chat vs
  dispatch-a-worker**, triages news (§3.5).
- **Two modes:**
  - *Conversational* (you're active): drains the newsroom at the **top of each turn**
    via a `UserPromptSubmit` hook that injects the news delta; triages each item
    surface-now vs note-to-PLAN.
  - *Idle* (conversation quiet): hark pushes event-driven turns (see §3.5) so the team
    advances; the head is **never blocked on a long-poll**, so your input always
    interleaves at the next turn boundary.

### 3.3 Workers
- Ephemeral, task-scoped, spawned on demand by the head with a specific task + base
  (built: `spawnAgent` with `task`/`dependsOn`).
- Each in its own worktree; sequential ones lazily branch off the upstream at handoff.
- **Run their own tests** (verification delegated). Emit `DONE`/`BLOCKED`/`HANDOFF`
  markers → events (built: marker scan).

### 3.4 The newsroom bus
- A **project-level, filtered, cursored projection** over the per-orch `events.jsonl`
  files — NOT the raw log. Filtered to head-relevant items: worker done/blocked/
  failed/milestone, each carrying summary + diffstat + branch.
- New endpoint: `GET /api/projects/:key/newsroom?since=<cursor>` → ordered deltas +
  next cursor, merged across the project's live orchestrations.
- Backs both the `UserPromptSubmit` delta injection and the dashboard feed.

### 3.5 Signal tiers (closes the notification holes)
1. **Routine** → **pull** at turn boundaries via the delta hook. Never interrupts.
2. **Blocker** → **escalate to the human** through hark's existing attention/
   notification layer (the same path that flags a solo session going ASKING). A
   worker `BLOCKED` event is marked attention-needed; the human is paged and tells
   the head to redirect. Bounds blocker latency by human awareness; keeps the head's
   context clean.
3. **Pipeline advance** → **idle loop**, gated by the autonomy dial (§3.6).

> **Mode-based routing (key implementation note).** The *same* worker event routes
> differently by mode, and the idle loop reuses the **existing push mechanism** so the
> head never blocks:
> - *Active conversation* (recent human turn): event → newsroom → injected at the
>   next human turn (pull). No push.
> - *Idle* (no recent human turn) **and** dial permits: hark's reconcile/`onAgentSignal`
>   **pushes the head a turn** ("team event X — advance per L2") via the send path
>   (built). The head acts and yields; because it's event-driven turns rather than a
>   blocking `hark orch watch`, your messages always interleave at turn boundaries.
>
> "Mode" = recency of human input (e.g. no human message for N seconds → idle).

### 3.6 The autonomy dial (per project; what makes it *tunably* autonomous)
| Level | The head… |
|---|---|
| **L0 Propose** | only suggests plans/diffs; you dispatch & apply everything |
| **L1 Assisted** | dispatches on your approval; advances only on your nod |
| **L2 Supervised-auto** *(proposed default)* | when idle, autonomously advances the pipeline (done→next, spawn tester, open PR); **escalates blockers, never lands** |
| **L3 Background** | runs whole features end-to-end while you're away; batches for review on return |
The dial governs the §3.5 idle loop only. The human always: sets the dial, owns every
landing, is paged for blockers.

### 3.7 Git-safety model
- **Reads in place:** `git diff base..branch`, `log`, `show <ref>:<path>`, your WIP.
- **Mutations elsewhere:** PRs pushed from branches with **no checkout** (`git push`
  + `gh pr create`); merges/conflict-resolution in a hark-managed integration
  worktree via `git -C <dir>` (head's cwd stays your dir) or by an **integrator
  worker**; never `checkout`/`merge`/`rebase`/`add -A` against the project root.
- **Final landing = human** (or explicit head action you trigger), at a moment you
  choose. Covers the no-remote case (head hands you a ready branch).
- **Tree writers partitioned:** you (hand/editor, head observes) + workers (isolated).
  The head writes neither code.

### 3.8 Hooks (the enforcement + injection layer)
hark configures Claude Code hooks scoped to the head session and receives them at its
hook endpoint (extends the existing `/api/hook` Stop/SubagentStop plumbing):
- **`PreToolUse`** — deny any `Edit`/`Write`/mutating-`git` whose path resolves to
  source or the project root. Enforces pure-PM (§2.2) + git-safety (§3.7).
- **`UserPromptSubmit`** — fetch the newsroom delta and prepend it to each head turn
  ("TEAM NEWS since last turn: …"). Makes the pull reliable + non-interrupting.

## 4. Feature lifecycle (idea → shipped)
1. **Ideate** — chat; head reasons, captures to PLAN Inbox/Now.
2. **Converge** — head proposes a decomposition (tasks + `dependsOn`, parallel where
   independent); you approve (auto at L2+).
3. **Dispatch** — head spawns isolated workers.
4. **Advance** — workers `DONE` → idle loop / next-turn pull fires the next stage
   (tester on the coder's branch); head reviews **diffs**, not transcripts.
5. **Integrate** — collisions → integrator worker / integration worktree; head
   prepares a PR or ready branch.
6. **Land** — head pings "ready"; **you** fast-forward / merge. Head moves PLAN
   Now→Shipped, drains Inbox.
7. **Blocker anytime** → human paged → redirects.

## 5. Every grilled hole, and what closes it
| Hole | Closed by |
|---|---|
| Blocker latency | Tier-2 human escalation (§3.5) |
| Team stalls when you're silent | Tier-3 idle loop + dial (§3.5/3.6) |
| "Natural break" undefined / head forgets to pull | `UserPromptSubmit` delta hook (§3.8) |
| Pull pollutes the conversation | Relevance triage in charter (§3.2) |
| Per-orch bus vs per-project PM; raw feed | Newsroom projection (§3.4) |
| "Meetings" are slow async | Read artifacts (diff + transcript tail); message to redirect |
| Head mutates your dirty tree | Pure-PM hook + worktrees + human lands (§2/3.7) |
| Context longevity | PLAN as brain + context-lean pure PM (§2.1) |
| Idle loop blocking out human input | Event-driven push turns, not blocking watch (§3.5 note) |

## 6. Built vs new
**Reused (shipped):** worktree isolation, store + `events.jsonl`, hardened send path,
marker scan, autonomy controller (briefing/nudge/reconcile + `onAgentSignal`/
`onHeadSignal`), metrics, the `hark` CLI (`status/watch/spawn/send/brief/diff/log`),
head spawn + briefing, worker→head notify, dashboard, trust pre-clear,
`--permission-mode auto`, PLAN/capture/project-grouping.

**New (the gap):**
1. PM charter — evolve `buildHeadBriefing` (`roles.ts`).
2. Pure-PM enforcement hook — `PreToolUse` (new hook handling in `server.ts`).
3. Promotion — attach an existing session as project head + `hark` CLI env-fallback
   (resolve the active head orchestration for cwd's project when `HARK_ORCH_ID` unset).
4. Newsroom projection — `GET /api/projects/:key/newsroom?since=` over per-orch logs
   (`store.ts` + `statusView.ts` + `server.ts`).
5. Turn-boundary delta hook — `UserPromptSubmit` injecting the newsroom delta.
6. Blocker→human wiring — route worker `BLOCKED` into hark's attention/notification
   layer.
7. Idle loop driver + autonomy-dial setting (per-project; `controller.ts` + store).
8. Integration helpers — integrator-worker flow / integration worktree / `hark pr`.
9. Per-project "managed" mode + head/orchestration registry (`store.ts` + dashboard).

## 7. Phased build plan — START HERE

Each phase is an independently useful vertical slice; ship and dogfood before the next.

- **Phase A — "the PM you talk to"** *(start here)*
  - (3) Promotion: a `hark head init` / `/head` path that designates the current
    session as the project's PM-head — creates/attaches the orchestration record, sets
    up CLI targeting (project-local marker the CLI reads when env is unset), delivers
    the charter. No fresh worktree session; promote the session you're in.
  - (1) PM charter in `roles.ts`.
  - (2) Pure-PM `PreToolUse` enforcement hook.
  - *Outcome:* open a session, `/head`, get a pure-PM that owns `PLAN.md` and can
    dispatch workers (workers already work). You drive pulls manually for now.
- **Phase B — "the news flows"**
  - (4) Newsroom projection + endpoint.
  - (5) `UserPromptSubmit` delta hook + (charter) relevance triage.
  - *Outcome:* the head auto-sees triaged team news at every turn; no interruptions.
- **Phase C — "it advances itself"**
  - (7) Idle loop (mode-based push routing per §3.5) + autonomy dial (default L2).
  - (6) Blocker→human notification wiring.
  - *Outcome:* supervised-autonomous forward motion; blockers page you; nothing lands.
- **Phase D — "it ships"**
  - (8) Integration helpers (integrator worker / integration worktree / `hark pr`).
  - (9) Per-project managed mode + registry + dashboard surfacing.
  - *Outcome:* end-to-end idea→PR with the human owning the land.

## 8. Open decisions — RESOLVED (2026-05-29, with the user)
1. **Default autonomy level → L2 (supervised-auto).** Wired as
   `DEFAULT_AUTONOMY_LEVEL`. The dial is per-project and tunable; L2 is the
   default a freshly-promoted head gets.
2. **Newsroom/idle scope → span ALL the project's live orchestrations.** A true
   multi-thread PM: the projection merges head-relevant events across every
   active orchestration for the project, time-ordered. Shapes §3.4 + §3.5 + §3.6.

## 9. Invariants (must hold across all phases)
- The head never mutates or runs source; the human owns every landing.
- Nothing force-types into a live conversation; blockers escalate to the human, they
  do not interrupt the head.
- `PLAN.md` is edited via targeted edits (concurrent-session safe) and is the single
  source of durable PM state.
- Per-agent worktree isolation is the safety backstop; one branch is never checked
  out in two places.
- Active autonomy (keystroke delivery / idle push) stays gated behind
  `HARK_ORCH_AUTONOMY=1`.
