// Load-bearing text artifacts for the project-state feature. The PLAN.md
// skeleton and the CLAUDE.md managed block were specified word-for-word
// during design — every section's italic contract is part of the binding
// spec the agent re-reads each session. Don't paraphrase these.
//
// Why these aren't markdown files on disk: bootstrapping a project's
// PLAN.md is a write performed by the server, and shipping the skeleton
// as a versioned literal here makes the contract reviewable in code
// review rather than buried in a template the agent might silently
// edit.

// Markers for the idempotent managed-block injection into CLAUDE.md.
// Hark only ever touches text between these — user edits outside the
// markers survive any number of re-installs.
export const HARK_BLOCK_START = "<!-- hark:start -->";
export const HARK_BLOCK_END = "<!-- hark:end -->";

// The block the agent reads every session start. The first line is the
// handoff motivation — agents follow reasons more reliably than rules, so
// the "why" sits above the "what". Two memories, not one: PLAN.md is the
// NARRATIVE store (vision / strategy / "what just happened"); the board
// (per-project SQLite, driven via `hark board`) is the TASK store (keyed,
// reconcilable status). The block names that split so a cold-start agent
// tracks tasks on the board instead of dual-tracking them in PLAN prose.
// Cadence rules cover the gap left by PLAN.md's section contracts: those
// define WHAT each section contains, this defines WHEN to update them.
export const CLAUDE_MD_BLOCK = [
  HARK_BLOCK_START,
  "Read PLAN.md before anything else. It's the project's narrative memory —",
  "North Star, strategy, cold-start context, \"what just happened\" — and a",
  "fresh session resumes from it. Updates aren't tidying, they're the handoff.",
  "If it's still the skeleton (sections show `(not yet written)` / `(none)`),",
  "bootstrap it from the codebase before doing anything else.",
  "",
  "Task management runs on the **board**, not in PLAN prose. Keyed,",
  "reconcilable state — task status, dependencies, ownership, lifecycle —",
  "lives on the board (a per-project SQLite store); drive it with `hark board`",
  "(`add` / `list` / `show` / `set` / `link` / `assign` / `close`). PLAN",
  "*references* the board; it never duplicates task state. The boundary:",
  "natively keyed + reconcilable → board, narrative prose → PLAN.",
  "",
  "The italicized contract under each PLAN section is binding. Cadence:",
  "",
  "- Now / Next / Shipped reflect reality at any moment — update as state",
  "  changes, not at session end. Now bullets point at board workstreams;",
  "  granular task state stays on the board, not in the bullet.",
  "- Inbox is the required-pass section: drain or tag every bare line",
  "  before this session ends.",
  "- North Star: don't reword casually. Edit only when direction actually shifts.",
  "",
  "Edit PLAN.md via targeted edits, not whole-file rewrites — captures from",
  "other sessions can land between your read and write.",
  HARK_BLOCK_END,
].join("\n");

// PLAN.md skeleton, parameterized by project display name. Each section's
// italicized intro is the section's contract and stays in the doc forever
// — agents read it at session start to understand what each section is
// for. `(not yet written)` and `(none)` are deliberate placeholders, not
// blank space; they signal "needs filling" and give the capture flow
// known anchors if it ever needs them.
export function buildPlanSkeleton(projectName: string): string {
  return `# ${projectName} — PLAN

*Living state of this project. Hark reads it at every session start;
sessions keep it accurate as they work. Each section opens with its
contract in italics — those lines are binding.*

## North Star

*What this project is for. 2–4 sentences. Slow-changing — only edit when
the vision actually shifts.*

(not yet written)

## Now

*Active threads being shipped right now. Hard cap: 3 items. One bullet
per thread; one line of context allowed beneath it.*

- (none)

## Next

*Committed, not started. No hard cap, but if this list exceeds ~7 items
it has become a dumping ground — flag it and force triage back into Now
or out of the doc.*

- (none)

## Shipped

*Newest first. Keep the last 10 lines here; move older entries to
\`.hark/shipped-archive.md\`. Git history is the real archive — this
section exists to answer "what just happened" for a cold start, not
to be complete.*

- (none)

## Inbox

*Raw captures, timestamped as \`- [YYYY-MM-DD HH:MM] text\`. The required-pass
section: every line must be gone or tagged before this session ends.*

- *Relevant to current work → incorporate, then remove the line.*
- *Otherwise → promote (to Now / Next), delete (noise), or keep with a
  one-word reason in brackets: \`[blocked]\`, \`[maybe]\`, \`[waiting-on-X]\`.*
- *A bare untagged line surviving past session end is the signal that
  the previous session failed its pass — triage it first.*

- (none)
`;
}

// File names hark reads/writes inside a project. Kept in one place so
// the rail, the bootstrapper, and any future archive logic agree.
export const PLAN_FILENAME = "PLAN.md";
export const CLAUDE_MD_FILENAME = "CLAUDE.md";
