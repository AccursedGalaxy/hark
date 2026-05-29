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

## RESOLVED — grilling session 2026-05-29 (binding; supersedes the leans below where they conflict)

**Meta-discipline (the move that generated everything here):** at each layer, *refuse the clean-but-false artifact for the messier honest shape.* Every resolution below is that move applied once more — if a specific conclusion is lost, regenerate it by finding where a clean bundle is laundering a speculative half under a proven half's warrant.

### The gate — exactly one member
The only thing gated on evidence is **adding a second supervisory locus** (supervision beyond the solo PM). The cell decides not just *whether* but *which form*:
- cheap mechanical form = an **admission controller** (bounds in-flight worker count `k`; decidable predicate "≥k in-flight", pure-PM-guard shape; no second context to drown);
- expensive judgment form = a **Lead session** (recursive-failure-prone — a fresh window with the same fragility; one-shot integration judgment is a thin reed).
Adjudication: if bounding admission alone resolves the exhaustion, the controller was the cheaper intervention and no Lead is built. A Lead is built only if supervision needs judgment the controller can't encode.

### The cell — what the gate reads
Build signal = **context-forced PM exhaustion that survives at the joint floor**: `k` at the smallest value still yielding ≥2 concurrent workstreams, AND discipline tight (minimal slurp), under **demand-derived** concurrency (the real work's DAG, never injected).
- Two covariates but **coupled, not orthogonal**: admission is slurp's *partial parent* (`k → check-pressure → verify-pulls → slurp`). A small DAG (slurp also has a k-independent discipline parent), not a 2D conjunction of free axes → read it as a single joint floor.
- **Procedure (binding for saturation):** vary/cap `k` FIRST, let it screen off the slurp it was causing, THEN attribute the residual to discipline. Reading the two covariates as free re-inflates the cell.
- The coupling **thins** the cell (the two minima are co-achieved by capping `k`) → **kill-with-tripwire is the near-certain terminus**, and the rare build signal is correspondingly clean.

### Termination — three branches, no fourth
1. exhaustion vanishes at low slurp / bounded `k` → **kill** (hygiene/dispatch-discipline; fix the cheaper thing — discipline tooling or the admission cap).
2. exhaustion survives the joint floor under demand-derived concurrency → **build** the locus (controller first; Lead only if judgment is required).
3. cell never fills (demand-derived concurrency stays < 2, or {≥2, bounded-k, low-slurp} stays empty) → **kill (unearned)**. Burden-of-proof is on *build*; absence of evidence routes to don't-build because the cost asymmetry is lopsided (a wrongly-built locus drowns invisibly — the recursive-failure through-line; a wrongly-killed one is revisitable).
- The kill is **terminal-with-tripwire**, never terminal-full-stop: arm a standing *passive* query on instrumentation already running — count {≥2, bounded-k, low-slurp} epics, fire once at M. A terminated decision with a reopen condition is NOT the indefinite-deferral failure mode ("keep adjudicating"); a passive tripwire adjudicates nothing. The tripwire is what makes "revisitable" true — and revisitability is the *entire* justification for kill-on-starvation being cheap. You cannot spend the asymmetry and also remove revisitability.
- **N (build threshold) is fenced, not pre-committed blind:** no base rate exists today (~0 concurrent). Commit the *shape* now (single observable, ≥2 as definitional, explicit kill branch, no-injection, the freeze procedure); freeze N from the first M (≈10) demand-derived multi-task epics run at full role-chains, by a named person, before the call.

### The ungated set — five layers, each with its WARRANT named
("Build the board regardless" is true for all five; the warrant is what stops the next person re-bundling a speculative half under a proven half's warrant. The only thing the cell ever gated was the second supervisory locus.)
1. **Core** (task store, status, keyed upsert) — warrant: **proven need this session** (string-match edit failures; channel-independent). Removes failure classes #1/#2 (string-match) and #4 (duplication, via keyed upsert); makes #3 (cascade-cancel) *survivable* (idempotent retry + cheap structured verification). Does NOT remove silent drops — that residue is the IO track's, not the board's.
2. **`depends_on` + lazy-branch-off-upstream** — warrant: **measurement-validity prerequisite.** Withholding it taxes coder+tester fan-out → suppresses the very concurrency the cell measures (suppression-injection, Q3 inverted).
3. **Dispatch schema** (`workstream`, `assignee`-as-workstream, queryable cross-agent layer) — warrant: **measurement apparatus.** Workstream attribution is how you tell genuine multi-workstream load from two workers on one stream. Schema is cheap AND load-bearing for measurement — both true, of the thing each is true of. The *behavior* the schema licenses is separate (layer 4 + the gate).
4. **Dispatch behavior** (PM *permitted* to run demand-derived fan-out) — warrant: **measurement-validity prerequisite.** The cell is a measurement *of this behavior's effect*; gating it withholds the instrument. CRITICAL: *permitted to run* ≠ *runs unbounded*. The admission cap `k` over the permitted set is the gated mechanical-locus question (the controller above), NOT part of this ungated permission. Unbounded fan-out is the dispatch-axis slurp.
5. **Per-project board granularity** (NOT per-orchestration) — warrant: **measurement-validity prerequisite (fifth).** The cell is cross-workstream concurrency under ONE PM context. A per-orchestration board scopes "≥2 concurrent" inside one orchestration and structurally hides the cross-orchestration load that fills the cell. Per-project counts at the level the PM actually holds context across — the level the cell is defined at. Near-forced by the measurement, not an ergonomic dial.

### Separately ungated (Q4 lineage — discipline infra, not board, not a locus)
**PM-side context tooling** — auto-rollup of worker notifications *into the PM's own single context* (no second session). The genuine cheaper-than-Lead middle rung. NOT the dispatch shell, NOT a second locus.

### Invariants (violating any silently corrupts a measurement or the channel story)
- **Intent-from-transcript, never self-report.** The reconciliation detector's "intent" record comes from the harness's transcript tool_use blocks (persisted on the assistant-turn side; survive a *result*-drop), never from a board/log write. The glitch is on the result transport; issuance survives. An intent log on the dropping channel is blind exactly when it fires.
- **No-injection, both signs.** Don't inflate concurrency above the DAG (fabricates the bottleneck) AND don't suppress it below the DAG (withholding concurrency-enabling tooling taxes the signal). Demand-derived only.
- **Keyed/reconcilable is the migration boundary** (not "operational vs strategic" — too vague, invites creep). Natively keyed + reconcilable state → board substrate (task status, dependency edges, lifecycle, workstream attribution). Everything else → stays PLAN.md prose, edited as today. This keeps **PLAN-onto-Bash dead**: prose stays on whatever channel it's on; only keyed state lives on the board. The board's value (keyed state) and routing PLAN's prose through Bash ops are *separate decisions* — the second is gated on channel telemetry and is NOT queued.
- **IO track is parallel, never zeroed.** The board neutralizes the glitch's *consequences* (no duplication, safe idempotent retry, cheap structured verification) but cannot touch *silent drops* (drop → false belief → desync). Silent-drop detection rides reconciliation, which rides the board's keyed state — so the board is the *instrument* that makes the residue observable, but the residue is the IO track's to own. First IO-track task = instrument tool-call transport (the deferred `turns`/`tool_calls` tables; per-call channel/ts/call-id/batch-membership/issuing-turn; outcome via reconciliation, not self-report). You can't root-cause what you can't see; the metricsDb comment ("Phase 1 tables intentionally absent") confirms the blindness is a deferral, not an oversight.

### Still genuinely open (only one survives)
- **Backfill vs drain:** backfill existing PLAN.md threads into the board, or start fresh and let PLAN.md drain naturally? (Genuinely independent of the above; banked.)
