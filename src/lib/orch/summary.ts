import type {
  AgentLifecycle,
  Orchestration,
} from "../../shared/protocol.js";

// Orchestration-level roll-up — the "metrics" the brief asks for (tokens,
// autonomy time, success rate), aggregated across an orchestration's agents.
// Pure and derived entirely from the record, so it's safe to compute on the
// server for the dashboard or in the client; no IO, fully testable.

export interface OrchestrationSummary {
  agentCount: number;
  // Counts per lifecycle bucket — every agent lands in exactly one.
  byLifecycle: Record<AgentLifecycle, number>;
  // done / (done + failed). null when no agent has reached a terminal verdict
  // yet (avoids reporting a misleading 0% or 100% on an in-flight run).
  successRate: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalTurns: number;
  totalInterventions: number;
  // Sum of each briefed agent's wall-clock from briefing to its last update —
  // a wall-clock proxy for autonomy time (refined per-agent tracking later).
  totalAutonomyMs: number;
}

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
