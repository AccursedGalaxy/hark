Add a runaway circuit-breaker to the hark orchestration worker loop. A worker that lost confidence its tools ran has been observed spiraling into repeated identical no-op probe commands (recover-check-N / retry-burst-N), never reaching a terminal state, burning ~1M+ tokens until a human kills it. Make the harness self-defend. Locate the worker exec / reconcile loop yourself (src/lib/orch/*, the reconcile path in the server).

ACCEPTANCE CRITERIA:
- Detect when a worker issues N consecutive identical / near-identical no-op commands that make no progress. When tripped, flip that worker's lifecycle to `blocked` with a clear reason string (e.g. "circuit-breaker: N identical no-op commands"). Once `blocked`, the existing reconcile loop ALREADY SIGTERMs the worker — so you do NOT need to re-implement termination; just trip the lifecycle + reason.
- N is a named constant with a sensible default (suggest 4-5); pick one and document it.
- "No progress" heuristic: keep it simple and low-false-positive — e.g. the same command string repeated with no new commits / no diff change between attempts. A worker that IS making progress (new commits or diff advancing) must NOT trip, even if it repeats a command.
- The blocked reason must be retrievable by the PM — surfaced on the worker record (and thus in orch status / the head notification) so I can see WHY it stopped.

OUT OF SCOPE (note only, do NOT implement): the suspected trigger is a worker spawning its own Explore sub-agent. Do not forbid sub-agents in this task. If you spot a clean, low-risk seam to limit it, mention it in your DONE summary as a follow-up — but the circuit-breaker is the deliverable.

CONSTRAINTS:
- Keep changes minimal and idiomatic to the surrounding code.
- Unit-test the breaker: trips after N identical no-ops; does NOT trip when commits/diff advance.
- `npm test` green + tsc clean before you finish. Small commits.
- Emit the DONE marker with a concise summary (files + behavior) when finished.
