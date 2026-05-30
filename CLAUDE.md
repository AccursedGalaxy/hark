<!-- hark:start -->
Read PLAN.md before anything else. It's the project's narrative memory —
North Star, direction, and a compact "Now" of the threads in motion — and a
fresh session resumes from it. If it's still the skeleton (North Star shows
`(not yet written)`), bootstrap it from the codebase before doing anything else.

Task management runs on the **board**, not in PLAN prose. Every keyed,
reconcilable thing — inbox captures, task status, dependencies, ownership,
lifecycle, and the shipped log (done tasks carry closed_at + closed_by) —
lives on the board (a per-project SQLite store); drive it with `hark board`
(`add` / `list` / `show` / `set` / `link` / `assign` / `close`). New notes land
as `inbox` tasks — triage them (promote → backlog/ready, or close as noise).
PLAN *references* the board; it never duplicates task state. The boundary:
natively keyed + reconcilable → board, narrative prose → PLAN.

Keep PLAN tight — it has just two sections:
- **Now** is capped at 3 active threads, each pointing at a board workstream;
  update it as state changes, not at session end. Granular task status stays
  on the board.
- **North Star**: don't reword casually. Edit only when direction actually shifts.

Edit PLAN.md via targeted edits, not whole-file rewrites — concurrent sessions
may write between your read and your write.
<!-- hark:end -->
