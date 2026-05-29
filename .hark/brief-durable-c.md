Fix `hark agent diff <agentId>` to measure a worker's branch against its merge-base with the base ref, NOT against the stale `orch.baseRef`. Locate the code yourself (the `hark agent diff` path in bin/hark + its backing endpoint, the diff logic in src/lib/orch/* / worktree).

PROBLEM:
`hark agent diff` currently diffs the worker branch vs `orch.baseRef`. When the base advanced or the worker was rebased, that inflates the worker's diffstat with main's OWN commits (commits the worker never made), giving the PM a misleading picture of what the worker actually changed.

FIX:
- Compute the diff against the merge-base of the worker branch and the base ref — i.e. `git merge-base <base> <branch>` then diff `<merge-base>..<branch>` — exactly like `hark pr` ALREADY does when it builds its diffstat. REUSE that existing merge-base logic/helper rather than duplicating it; if it's not already a shared helper, extract one and use it in both places.
- Apply to BOTH `--stat` (default) and `--full`.

CONSTRAINTS:
- Keep changes minimal and idiomatic; prefer reusing the `hark pr` path's logic.
- Unit test: a worker branch whose base has commits AHEAD of the fork point shows ONLY the worker's own changes (not the base's commits) in the diff.
- Do NOT touch PLAN.md (PM-owned).
- `npm test` green + tsc clean before you finish. Small commits.
- Emit the DONE marker with a concise summary (files + behavior).
