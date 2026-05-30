import type {
  AgentRole,
  OrchEvent,
  Orchestration,
} from "../../shared/protocol.js";

// The newsroom bus (PM-Head Orchestration Harness, spec §3.4): a project-level,
// filtered, cursored projection over the per-orch `events.jsonl` files — NOT
// the raw log. Filtered to the items a PM cares about (a worker reached
// done/blocked/review/failed, or an orchestration completed), merged across ALL
// of the project's live orchestrations (resolved §8.2), time-ordered.
//
// It backs both the `UserPromptSubmit` delta injection (pull at turn
// boundaries) and the dashboard feed. Pure + IO-free: the caller supplies the
// orchestrations + their event logs and a cursor; the server enriches each item
// with a live diffstat separately (git IO stays out of the projection).

export type NewsKind = "done" | "blocked" | "handoff" | "failed" | "completed";

export interface NewsItem {
  ts: number;
  orchestrationId: string;
  orchestrationName: string;
  agentId?: string;
  role?: AgentRole;
  branch?: string;
  kind: NewsKind;
  // What the PM needs to triage the item — a reason/handoff summary when one
  // exists, else a terse "<role> <kind>" line. Diffstat is attached by the
  // server (it's git IO), not here.
  summary: string;
  diffstat?: string;
}

export interface NewsroomDelta {
  items: NewsItem[];
  // High-water mark to pass as the next `?since`. Advances past irrelevant
  // events too, so a quiet stretch of non-news events isn't re-scanned forever.
  cursor: number;
}

// One project orchestration + its raw event log.
export interface OrchEventsInput {
  orch: Orchestration;
  events: OrchEvent[];
}

// agent_lifecycle transitions a PM cares about → news kind. running/spawning/
// pending/cancelled are deliberately excluded (noise).
const LIFECYCLE_NEWS: Record<string, NewsKind> = {
  done: "done",
  blocked: "blocked",
  review: "handoff",
  failed: "failed",
};

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

// Project one raw event into a NewsItem, or null if it isn't head-relevant.
function projectEvent(orch: Orchestration, e: OrchEvent): NewsItem | null {
  const data = asObj(e.data);
  const common = {
    ts: e.ts,
    orchestrationId: orch.id,
    orchestrationName: orch.name,
  };

  if (e.kind === "agent_lifecycle") {
    const lc = typeof data.lifecycle === "string" ? data.lifecycle : "";
    const kind = LIFECYCLE_NEWS[lc];
    if (!kind) return null;
    const role = typeof data.role === "string" ? (data.role as AgentRole) : undefined;
    const branch = typeof data.branch === "string" ? data.branch : undefined;
    const reason = typeof data.reason === "string" ? data.reason.trim() : "";
    return {
      ...common,
      agentId: e.agentId,
      role,
      branch,
      kind,
      summary: reason.length > 0 ? reason : `${role ?? "worker"} ${kind}`,
    };
  }

  if (e.kind === "orchestration_status") {
    const status = typeof data.status === "string" ? data.status : "";
    if (status !== "completed") return null;
    return { ...common, kind: "completed", summary: `${orch.name} completed` };
  }

  return null;
}

// Build the project newsroom delta: every head-relevant event with `ts > since`
// across the given orchestrations, time-ordered, with a cursor that advances
// past all events seen (not just the relevant ones).
export function buildNewsroom(
  inputs: OrchEventsInput[],
  since = 0,
): NewsroomDelta {
  const items: NewsItem[] = [];
  let cursor = since;
  for (const { orch, events } of inputs) {
    for (const e of events) {
      if (e.ts <= since) continue;
      if (e.ts > cursor) cursor = e.ts;
      const item = projectEvent(orch, e);
      if (item) items.push(item);
    }
  }
  items.sort((a, b) => a.ts - b.ts);
  return { items, cursor };
}

// Render a newsroom delta as the text injected into a head turn via the
// UserPromptSubmit hook ("TEAM NEWS since last turn: …"). Compact, one line per
// item; empty string when there's nothing new (caller injects nothing then).
const KIND_VERB: Record<NewsKind, string> = {
  done: "DONE",
  blocked: "BLOCKED",
  handoff: "handed off",
  failed: "FAILED",
  completed: "orchestration completed",
};

export function renderNewsForInjection(items: NewsItem[]): string {
  if (items.length === 0) return "";
  const lines: string[] = [];
  lines.push("TEAM NEWS since your last turn (triage per your charter — surface what matters, record the rest on the board, don't dump it):");
  for (const it of items) {
    const who = it.role ? `${it.role}` : "team";
    const where = it.branch ? ` on \`${it.branch}\`` : "";
    const stat = it.diffstat ? ` (${it.diffstat})` : "";
    const summary = it.summary ? ` — ${it.summary}` : "";
    lines.push(`- ${who} ${KIND_VERB[it.kind]}${where}${stat}${summary}`);
  }
  lines.push(
    "Use `hark orch status` / `hark agent diff <id>` for detail only if a decision needs it.",
  );
  return lines.join("\n");
}
