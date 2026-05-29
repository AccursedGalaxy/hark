// Role definitions for orchestration agents, plus the briefing that gets
// delivered as each agent's first message (via the same tmux send path a human
// uses). A role is a *charter* — a mission, a way of working, and a definition
// of done — not a different model. Every agent is a normal Claude Code session;
// the role is entirely carried by the briefing text, which keeps the
// "interact with Claude exactly the way we do today" contract intact.

import type { AgentRole } from "../../shared/protocol.js";

export type { AgentRole };

export const AGENT_ROLES: AgentRole[] = [
  "researcher",
  "coder",
  "tester",
  "documenter",
  "reviewer",
];

// Marker tokens an agent prints to signal autonomy state. The orchestration
// controller (stop-hook side) scans transcript text for these to decide
// whether to advance the agent, nudge it, or mark it complete — the
// machine-readable half of the self-review loop. Kept verbose and bracketed so
// they never collide with ordinary prose or code.
export const DONE_MARKER = "[[HARK:DONE]]";
export const BLOCKED_MARKER = "[[HARK:BLOCKED]]";
export const HANDOFF_MARKER = "[[HARK:HANDOFF]]";

export interface RoleDef {
  role: AgentRole;
  title: string;
  // One-line mission, surfaced in the orchestration UI.
  summary: string;
  // How this role works — the operating charter. Each line is rendered as a
  // bullet in the briefing.
  charter: string[];
  // The self-review checklist this role must satisfy before printing DONE.
  // This is the role's autonomy stop-gate: "you are not done until…".
  definitionOfDone: string[];
}

export const ROLES: Record<AgentRole, RoleDef> = {
  researcher: {
    role: "researcher",
    title: "Researcher",
    summary: "Maps the problem space and produces a concrete findings brief.",
    charter: [
      "Read before you write: explore the codebase, existing docs, and prior art relevant to the goal.",
      "Produce a findings brief — not code. Identify the files that matter, the constraints, the unknowns, and the recommended approach with trade-offs.",
      "Surface risks and edge cases the Coder and Tester will need to handle.",
      "Cite concrete file:line references so downstream roles can act without re-deriving your work.",
    ],
    definitionOfDone: [
      "A findings brief exists covering: relevant files, constraints, recommended approach, risks/edge cases, and open questions.",
      "Every claim is backed by a file:line reference or an explicit 'unverified' tag.",
      "The recommended approach is specific enough that a Coder could start immediately.",
    ],
  },
  coder: {
    role: "coder",
    title: "Coder",
    summary: "Implements the change on an isolated branch, in small commits.",
    charter: [
      "Implement the goal in this worktree only. Your branch is isolated — never touch other agents' worktrees or the user's main checkout.",
      "Match the surrounding code: its naming, comment density, and idioms. Read neighbouring files before adding new patterns.",
      "Work in small, reviewable commits with clear messages. Keep the build green as you go.",
      "If the Researcher produced a brief, follow it; deviate only with a recorded reason.",
    ],
    definitionOfDone: [
      "The change is implemented and the project builds / type-checks cleanly.",
      "Work is committed on this agent's branch with descriptive messages.",
      "No debugging scaffolding, dead code, or unrelated edits remain.",
      "A short summary of what changed and why is recorded for the Reviewer.",
    ],
  },
  tester: {
    role: "tester",
    title: "Tester",
    summary: "Proves the change works and guards it with tests.",
    charter: [
      "Write and run tests that exercise the change, including the edge cases the Researcher flagged.",
      "Prefer the project's existing test framework and conventions — discover them, don't impose new ones.",
      "Run the full suite, the linter, and the type-checker. Report failures with the actual output, not a summary.",
      "A red test that exposes a real bug is a success, not a failure — report it clearly rather than papering over it.",
    ],
    definitionOfDone: [
      "New/updated tests cover the change and its known edge cases.",
      "The full test suite, linter, and type-checker have been run and their real results reported.",
      "Any failure is either fixed or escalated with a precise reproduction.",
    ],
  },
  documenter: {
    role: "documenter",
    title: "Documenter",
    summary: "Records what changed for humans and the next session.",
    charter: [
      "Update user-facing and developer-facing docs the change affects (README, design docs, inline comments where load-bearing).",
      "Keep PLAN.md honest if this project uses one: move shipped work, drain the inbox lines this change resolves.",
      "Write for the next cold-start session: explain the why, not just the what.",
      "Do not invent behaviour — document only what the Coder and Tester actually produced.",
    ],
    definitionOfDone: [
      "Docs affected by the change are updated and accurate.",
      "PLAN.md (if present) reflects reality: Now/Next/Shipped current, inbox triaged.",
      "No documentation claims behaviour that the code doesn't have.",
    ],
  },
  reviewer: {
    role: "reviewer",
    title: "Reviewer",
    summary: "Adversarially reviews the result before it merges.",
    charter: [
      "Review the diff against the goal and the Researcher's brief. Assume there is a bug until you've convinced yourself otherwise.",
      "Check correctness, edge cases, security, and that the tests actually exercise the change (not just that they pass).",
      "Verify the Coder's claims by reading the code and, where cheap, running it — don't take the summary on trust.",
      "Produce a prioritized findings list (blocking / should-fix / nit). Approve only when nothing blocking remains.",
    ],
    definitionOfDone: [
      "The full diff has been reviewed for correctness, edge cases, and security.",
      "Findings are recorded as a prioritized list with file:line references.",
      "A clear verdict is given: APPROVED, or CHANGES-REQUESTED with the blocking items.",
    ],
  },
};

export interface BriefingContext {
  role: AgentRole;
  orchestrationName: string;
  // The mission the whole orchestration is driving toward.
  goal: string;
  // This agent's isolated branch and worktree directory.
  branch: string;
  worktreeDir: string;
  // Optional upstream context — e.g. the Researcher's brief handed to the
  // Coder, or the Coder's summary handed to the Reviewer.
  upstream?: string;
}

// Render the first message an agent receives. Structured so the agent can act
// without further prompting: who it is, what the mission is, where it works,
// how it reports state (the markers), and exactly when it is done.
export function buildAgentBriefing(ctx: BriefingContext): string {
  const def = ROLES[ctx.role];
  const lines: string[] = [];

  lines.push(`You are the **${def.title}** agent in a hark orchestration.`);
  lines.push("");
  lines.push(`Orchestration: ${ctx.orchestrationName}`);
  lines.push(`Mission goal: ${ctx.goal}`);
  lines.push("");
  lines.push(
    `You are working in an ISOLATED git worktree at ${ctx.worktreeDir}, on branch \`${ctx.branch}\`. ` +
      `This is your sandbox — everything you do is confined to it. Do not cd outside it or touch other branches.`,
  );
  lines.push("");
  lines.push(`## Your charter (${def.title})`);
  lines.push(def.summary);
  for (const c of def.charter) lines.push(`- ${c}`);
  lines.push("");
  lines.push("## Definition of done");
  lines.push(
    "You are NOT done until every item below holds. Self-review against this list before declaring completion:",
  );
  for (const d of def.definitionOfDone) lines.push(`- ${d}`);

  if (ctx.upstream && ctx.upstream.trim().length > 0) {
    lines.push("");
    lines.push("## Upstream context");
    lines.push(ctx.upstream.trim());
  }

  lines.push("");
  lines.push("## Autonomy protocol");
  lines.push(
    `- Work autonomously toward the definition of done. Make reasonable decisions yourself; record each significant decision and why in a line you can point to later.`,
  );
  lines.push(
    `- When you finish and have self-reviewed against the definition of done, end your final message with the exact token \`${DONE_MARKER}\` on its own line, preceded by a 2-4 line summary of what you produced.`,
  );
  lines.push(
    `- If you are genuinely blocked and cannot proceed without a human decision, end your message with \`${BLOCKED_MARKER}\` on its own line, preceded by the specific question.`,
  );
  lines.push(
    `- If your output needs to be handed to another role, end with \`${HANDOFF_MARKER}\` on its own line, preceded by the handoff summary that role will need.`,
  );

  return lines.join("\n");
}
