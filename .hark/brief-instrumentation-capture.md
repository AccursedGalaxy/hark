# Brief: Transport instrumentation — CAPTURE half only (board-independent)

## Resilience header (read first)
Tool IO here is intermittently flaky: blank / dropped / duplicated results, occasional write errors, parallel-batch cascade-cancellation. Run tool calls SEQUENTIALLY; commit each logical piece immediately; retry a SINGLE failed call rather than re-batching; use `/usr/bin/git`.

## What this is — and the hard seam it stops at
This is the measurement apparatus that later makes the orchestration's IO behavior observable. It splits along a seam: the part that reads streams which ALREADY EXIST (the session transcript + tool-call stream) is board-independent — that is THIS brief. The reconciliation detector (diffing intent against KEYED BOARD STATE to catch silent drops) is **NOT in scope** — it reconciles against the board's keyed store, which is still in review; building it now means building against a moving schema. **Do NOT build the detector. Stop at capture.**

## Scope (capture only)
Extend the existing metrics datastore (`src/lib/orch/metricsDb.ts` — its comments explicitly note the `turns`/`tool_calls` tables are deferred/absent; this adds them), ingested off the SAME reconcile/ingest loop that already tails transcripts for token samples:

1. **Per-call tool-call metadata.** For each tool call: channel (`Bash` / `Edit` / `Write` / other tool name), timestamp, a stable call-id, batch membership + batch size (which calls were issued together in one assistant turn), and the issuing-turn index. Raw material for later correlating IO-glitch incidence against channel and batch size. Channel-independent, recordable, no judgment.
2. **Intent record from the transcript.** Log each tool call's INTENT ("this call was issued") sourced from the harness transcript's tool_use blocks — NOT from any self-reported success. **INVARIANT (load-bearing — do not violate):** intent comes from the transcript tool_use stream (persisted on the assistant-turn side; survives a dropped *result*). It must NEVER be a self-report write — a `log "I did X"` call rides the same channel that drops, so it would be blind exactly when it matters. This intent record is what a future detector will reconcile against keyed board state.

## Explicitly OUT of scope (these gate on the MERGED board core — do not build)
- The reconciliation detector (intent-vs-actual diff → suspected silent drop / duplicate).
- The discipline covariate, the three-state pull classification (act / declared-no-op / nothing), and the `--for` annotation.
Both reconcile against the keyed board store and must wait until board core clears review and its schema is stable. Building them now = building against a moving target.

## Acceptance criteria
- `turns`/`tool_calls` tables added to metricsDb; populated from the transcript tool-call stream off the existing ingest loop — mirror the existing `token_samples`/`events` ingest pattern (append-style, offset-cursored, rebuildable; do not break the existing ingest).
- Per-call channel + ts + call-id + batch-membership + issuing-turn captured.
- A test proving intent is captured even when a result would be absent/dropped — i.e. intent does NOT depend on result transport (this guards the invariant).
- tsc clean; full suite green; small, frequent commits.

## Notes
- Forks from current base (`main`); the board core branch is unrelated — no contention.
- A Reviewer chain may follow. Drive to an open PR (`hark pr`); the human lands.
- Intent-level brief: locate the metricsDb ingest pattern + how hark reads session transcripts yourself. Don't wait on the PM for line numbers.
