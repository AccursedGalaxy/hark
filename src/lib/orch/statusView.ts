import {
  isTerminalLifecycle,
  type AgentStatusLine,
  type OrchStatusView,
  type Orchestration,
} from "../../shared/protocol.js";

// Build the lean status view the `hark orch status` command renders. Pure:
// the server computes per-agent diffstats (git) separately and passes them in
// as a map, keeping this testable without a repo. Token totals collapse the
// per-agent input+output into one figure (the head wants a glance, not a
// breakdown). No transcripts, ever — context discipline.
//
// By default terminal workers (done/blocked/failed/stopped/cancelled) are
// hidden so landed/halted workers stop re-cluttering the PM's primary surface;
// active workers always show. `opts.all` reveals everything. Records are never
// deleted — this is a view-level filter only.
export function buildStatusView(
  orch: Orchestration,
  diffstats: Record<string, string> = {},
  opts: { all?: boolean } = {},
): OrchStatusView {
  const visible = opts.all
    ? orch.agents
    : orch.agents.filter((a) => !isTerminalLifecycle(a.lifecycle));
  const agents: AgentStatusLine[] = visible.map((a) => ({
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
