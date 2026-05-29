You are a REVIEWER. Adversarially review a finished branch BEFORE it merges. READ-ONLY — do not modify code; your deliverable is a verdict.

TARGET: branch `hark/pm-hark/coder-d800f8` vs `main`. Inspect with `git diff main...hark/pm-hark/coder-d800f8` and `git log main..hark/pm-hark/coder-d800f8` from your worktree (the branch is in the shared object store — READ it, do not check it out over your own tree).

WHAT IT CLAIMS (Phase 0 central metrics datastore): a shared pricing module, `src/lib/orch/metricsDb.ts` (node:sqlite, idempotent schema + typed helpers), ingestion hooked into the reconcile loop reusing the existing transcript read, `costUsd` computed everywhere, and ALL PR outcomes persisted. Reports 715 tests green, root + web tsc clean, 4 commits.

REVIEW AGAINST THESE SPECIFIC RISKS (assume a bug until convinced otherwise):
1. **Reconcile-loop safety** — ingestion runs in the 3s `reconcileOrchestrations` loop on the LIVE server. Can the new ingest step throw and break/stall the loop? Is it wrapped so a DB error can't abort reconciliation? Does it add real latency or re-read transcripts already read (brief required REUSING the existing read, not double-reading)?
2. **Augment-not-replace** — JSON store must stay source of truth; the DB a derived, rebuildable read-model. Did it change or risk the existing JSON write path? Are existing store tests still valid?
3. **node:sqlite correctness** — DB opened ONCE and reused (not per-tick)? Schema idempotent (CREATE IF NOT EXISTS + schema_version)? Writes PARAMETERIZED (no injection from task text / branch names)? Is `token_samples` truly APPEND (time-series), not overwrite?
4. **Cost computation** — uses the SHARED price table (not a forked second copy)? All token classes priced (input/output/cache-read/cache-creation)? Unknown model ids handled (no NaN/crash)?
5. **PR outcomes** — ALL statuses recorded (created/no_remote/no_base/no_gh/error), not just created?
6. **General** — tests actually exercise the new behavior (not just smoke); no dead code/scaffolding; matches surrounding style; join key (agent.sessionId ↔ token_samples.session_id) tolerates null session_id.

DELIVERABLE (your DONE marker text): a clear verdict — **APPROVED** or **CHANGES-REQUESTED** — with a prioritized list (blocking / should-fix / nit), each with a `file:line`. Verify claims by READING the code; you may cheaply run the test suite if useful, but do not rewrite anything.

TOOLING NOTE: IO can be flaky in this environment — run tool calls SEQUENTIALLY and retry a single failed call rather than re-batching.
