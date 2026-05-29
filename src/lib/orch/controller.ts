import {
  BLOCKED_MARKER,
  DONE_MARKER,
  HANDOFF_MARKER,
} from "./roles.js";
import type { OrchStore } from "./store.js";
import type { Orchestrator } from "./orchestrator.js";
import type {
  AgentLifecycle,
  AgentMetrics,
  OrchAgent,
  TranscriptEvent,
} from "../../shared/protocol.js";

// The autonomy controller is the loop that lets agents run as agents: it
// delivers each agent its briefing once its session is ready, watches the
// transcript for the autonomy markers, and decides what happens at each turn
// boundary — advance, nudge (self-review loop), or block for a human. The
// decision is a pure function (decideAutonomyAction) so the policy is fully
// testable; the controller class is the thin part that performs IO through
// injected deps.

// ---- Marker scanning --------------------------------------------------------

export type MarkerKind = "done" | "blocked" | "handoff";

export interface MarkerScan {
  kind: MarkerKind | null;
  // The lines preceding the marker — the agent's summary / question / handoff.
  summary: string;
}

const MARKERS: { token: string; kind: MarkerKind }[] = [
  { token: DONE_MARKER, kind: "done" },
  { token: BLOCKED_MARKER, kind: "blocked" },
  { token: HANDOFF_MARKER, kind: "handoff" },
];

// Find the LAST marker in the text (the agent's most recent signal wins, in
// case an earlier turn left a stale one) and extract the summary that precedes
// it. Returns kind=null when no marker is present.
export function scanMarkers(text: string): MarkerScan {
  let best: { kind: MarkerKind; at: number; tokenLen: number } | null = null;
  for (const m of MARKERS) {
    const at = text.lastIndexOf(m.token);
    if (at === -1) continue;
    if (!best || at > best.at) best = { kind: m.kind, at, tokenLen: m.token.length };
  }
  if (!best) return { kind: null, summary: "" };
  const before = text.slice(0, best.at).trim();
  // Keep the trailing few non-empty lines as the human-facing summary.
  const lines = before.split("\n").map((l) => l.trim());
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 8; i--) {
    if (lines[i].length > 0) tail.unshift(lines[i]);
    else if (tail.length > 0) break; // stop at the first blank above the block
  }
  return { kind: best.kind, summary: tail.join("\n") };
}

// Concatenate the text the agent actually emitted (assistant text blocks) so
// scanMarkers sees prose, not tool calls. Most recent turns last.
export function transcriptText(events: TranscriptEvent[]): string {
  const parts: string[] = [];
  for (const e of events) {
    if (e.kind === "assistant") {
      for (const b of e.blocks) {
        if (b.type === "text") parts.push(b.text);
      }
    }
  }
  return parts.join("\n");
}

// ---- Metrics ----------------------------------------------------------------

export type TranscriptMetrics = Pick<
  AgentMetrics,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "turns"
>;

// Cumulative token + turn totals across the whole transcript. The controller
// SETS these on the agent (the transcript is the source of truth), preserving
// the lifecycle-derived fields (autonomyMs, interventions, costUsd).
export function metricsFromTranscript(
  events: TranscriptEvent[],
): TranscriptMetrics {
  const m: TranscriptMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turns: 0,
  };
  for (const e of events) {
    if (e.kind !== "assistant") continue;
    m.turns++;
    if (e.usage) {
      m.inputTokens += e.usage.inputTokens;
      m.outputTokens += e.usage.outputTokens;
      m.cacheReadTokens += e.usage.cacheReadInputTokens;
      m.cacheCreationTokens += e.usage.cacheCreationInputTokens;
    }
  }
  return m;
}

// ---- Decision state machine -------------------------------------------------

export interface AutonomyState {
  lifecycle: AgentLifecycle;
  // Session is registered with Claude Code and past its trust prompt — i.e.
  // safe to send the briefing / nudges to.
  sessionReady: boolean;
  briefingDelivered: boolean;
  // A Stop hook fired: the agent ended a turn (reached a turn boundary).
  stopped: boolean;
  scan: MarkerScan;
  // Self-review nudges already sent this run.
  nudges: number;
  maxNudges: number;
}

export type AutonomyAction =
  | { type: "deliver_briefing" }
  | { type: "set_lifecycle"; lifecycle: AgentLifecycle; reason?: string }
  | { type: "nudge" }
  | { type: "none" };

const TERMINAL: AgentLifecycle[] = ["done", "failed", "cancelled"];

// Pure policy. Given everything we know about an agent at a turn boundary,
// decide the single next action. Order matters: terminal states are inert,
// briefing comes before anything else, an explicit marker always wins, and the
// self-review nudge loop only kicks in when the agent stopped silently.
export function decideAutonomyAction(s: AutonomyState): AutonomyAction {
  if (TERMINAL.includes(s.lifecycle)) return { type: "none" };

  if (!s.briefingDelivered) {
    return s.sessionReady ? { type: "deliver_briefing" } : { type: "none" };
  }

  switch (s.scan.kind) {
    case "done":
      return { type: "set_lifecycle", lifecycle: "done" };
    case "blocked":
      return {
        type: "set_lifecycle",
        lifecycle: "blocked",
        reason: s.scan.summary || "agent reported it is blocked",
      };
    case "handoff":
      return { type: "set_lifecycle", lifecycle: "review", reason: s.scan.summary };
    default:
      break;
  }

  // No marker. If the agent stopped while still running, it ended its turn
  // without declaring done/blocked — run the self-review loop: nudge it back
  // toward its definition of done, up to a bound, then escalate to a human.
  if (s.stopped && s.lifecycle === "running") {
    if (!s.sessionReady) return { type: "none" };
    if (s.nudges < s.maxNudges) return { type: "nudge" };
    return {
      type: "set_lifecycle",
      lifecycle: "blocked",
      reason: `stopped without finishing after ${s.maxNudges} self-review nudges — needs a human`,
    };
  }

  return { type: "none" };
}

// The message sent when nudging an agent that stopped without finishing.
export function buildNudge(): string {
  return [
    "You stopped without signalling completion. Re-read your definition of done.",
    `If every item holds, end with ${DONE_MARKER} and a short summary.`,
    `If you are blocked on a human decision, end with ${BLOCKED_MARKER} and the question.`,
    "Otherwise, keep working toward the definition of done.",
  ].join(" ");
}

// ---- Controller -------------------------------------------------------------

export interface ControllerDeps {
  store: OrchStore;
  orchestrator: Orchestrator;
  // Recent transcript events for a session (marker scan + metrics).
  readTranscript: (sessionId: string) => Promise<TranscriptEvent[]>;
  // Deliver text to the agent's live session via the hardened tmux send path.
  sendText: (agent: OrchAgent, text: string) => Promise<void>;
  // Whether the agent's session is registered and past its trust prompt.
  sessionReady: (agent: OrchAgent) => Promise<boolean>;
  now?: () => number;
  maxNudges?: number;
}

const DEFAULT_MAX_NUDGES = 3;

export class AutonomyController {
  constructor(private readonly deps: ControllerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // The single integration point: called when something happens for an
  // orchestration-owned agent — a Stop hook (`stopped: true`) or a periodic
  // reconcile tick (`stopped: false`). Idempotent and safe to call often.
  async onAgentSignal(
    orchId: string,
    agentId: string,
    opts: { stopped: boolean },
  ): Promise<AutonomyAction> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch) return { type: "none" };
    const agent = orch.agents.find((a) => a.id === agentId);
    if (!agent) return { type: "none" };

    const sessionReady = await this.deps.sessionReady(agent);

    // Pull transcript for marker scan + metrics (only if there's a session).
    let scan: MarkerScan = { kind: null, summary: "" };
    if (agent.sessionId) {
      const events = await this.deps.readTranscript(agent.sessionId);
      scan = scanMarkers(transcriptText(events));
      const tm = metricsFromTranscript(events);
      await this.deps.store.updateAgent(orchId, agentId, (a) => {
        a.metrics.inputTokens = tm.inputTokens;
        a.metrics.outputTokens = tm.outputTokens;
        a.metrics.cacheReadTokens = tm.cacheReadTokens;
        a.metrics.cacheCreationTokens = tm.cacheCreationTokens;
        a.metrics.turns = tm.turns;
      });
    }

    const nudges = await this.countNudges(orchId, agentId);
    const action = decideAutonomyAction({
      lifecycle: agent.lifecycle,
      sessionReady,
      briefingDelivered: agent.briefedAt != null,
      stopped: opts.stopped,
      scan,
      nudges,
      maxNudges: this.deps.maxNudges ?? DEFAULT_MAX_NUDGES,
    });

    await this.perform(orch.id, agent, action);
    return action;
  }

  private async perform(
    orchId: string,
    agent: OrchAgent,
    action: AutonomyAction,
  ): Promise<void> {
    switch (action.type) {
      case "deliver_briefing": {
        const orch = await this.deps.store.getOrchestration(orchId);
        if (!orch) return;
        const briefing = this.deps.orchestrator.briefingFor(orch, agent);
        await this.deps.sendText(agent, briefing);
        await this.deps.store.updateAgent(orchId, agent.id, (a) => {
          a.briefedAt = this.now();
          if (a.lifecycle === "pending" || a.lifecycle === "spawning") {
            a.lifecycle = "running";
          }
        });
        await this.deps.store.appendEvent({
          ts: this.now(),
          orchestrationId: orchId,
          agentId: agent.id,
          kind: "checkpoint",
          message: `briefing delivered to ${agent.role}`,
          data: { kind: "briefing" },
        });
        return;
      }
      case "nudge": {
        await this.deps.sendText(agent, buildNudge());
        await this.deps.store.appendEvent({
          ts: this.now(),
          orchestrationId: orchId,
          agentId: agent.id,
          kind: "checkpoint",
          message: `self-review nudge to ${agent.role}`,
          data: { kind: "nudge" },
        });
        return;
      }
      case "set_lifecycle": {
        // A human-blocking transition counts as an intervention point.
        await this.deps.store.setAgentLifecycle(
          orchId,
          agent.id,
          action.lifecycle,
          { reason: action.reason },
        );
        if (action.lifecycle === "blocked") {
          await this.deps.store.updateAgent(orchId, agent.id, (a) => {
            a.metrics.interventions += 1;
          });
        }
        return;
      }
      case "none":
      default:
        return;
    }
  }

  // Refresh an agent's token/turn metrics from its transcript without making
  // any decision or sending anything. Safe to call on a tick regardless of
  // whether active autonomy (briefing/nudging) is enabled, so the dashboard
  // stays current either way.
  async refreshMetrics(orchId: string, agentId: string): Promise<void> {
    const orch = await this.deps.store.getOrchestration(orchId);
    const agent = orch?.agents.find((a) => a.id === agentId);
    if (!agent?.sessionId) return;
    const events = await this.deps.readTranscript(agent.sessionId);
    const tm = metricsFromTranscript(events);
    await this.deps.store.updateAgent(orchId, agentId, (a) => {
      a.metrics.inputTokens = tm.inputTokens;
      a.metrics.outputTokens = tm.outputTokens;
      a.metrics.cacheReadTokens = tm.cacheReadTokens;
      a.metrics.cacheCreationTokens = tm.cacheCreationTokens;
      a.metrics.turns = tm.turns;
    });
  }

  // Count the self-review nudges already sent to an agent, from the event log.
  private async countNudges(orchId: string, agentId: string): Promise<number> {
    const events = await this.deps.store.readEvents(orchId);
    return events.filter(
      (e) =>
        e.agentId === agentId &&
        e.kind === "checkpoint" &&
        (e.data as { kind?: string } | undefined)?.kind === "nudge",
    ).length;
  }
}
