# PLAN: The Board — the PM's operational substrate (and the keystone of any org evolution)

*Status: DRAFT design plan, 2026-05-29. Not started. Owner: PM-head + human.*
*This is a planning doc, not the live PLAN.md. When/if this gets committed work, the operational items move into PLAN.md (or, ironically, into the board itself).*

## Thesis (corrected)

**The board is the keystone. The Lead is an optional amplifier.**

The earlier org-design reasoning called the Lead the keystone and then immediately admitted a Lead is "worthless unless given the cross-task picture (the board + sibling diffs)" and "needs something to be senior about." That's a tell: the thing everything else depends on, and that delivers value standalone, is the board. The Lead is something you add *only if* board + full role-chains prove insufficient — and only with evidence.

Two pressures converge on the board, which is why it's load-bearing:
1. **The PM's hot path is fragile** (the NOTE). Reading/editing PLAN.md prose is the action the PM does most, and it's the most error-prone: long-bullet string-match edits, re-reads to get exact strings, churn that compounds the IO glitch. A markdown file is no longer enough to *orchestrate* a project — it's fine as narrative, wrong as an operational datastore.
2. **The multi-agent ceiling**: dispatch-by-workstream, `dependsOn` as real artifact flow, and queryable operational state all require structured, addressable tasks — not prose to re-derive state from.

Same solution. The board is ~60–70% of the value of the whole org vision, at ~10% of the token cost and roughly none of the new failure surface.

## Part 1 — The PM substrate problem (the NOTE)

PLAN.md does two jobs that should be split:
- **Strategic / narrative** (keep in markdown): North Star, prose context, the cold-start handoff, "what just happened." Slow-changing, human-readable, git-tracked.
- **Operational** (move to the board): tasks, status, assignment, dependencies, dispatch state. High-churn, id-addressed, queryable.

Today both live in PLAN.md prose, so every operational update is a brittle prose edit. Replacing the operational half with structured records makes the PM's most frequent action an **atomic, id-addressed op** (`board task set <id> status=review`) instead of a string-match against a 300-word bullet. That:
- removes the dominant source of edit failures + re-reads,
- shrinks PLAN.md to the stable narrative (fewer churny edits → fewer glitch-exposed edits),
- and helps the **solo flat-star PM today** — no new agents required to capture the win.

Failure modes observed THIS session that the board removes: `Edit string-not-found` on long bullets; reconstructing exact bullet text via Read before every edit; cascade-cancel wiping batched PLAN edits; stale/duplicated lines from interrupted edits.

## Part 2 — The board (what pays for itself)

A first-class task store. Reuse the **same `node:sqlite` layer just shipped for metrics (PR #24)** — proven in prod, no new dependency, no daemon, queryable.

Sketch (refine at build time):
```
tasks(id PK, title, body, status, assignee,        -- assignee = role | agentId | workstream
      workstream, priority, depends_on,            -- depends_on = task id(s)
      orch_id, agent_id,                            -- link to the dispatched worker, once spawned
      created_at, updated_at, closed_at)
task_events(id PK, task_id, ts, kind, message, data_json)  -- append-only history (no overwrite-loss)
```
Status flow mirrors the worker lifecycle but at the *task* grain: `backlog → ready → in-progress → review → done` (+ `blocked`). Source of truth = SQLite (offline, self-contained). PLAN.md references the board; it does not duplicate it.

What it unlocks even at flat-star L2:
- **Dispatch-by-workstream** without holding the decomposition in prose.
- **`dependsOn` as real artifact flow** — a board edge (task B depends on task A) is the natural place to resolve the lazy-branch-off-upstream that's currently half-built.
- **Queryable operational layer** — "what's in review", "what's blocked and why", "cost per task" (join to the metrics DB on `agent_id`) — instead of grepping PLAN.md.
- **GH Issues as a projection**, never the source of truth (see Part 5).

PM interaction model: a thin `hark board …` CLI (mirrors `hark agent …`) — `add / list / show / set / link / assign / close`. Fast structured ops replace prose surgery.

## Part 3 — Prove the bottleneck is structural BEFORE building tiers (top of the plan, not a footnote)

The buried-but-decisive point: the PM has been running **coder → PR → human and almost never chaining researcher → coder → tester → reviewer**. You cannot diagnose a structural limit from a system run at partial capacity. The tester and reviewer roles already exist and already gate integration quality — and were barely used until PR #24 (which we deliberately gated through a Reviewer — first real use of the chain, and it worked).

So, before any new tier:
1. **Saturate the existing palette.** Run full role-chains on the next several real tasks.
2. **Measure** (now possible — the metrics DB just shipped): cost-per-outcome, dispatch→done latency, first-try-green rate, rework rate, and how often *PM context* (not labor) is the binding constraint.
3. If full chains fix the integration pain → the Lead is unnecessary. If they don't → you have evidence for *exactly* what the Lead must solve, instead of a vibe.

## Part 4 — The Lead, priced honestly (optional amplifier, hard-gated)

If still needed after Part 3, the Lead is a **read-only sub-head**, and we price it without illusions:
- **It is not more capable — it has more room.** You're not relocating intelligence, you're *sharding context* (bounded per-node state, like map-reduce). Useful, but it buys PM-context headroom at a **3–5x absolute-token premium**. Worth it only if PM context is the proven binding constraint.
- **It recreates the failure mode recursively, less observably.** A Lead is a fresh session with the same window and fragility; 2–3 noisy workers + cross-branch diffs can drown it. A Lead that spirals, or hallucinates an integration "OK," is invisible to the PM behind the rollup until landing. "Distributed supervision" only catches spirals the Lead *notices*, and the watching is itself a token sink.
- **One-shot integration judgment is a thin reed.** Per the no-accrued-memory point: a fresh session reviewing diffs it didn't write is a weak place to hang integration correctness. Treat its verdict as advisory, not authoritative.
- **It must inherit the read-only guard.** Worktree-isolation + read-only-PM is the whole safety story. A Lead that "runs the integration gate" is either read-only (so, like the PM, it can only dispatch an *integrator worker*, not merge) or it punches a hole in the core invariant. Keep it read-only → the Lead is a **context-sharding router with a review opinion**, not a new power. Fine — but priced as that, it reinforces that the board does the real work.

## Part 5 — The "open" questions, resolved

- **Native SQLite vs GitHub Issues as source of truth → Native, decisively.** SQLite is offline, self-contained, reuses the metrics layer, no per-query network round-trip. Making GH the SoT couples the orchestrator's hot path to a rate-limited external API — a reliability regression for a system we just called fragile under load. GH Issues = a reconciled *projection* for human ergonomics, never authoritative.
- **Fresh Lead role vs reuse "head" machinery → Reuse.** A Lead is a read-only sub-head; smaller than it sounds. The read-only constraint (Part 4) is the only real design decision in it.
- **Keep the depth-dial idea** (L2 = flat star, L3 = spawn Leads). Good — but don't *build* the L3 machinery until L2-at-capacity proves the need.

## Part 6 — Sequencing, with hard gates

The earlier doc said the expansion should "ride on top of reliability work already in flight." Too loose. The Lead multiplies every failure mode already listed (spirals, missed breaker, IO glitch, wake-up gaps) and hides them behind a rollup. So:

- **Lead (Phase C) is HARD-BLOCKED** on breaker + wake-up + stop being *demonstrably solid in production* — landed and observed, not "queued." Don't ride on top of in-flight work; wait for it to land.

## Part 7 — What I'd actually do, in order

1. **Saturate the existing role chains now** + measure whether integration pain survives (uses the metrics DB just shipped). *Cheap, immediate, evidence-generating.*
2. **Build the board regardless** — it pays for itself even at flat-star L2 (Parts 1–2). Order: schema + `hark board` CLI → migrate PLAN.md's operational half → wire `dependsOn` edges to the lazy-branch-off-upstream work → optional GH-Issues projection.
3. **Only then**, if board + full chains *still* leave the PM context-bound on multi-task epics, build the **Lead as a read-only sub-head** behind the autonomy depth-axis (L3), hard-gated on reliability (Part 6).

## Still genuinely open
- Does PLAN.md's operational half move *entirely* into the board, or does a thin "Now (3 threads)" pointer stay in markdown for cold-start readability? (Lean: keep a tiny narrative pointer; board holds the detail.)
- Board granularity: one board per project, or per-orchestration? (Lean: per-project, orchestrations reference it.)
- Migration: do we backfill existing PLAN.md threads into the board, or start the board fresh and let PLAN.md drain naturally?
- What's the minimum measurement from step 1 that would *settle* the structural-bottleneck question? Define the kill/build criterion for the Lead up front.
