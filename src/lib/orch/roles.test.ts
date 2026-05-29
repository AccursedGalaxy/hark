import { describe, it, expect } from "vitest";
import {
  AGENT_ROLES,
  BLOCKED_MARKER,
  DONE_MARKER,
  HANDOFF_MARKER,
  ROLES,
  buildAgentBriefing,
  buildHeadBriefing,
  buildPmHeadBriefing,
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

  it("surfaces the dispatched task when the head provides one", () => {
    const without = buildAgentBriefing({ role: "coder", ...base });
    expect(without).not.toContain("## Your task");

    const withTask = buildAgentBriefing({
      role: "coder",
      ...base,
      task: "Implement the dependsOn worktree derivation",
    });
    expect(withTask).toContain("## Your task");
    expect(withTask).toContain("Implement the dependsOn worktree derivation");
  });
});

describe("buildHeadBriefing", () => {
  const ctx = {
    orchestrationName: "Ship login",
    goal: "Add OAuth login end-to-end",
    branch: "hark/ship-login/head",
    worktreeDir: "/home/u/.hark/worktrees/app/orch-1/head",
  };

  it("establishes the head role, goal, and orchestration-scoped DONE", () => {
    const b = buildHeadBriefing(ctx);
    expect(b.toLowerCase()).toContain("head");
    expect(b).toContain("Add OAuth login end-to-end");
    expect(b).toContain(ctx.worktreeDir);
    // The head's DONE means the whole orchestration is done, not one agent.
    expect(b).toContain(DONE_MARKER);
  });

  it("teaches the hark CLI action surface", () => {
    const b = buildHeadBriefing(ctx);
    expect(b).toContain("hark orch status");
    expect(b).toContain("hark agent spawn");
    expect(b).toContain("hark agent send");
    expect(b).toContain("hark agent diff");
    expect(b).toContain("hark agent brief");
  });

  it("lists the role palette the head can draw from", () => {
    const b = buildHeadBriefing(ctx);
    for (const role of AGENT_ROLES) {
      expect(b.toLowerCase()).toContain(role);
    }
  });

  it("states the context-discipline constraint (lead, not a reader)", () => {
    const b = buildHeadBriefing(ctx);
    expect(b.toLowerCase()).toContain("summaries");
    expect(b.toLowerCase()).toContain("lead");
  });
});

describe("buildPmHeadBriefing", () => {
  const ctx = {
    projectName: "hark",
    projectRoot: "/home/u/Projects/hark",
    branch: "main",
    planPath: "/home/u/Projects/hark/PLAN.md",
  };

  it("establishes the persistent PM persona, not a task-scoped executor", () => {
    const b = buildPmHeadBriefing(ctx);
    const low = b.toLowerCase();
    expect(low).toContain("product manager");
    // PLAN.md is the durable brain it owns.
    expect(b).toContain("PLAN.md");
    expect(b).toContain(ctx.projectRoot);
    expect(b).toContain(ctx.projectName);
  });

  it("states the pure-PM read-only-tree invariant and that a hook enforces it", () => {
    const b = buildPmHeadBriefing(ctx);
    const low = b.toLowerCase();
    expect(low).toContain("read-only");
    // Never writes or runs source; only PLAN.md + coordination files.
    expect(low).toMatch(/never (write|writes|edit|edits|mutate|mutates).*source|source.*never/);
    expect(low).toContain("hook");
  });

  it("teaches the three dispatch choices per item (you-apply / propose / dispatch)", () => {
    const b = buildPmHeadBriefing(ctx).toLowerCase();
    expect(b).toContain("apply");
    expect(b).toContain("propose");
    expect(b).toContain("dispatch");
  });

  it("encodes the PLAN.md editing discipline (targeted edits, Now cap, drain Inbox)", () => {
    const b = buildPmHeadBriefing(ctx);
    const low = b.toLowerCase();
    expect(low).toContain("targeted edit");
    expect(low).toContain("inbox");
    expect(b).toContain("North Star");
  });

  it("states the human owns the final landing", () => {
    const b = buildPmHeadBriefing(ctx).toLowerCase();
    expect(b).toMatch(/human (owns|lands)|you (own|land)|never lands?/);
  });

  it("teaches the hark CLI action surface for dispatching workers", () => {
    const b = buildPmHeadBriefing(ctx);
    expect(b).toContain("hark orch status");
    expect(b).toContain("hark agent spawn");
  });

  it("does NOT tell the PM to close the orchestration with a DONE marker", () => {
    // A persistent PM is never 'done' — unlike the task-scoped executor head,
    // it must not emit an orchestration-closing DONE marker.
    const b = buildPmHeadBriefing(ctx);
    expect(b).not.toContain(DONE_MARKER);
  });

  it("teaches news triage (surface-now vs note-to-PLAN, don't dump)", () => {
    const b = buildPmHeadBriefing(ctx);
    const low = b.toLowerCase();
    expect(low).toContain("team news");
    expect(low).toContain("surface");
    expect(low).toContain("note to plan");
  });

  it("surfaces the autonomy level when provided", () => {
    const withDial = buildPmHeadBriefing({ ...ctx, autonomyLevel: "L2" });
    expect(withDial).toContain("L2");
    const without = buildPmHeadBriefing(ctx);
    expect(without).not.toContain("Autonomy dial");
  });
});
