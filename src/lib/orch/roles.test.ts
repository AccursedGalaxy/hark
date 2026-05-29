import { describe, it, expect } from "vitest";
import {
  AGENT_ROLES,
  BLOCKED_MARKER,
  DONE_MARKER,
  HANDOFF_MARKER,
  ROLES,
  buildAgentBriefing,
  type AgentRole,
} from "./roles.js";

describe("ROLES", () => {
  it("defines all five roles with a charter and definition of done", () => {
    const expected: AgentRole[] = [
      "researcher",
      "coder",
      "tester",
      "documenter",
      "reviewer",
    ];
    expect(AGENT_ROLES).toEqual(expected);
    for (const role of expected) {
      const def = ROLES[role];
      expect(def.role).toBe(role);
      expect(def.title.length).toBeGreaterThan(0);
      expect(def.charter.length).toBeGreaterThan(0);
      expect(def.definitionOfDone.length).toBeGreaterThan(0);
    }
  });
});

describe("buildAgentBriefing", () => {
  const base = {
    orchestrationName: "Ship login",
    goal: "Add OAuth login",
    branch: "hark/ship-login/coder-a1",
    worktreeDir: "/home/u/.hark/worktrees/app/orch-1/coder-1",
  };

  it("embeds role, goal, isolation context, and the autonomy markers", () => {
    const b = buildAgentBriefing({ role: "coder", ...base });
    expect(b).toContain("**Coder**");
    expect(b).toContain("Add OAuth login");
    expect(b).toContain(base.branch);
    expect(b).toContain(base.worktreeDir);
    expect(b).toContain("ISOLATED git worktree");
    expect(b).toContain(DONE_MARKER);
    expect(b).toContain(BLOCKED_MARKER);
    expect(b).toContain(HANDOFF_MARKER);
  });

  it("includes the role's definition-of-done items", () => {
    const b = buildAgentBriefing({ role: "reviewer", ...base });
    for (const item of ROLES.reviewer.definitionOfDone) {
      expect(b).toContain(item);
    }
  });

  it("includes upstream context only when provided", () => {
    const without = buildAgentBriefing({ role: "tester", ...base });
    expect(without).not.toContain("## Upstream context");

    const withUp = buildAgentBriefing({
      role: "tester",
      ...base,
      upstream: "Researcher found the bug is in auth.ts:42",
    });
    expect(withUp).toContain("## Upstream context");
    expect(withUp).toContain("auth.ts:42");
  });

  it("renders each role without throwing and keeps the title accurate", () => {
    for (const role of AGENT_ROLES) {
      const b = buildAgentBriefing({ role, ...base });
      expect(b).toContain(`**${ROLES[role].title}**`);
    }
  });
});
