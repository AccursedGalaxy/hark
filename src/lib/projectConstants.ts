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
// NARRATIVE store (vision / direction / a compact "Now"); the board
// (per-project SQLite, driven via `hark board`) is the TASK store — and it now
// owns EVERYTHING keyed: inbox captures, task status, dependencies, ownership,
// and the shipped log (closed tasks carry closed_at + closed_by). The block
// names that split so a cold-start agent tracks tasks on the board instead of
// dual-tracking them in PLAN prose.
export const CLAUDE_MD_BLOCK = [
  HARK_BLOCK_START,
  "Read PLAN.md before anything else. It's the project's narrative memory —",
  "North Star, direction, and a compact \"Now\" of the threads in motion — and a",
  "fresh session resumes from it. If it's still the skeleton (North Star shows",
  "`(not yet written)`), bootstrap it from the codebase before doing anything else.",
  "",
  "Task management runs on the **board**, not in PLAN prose. Every keyed,",
  "reconcilable thing — inbox captures, task status, dependencies, ownership,",
  "lifecycle, and the shipped log (done tasks carry closed_at + closed_by) —",
  "lives on the board (a per-project SQLite store); drive it with `hark board`",
  "(`add` / `list` / `show` / `set` / `link` / `assign` / `close`). New notes land",
  "as `inbox` tasks — triage them (promote → backlog/ready, or close as noise).",
  "PLAN *references* the board; it never duplicates task state. The boundary:",
  "natively keyed + reconcilable → board, narrative prose → PLAN.",
  "",
  "Keep PLAN tight — it has just two sections:",
  "- **Now** is capped at 3 active threads, each pointing at a board workstream;",
  "  update it as state changes, not at session end. Granular task status stays",
  "  on the board.",
  "- **North Star**: don't reword casually. Edit only when direction actually shifts.",
  "",
  "Edit PLAN.md via targeted edits, not whole-file rewrites — concurrent sessions",
  "may write between your read and your write.",
  HARK_BLOCK_END,
].join("\n");

// PLAN.md skeleton, parameterized by project display name. PLAN is NARRATIVE
// only now — North Star + a compact Now. Everything keyed (inbox captures, task
// status, dependencies, the shipped log) lives on the board (`hark board`), so
// the old Next / Shipped / Inbox sections are gone from the doc. Each section's
// italicized intro is its contract and stays in the doc forever — agents read it
// at session start. `(not yet written)` and `(none)` are deliberate placeholders
// signalling "needs filling".
export function buildPlanSkeleton(projectName: string): string {
  return `# ${projectName} — PLAN

*Living narrative of this project — vision, direction, and what's moving right
now. Hark reads it at every session start. Task state — inbox captures, backlog,
in-flight work, and the shipped log — lives on the **board** (\`hark board\`), NOT
here; this file carries only the North Star and a compact Now. Each section opens
with its contract in italics — those lines are binding.*

## North Star

*What this project is for. 2–4 sentences. Slow-changing — only edit when
the vision actually shifts.*

(not yet written)

## Now

*The few threads actively moving right now. Hard cap: 3 bullets, one line of
context each. Each points at a board workstream — granular task status,
dependencies, and ownership stay on the board (\`hark board list\`), not in the
bullet. Everything else — backlog, captures, shipped work — is on the board.*

- (none)
`;
}

// File names hark reads/writes inside a project. Kept in one place so
// the rail, the bootstrapper, and any future archive logic agree.
export const PLAN_FILENAME = "PLAN.md";
export const CLAUDE_MD_FILENAME = "CLAUDE.md";
