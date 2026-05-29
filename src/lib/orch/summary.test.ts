import { describe, it, expect } from "vitest";
import { summarizeOrchestration } from "./summary.js";
import {
  emptyAgentMetrics,
  type AgentLifecycle,
  type OrchAgent,
  type Orchestration,
} from "../../shared/protocol.js";

function agent(over: Partial<OrchAgent> & { lifecycle: AgentLifecycle }): OrchAgent {
  return {
    id: "a",
    orchestrationId: "o",
    role: "coder",
    branch: "b",
    worktreeDir: "/wt",
    sessionId: null,
    pid: null,
    createdAt: 0,
    updatedAt: 0,
    metrics: emptyAgentMetrics(),
    ...over,
  };
}

function orch(agents: OrchAgent[]): Orchestration {
  return {
    id: "o",
    name: "n",
    goal: "g",
    projectRoot: "/r",
    projectName: "r",
    baseRef: "main",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    agents,
  };
}

describe("summarizeOrchestration", () => {
  it("counts agents by lifecycle", () => {
    const s = summarizeOrchestration(
      orch([
        agent({ lifecycle: "running" }),
        agent({ lifecycle: "running" }),
        agent({ lifecycle: "done" }),
      ]),
    );
    expect(s.agentCount).toBe(3);
    expect(s.byLifecycle.running).toBe(2);
    expect(s.byLifecycle.done).toBe(1);
    expect(s.byLifecycle.blocked).toBe(0);
  });

  it("computes success rate from terminal verdicts only", () => {
    expect(
      summarizeOrchestration(
        orch([
          agent({ lifecycle: "done" }),
          agent({ lifecycle: "done" }),
          agent({ lifecycle: "failed" }),
          agent({ lifecycle: "running" }), // not terminal — excluded
        ]),
      ).successRate,
    ).toBeCloseTo(2 / 3);
  });

  it("returns null success rate when nothing has finished", () => {
    expect(
      summarizeOrchestration(
        orch([agent({ lifecycle: "running" }), agent({ lifecycle: "blocked" })]),
      ).successRate,
    ).toBeNull();
  });

  it("sums tokens, turns, interventions, and cost", () => {
    const mk = (i: number, o: number, turns: number, iv: number, cost: number) =>
      agent({
        lifecycle: "running",
        metrics: {
          ...emptyAgentMetrics(),
          inputTokens: i,
          outputTokens: o,
          turns,
          interventions: iv,
          costUsd: cost,
        },
      });
    const s = summarizeOrchestration(orch([mk(100, 10, 1, 0, 0.5), mk(200, 20, 2, 1, 1.5)]));
    expect(s.totalInputTokens).toBe(300);
    expect(s.totalOutputTokens).toBe(30);
    expect(s.totalTokens).toBe(330);
    expect(s.totalTurns).toBe(3);
    expect(s.totalInterventions).toBe(1);
    expect(s.totalCostUsd).toBeCloseTo(2.0);
  });

  it("derives autonomy time from briefedAt → updatedAt per briefed agent", () => {
    const s = summarizeOrchestration(
      orch([
        agent({ lifecycle: "done", briefedAt: 1000, updatedAt: 6000 }), // 5000
        agent({ lifecycle: "running", briefedAt: 2000, updatedAt: 4000 }), // 2000
        agent({ lifecycle: "pending" }), // never briefed — 0
      ]),
    );
    expect(s.totalAutonomyMs).toBe(7000);
  });
});
