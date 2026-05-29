import type {
  AgentLifecycle,
  Orchestration,
  OrchestrationSummary,
} from "../../shared/protocol.js";

// Orchestration-level roll-up — the "metrics" the brief asks for (tokens,
// autonomy time, success rate), aggregated across an orchestration's agents.
// Pure and derived entirely from the record, so it's safe to compute on the
// server for the dashboard or in the client; no IO, fully testable.
// OrchestrationSummary's shape lives in shared/protocol.ts (it crosses the wire).

export type { OrchestrationSummary };

const LIFECYCLES: AgentLifecycle[] = [
  "pending",
  "spawning",
  "running",
  "blocked",
  "review",
  "done",
  "failed",
  "cancelled",
];

export function summarizeOrchestration(
  orch: Orchestration,
): OrchestrationSummary {
  const byLifecycle = Object.fromEntries(
    LIFECYCLES.map((l) => [l, 0]),
  ) as Record<AgentLifecycle, number>;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let totalTurns = 0;
  let totalInterventions = 0;
  let totalAutonomyMs = 0;

  for (const a of orch.agents) {
    byLifecycle[a.lifecycle] = (byLifecycle[a.lifecycle] ?? 0) + 1;
    totalInputTokens += a.metrics.inputTokens;
    totalOutputTokens += a.metrics.outputTokens;
    totalCostUsd += a.metrics.costUsd;
    totalTurns += a.metrics.turns;
    totalInterventions += a.metrics.interventions;
    if (a.briefedAt != null && a.updatedAt >= a.briefedAt) {
      totalAutonomyMs += a.updatedAt - a.briefedAt;
    }
  }

  const done = byLifecycle.done;
  const failed = byLifecycle.failed;
  const terminal = done + failed;
  const successRate = terminal > 0 ? done / terminal : null;

  return {
    agentCount: orch.agents.length,
    byLifecycle,
    successRate,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCostUsd,
    totalTurns,
    totalInterventions,
    totalAutonomyMs,
  };
}
