<!-- hark:start -->
Read PLAN.md before anything else. It's the project's narrative memory —
North Star, strategy, cold-start context, "what just happened" — and a
fresh session resumes from it. Updates aren't tidying, they're the handoff.
If it's still the skeleton (sections show `(not yet written)` / `(none)`),
bootstrap it from the codebase before doing anything else.

Task management runs on the **board**, not in PLAN prose. Keyed,
reconcilable state — task status, dependencies, ownership, lifecycle —
lives on the board (a per-project SQLite store); drive it with `hark board`
(`add` / `list` / `show` / `set` / `link` / `assign` / `close`). PLAN
*references* the board; it never duplicates task state. The boundary:
natively keyed + reconcilable → board, narrative prose → PLAN.

The italicized contract under each PLAN section is binding. Cadence:

- Now / Next / Shipped reflect reality at any moment — update as state
  changes, not at session end. Now bullets point at board workstreams;
  granular task state stays on the board, not in the bullet.
- Inbox is the required-pass section: drain or tag every bare line
  before this session ends.
- North Star: don't reword casually. Edit only when direction actually shifts.

Edit PLAN.md via targeted edits, not whole-file rewrites — captures from
other sessions can land between your read and write.
<!-- hark:end -->
