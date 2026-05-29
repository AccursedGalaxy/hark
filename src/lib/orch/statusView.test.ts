import { describe, it, expect } from "vitest";
import { buildStatusView } from "./statusView.js";
import {
  emptyAgentMetrics,
  type OrchAgent,
  type Orchestration,
} from "../../shared/protocol.js";

function agent(over: Partial<OrchAgent>): OrchAgent {
  return {
    id: "agent-1",
    orchestrationId: "orch-1",
    role: "coder",
    branch: "hark/o/coder-1",
    worktreeDir: "/wt",
    sessionId: "s",
    pid: 1,
    lifecycle: "running",
    createdAt: 0,
    updatedAt: 0,
    metrics: { ...emptyAgentMetrics(), turns: 4, inputTokens: 1000, outputTokens: 200 },
    ...over,
  };
}

function orch(over: Partial<Orchestration>): Orchestration {
  return {
    id: "orch-1",
    name: "Ship login",
    goal: "Add OAuth",
    projectRoot: "/r",
    projectName: "r",
    baseRef: "main",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    agents: [],
    ...over,
  };
}

describe("buildStatusView", () => {
  it("collapses per-agent metrics and injects diffstats", () => {
    const o = orch({
      agents: [agent({ id: "a1", task: "Build parser" })],
    });
    const view = buildStatusView(o, { a1: "2 files +30/-4" });
    expect(view.id).toBe("orch-1");
    expect(view.agents[0]).toEqual({
      id: "a1",
      role: "coder",
      lifecycle: "running",
      branch: "hark/o/coder-1",
      diffstat: "2 files +30/-4",
      turns: 4,
      tokens: 1200,
      task: "Build parser",
    });
  });

  it("surfaces the head when present, omits it when headless", () => {
    const withHead = buildStatusView(
      orch({
        head: {
          sessionId: "sess-head",
          pid: 9,
          worktreeDir: "/wt/head",
          branch: "hark/o/head",
          briefedAt: 123,
          metrics: { ...emptyAgentMetrics(), turns: 7, inputTokens: 500, outputTokens: 100 },
        },
      }),
    );
    expect(withHead.head).toEqual({
      branch: "hark/o/head",
      sessionId: "sess-head",
      briefed: true,
      turns: 7,
      tokens: 600,
    });

    expect(buildStatusView(orch({})).head).toBeUndefined();
  });

  it("defaults diffstat to empty when not provided", () => {
    const view = buildStatusView(orch({ agents: [agent({ id: "a1" })] }));
    expect(view.agents[0].diffstat).toBe("");
  });
});
