import type {
  AgentStatusLine,
  OrchStatusView,
  Orchestration,
} from "../../shared/protocol.js";

// Build the lean status view the `hark orch status` command renders. Pure:
// the server computes per-agent diffstats (git) separately and passes them in
// as a map, keeping this testable without a repo. Token totals collapse the
// per-agent input+output into one figure (the head wants a glance, not a
// breakdown). No transcripts, ever — context discipline.
export function buildStatusView(
  orch: Orchestration,
  diffstats: Record<string, string> = {},
): OrchStatusView {
  const agents: AgentStatusLine[] = orch.agents.map((a) => ({
    id: a.id,
    role: a.role,
    lifecycle: a.lifecycle,
    branch: a.branch,
    diffstat: diffstats[a.id] ?? "",
    turns: a.metrics.turns,
    tokens: a.metrics.inputTokens + a.metrics.outputTokens,
    task: a.task,
  }));

  return {
    id: orch.id,
    name: orch.name,
    goal: orch.goal,
    status: orch.status,
    head: orch.head
      ? {
          branch: orch.head.branch,
          sessionId: orch.head.sessionId,
          briefed: orch.head.briefedAt != null,
          turns: orch.head.metrics.turns,
          tokens:
            orch.head.metrics.inputTokens + orch.head.metrics.outputTokens,
        }
      : undefined,
    agents,
  };
}
