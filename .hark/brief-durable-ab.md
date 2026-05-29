Two related fixes to make worker->PM communication DURABLE and the PM's wake-up RELIABLE. Both live in the orchestration notification/lifecycle path — locate the code yourself (src/lib/orch/*, the reconcile + head-notification logic in the server, the OrchAgent record in protocol/store, the CLI in bin/hark + its backing endpoints).

PART 1 (gap a) — persist the worker's terminal marker + expose it
Today when a worker emits its terminal marker (DONE deliverable / blocked reason / handoff), that text is delivered as an EPHEMERAL head notification and is NOT persisted on the OrchAgent record — so it dies when the worker is reaped and the PM can never retrieve it later. Live pain: a worker's notification truncated to only part of its summary and the full "what changed" was lost forever.
- Add a `summary` field (name it sensibly) to the OrchAgent record.
- When a worker reaches a terminal lifecycle via its marker (done/blocked/handoff/failed), persist the FULL marker text on the record. The circuit-breaker's blocked-reason must land here too (it already produces a reason — make sure it persists).
- Expose `hark agent summary <agentId>` that prints the persisted marker text. Safe/clear message if none exists yet.
- The summary MUST survive worker reaping — it lives on the record, not the live session.

PART 2 (gap b) — reliable worker-done wake-up
The PM (head) must be reliably idle-advanced whenever ANY worker reaches a terminal lifecycle (done/blocked/failed/stopped), not just sometimes. Observed bug (reproduced twice): idle-advance fired for some workers but not others — e.g. an integrator hit DONE but the head was never woken, so the PM looked asleep until a human pinged.
- Always trigger the head idle-advance / wake signal on a worker's transition to a terminal lifecycle — exactly ONCE per worker (do not re-fire every reconcile tick; mirror the existing fire-once pattern, e.g. the `killedAt`-style guard already used for terminal-kill).
- Robust to the marker-vs-reconcile race: whether the terminal transition is detected via the worker's marker OR via the reconcile loop, the wake-up fires exactly once.

CONSTRAINTS:
- Keep changes minimal and idiomatic to the surrounding code.
- Unit tests: summary persists + is retrievable after a simulated reap; wake-up fires exactly once per terminal worker, for EVERY worker including one that transitions via the reconcile loop (not just via its marker).
- Do NOT touch PLAN.md (PM-owned).
- `npm test` green + tsc clean before you finish. Small commits.
- Emit the DONE marker with a concise summary (files + behavior).
