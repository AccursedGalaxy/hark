You are a Researcher. Produce a FINDINGS BRIEF only — READ-ONLY, no code changes, no new files. Return the brief as your DONE-marker summary text.

GOAL: Map the current state of observability/tracking across the hark harness, and design how to COMBINE Claude Code's own session tracking with hark's orchestration tracking into a single central, QUERYABLE datastore rich enough to drive dogfooding decisions. We are about to dogfood the harness on hark's own backlog and the quality of that dogfood depends entirely on having rich, queryable data.

CONTEXT: hark is a notification + remote-control + multi-agent orchestration hub for Claude Code sessions on this host. It already reads `~/.claude/sessions/*.json` and per-session transcript JSONL, and drives sessions via tmux. The orchestration layer runs role-playing worker agents (coder/researcher/tester/etc.) in isolated git worktrees, each tracked as an OrchAgent record under a head-coordinated Orchestration. State persists under `~/.hark/`. Locate the code yourself.

DELIVERABLE — a structured findings brief answering these five sections:

1. INVENTORY — what hark tracks TODAY and where it lives.
   - Map every place orchestration/session state + metrics are persisted: the OrchAgent / OrchHead / Orchestration records and their fields (lifecycle, metrics, summary, killedAt, headWokeAt, costUsd, turns, diffstat, blocked-reason, dependsOn, etc.), the on-disk store format (store.ts; the `~/.hark/orchestrations/*` files), any event/audit trail (notes, notifications, newsroom/correlation), and the `.hark/` coordination files.
   - For each, list the concrete fields/events captured and their granularity: point-in-time snapshot vs time-series/append-only history. Call out where we OVERWRITE state and thus lose history.

2. CLAUDE CODE'S OWN TRACKING — what Claude already records that we can tap.
   - The session JSON (`~/.claude/sessions/*.json`) and transcript JSONL: enumerate what's actually in them — token usage (input/output/cache read+write), per-message/turn cost, tool calls + results, timestamps, model id, turn structure, stop reasons, etc.
   - How hark reads them today (the existing readers/parsers — cite files), and crucially what is AVAILABLE in those files but NOT currently ingested by hark.

3. GAP ANALYSIS for dogfooding — what rich data we'd need but don't capture.
   - Enumerate the metrics a dogfood would want to evaluate harness performance, e.g.: per-worker token + cost, wall-clock time-to-done, turn counts, tool-call distribution, circuit-breaker trips, retry/no-op spirals, idle-advance/wake-up events + misses, blocker reasons + frequency, PR outcomes (opened/merged/conflict/integrator-needed), first-try-green rate, base-drift incidents, dispatch→done latency.
   - For each, mark whether it's DERIVABLE from existing data (hark records or Claude transcripts) or needs NEW instrumentation.

4. STORAGE DESIGN — recommend a central queryable datastore.
   - What persistence does the repo already use? (JSON files? any existing DB/SQLite? check package.json deps + the store layer.)
   - Evaluate options (SQLite as the obvious single-host local fit vs alternatives) with concrete tradeoffs for THIS project: single-host, file-based, Node/TS, a long-running server with a 3s reconcile loop, strong preference for no extra daemon. Address: queryability, schema evolution, the write path from the live server, and whether to AUGMENT or REPLACE the existing JSON store.
   - Sketch a concrete schema: core tables/entities (orchestrations, agents, an append-only event/timeline, token-usage samples, tool-calls, PR outcomes) with key fields, and the JOIN KEY between Claude transcript-derived data and hark orch records (session id <-> agent id — verify how that mapping actually exists today).
   - Describe the ingestion path: how Claude transcript data + hark orch events flow into the store (batch poll vs event-driven, and where in the server lifecycle it hooks).

5. RECOMMENDATION — a concrete, phased proposal.
   - What to build FIRST to unblock dogfooding (the minimum rich dataset), vs nice-to-have later.
   - Flag the 2-3 highest-leverage data points for evaluating the harness.

CONSTRAINTS:
- READ-ONLY. Do not modify or create source files. Your output is the brief itself (your DONE summary).
- Cite specific files + line refs (store.ts, protocol.ts, the session/transcript readers, server.ts reconcile loop, package.json deps) so a follow-up build is well-grounded.
- Be concrete about fields and schema — not hand-wavy. The dogfood depends on this data being rich and useful.
- Structure the brief under the five headings above. Do NOT start implementing.
