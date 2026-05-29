import type { Orchestration } from "../../shared/protocol.js";

// Glue between the orchestration model and hark's live-session view. An agent
// is spawned with a known pid but no session id (Claude Code assigns the id
// only after the session registers, past its trust prompt). Once the session
// appears in the live list, we match it back to its agent by pid and backfill
// the id — that backfill is also the readiness signal the autonomy controller
// waits on (a session in the live list is registered and past trust).
//
// Pure so it's testable without tmux or the filesystem; the server feeds it
// the live-session snapshot it already computes for /api/sessions.

export interface LiveSessionRef {
  sessionId: string;
  pid: number;
}

export interface AgentSessionLink {
  orchId: string;
  agentId: string;
  sessionId: string;
}

// For every active orchestration agent that has a pid but not yet a session
// id, find the live session sharing its pid and return the link to backfill.
export function correlateAgentSessions(
  orchestrations: Orchestration[],
  live: LiveSessionRef[],
): AgentSessionLink[] {
  const byPid = new Map<number, string>();
  for (const s of live) byPid.set(s.pid, s.sessionId);

  const links: AgentSessionLink[] = [];
  for (const orch of orchestrations) {
    if (orch.status !== "active") continue;
    for (const agent of orch.agents) {
      if (agent.sessionId || agent.pid == null) continue;
      const sessionId = byPid.get(agent.pid);
      if (sessionId) {
        links.push({ orchId: orch.id, agentId: agent.id, sessionId });
      }
    }
  }
  return links;
}

// Set of session ids currently live — a session id present here is "ready"
// (registered + past trust), which is what the controller's sessionReady
// predicate needs.
export function liveSessionIdSet(live: LiveSessionRef[]): Set<string> {
  return new Set(live.map((s) => s.sessionId));
}
