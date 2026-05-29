import {
  BLOCKED_MARKER,
  DONE_MARKER,
  HANDOFF_MARKER,
} from "./roles.js";
import type { OrchStore } from "./store.js";
import type { Orchestrator } from "./orchestrator.js";
import {
  DEFAULT_AUTONOMY_LEVEL,
  type AgentLifecycle,
  type AgentMetrics,
  type AgentRole,
  type AutonomyLevel,
  type OrchAgent,
  type Orchestration,
  type TranscriptEvent,
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

// ---- Head notifications -----------------------------------------------------

// The inbound message the head receives when a worker hits a marker. Carries
// only the summary + diffstat + commit count — NEVER the transcript — so the
// head can decide the next step without blowing its context budget (the
// make-or-break constraint of the head model).
export interface HeadNotification {
  role: AgentRole;
  agentId: string;
  branch: string;
  marker: MarkerKind;
  summary: string;
  diffstat: string;
  commitCount: number;
}

const MARKER_VERB: Record<MarkerKind, string> = {
  done: "reported DONE",
  blocked: "is BLOCKED and needs a decision",
  handoff: "HANDED OFF its work",
};

// Render a worker→head notification as the text typed into the head's session.
// Compact and action-oriented: it tells the head what happened and points at
// the lean CLI for detail — deliberately never says "read the transcript".
export function buildHeadNotification(n: HeadNotification): string {
  const lines: string[] = [];
  lines.push(
    `[worker update] ${n.role} (${n.agentId}) on \`${n.branch}\` ${MARKER_VERB[n.marker]}.`,
  );
  const stat = n.diffstat && n.diffstat.trim().length > 0 ? n.diffstat : "no diff yet";
  lines.push(`diff: ${stat} · ${n.commitCount} commit${n.commitCount === 1 ? "" : "s"}`);
  if (n.summary.trim().length > 0) {
    lines.push(`summary: ${n.summary.trim()}`);
  }
  lines.push(
    `Decide the next step. Use \`hark orch status\` for the team, or \`hark agent diff ${n.agentId} --full\` only if a judgment needs it.`,
  );
  return lines.join("\n");
}

// ---- Managed PM-head routing (idle loop + escalation, spec §3.5/§3.6) -------

// How a worker transition routes to a *managed* PM-head. The same event routes
// differently by mode (recency of human input) and the autonomy dial:
//   - blocker  → escalate to the human (tier 2; always, any mode/dial).
//   - advance (done/handoff), active conversation → pull (the newsroom delta
//     injected at the next human turn handles it — no push).
//   - advance, idle + dial L2/L3 → push the head a turn so the team advances.
//   - advance, idle + dial L0/L1 → none (wait for the human's nod).
// A non-managed (task-scoped executor) head is out of scope here — it keeps the
// legacy always-push behavior in notifyHead.
export type HeadRouting =
  | { type: "escalate" }
  | { type: "push" }
  | { type: "pull" }
  | { type: "none" };

export interface HeadRoutingInput {
  managed: boolean;
  marker: MarkerKind;
  autonomyLevel: AutonomyLevel;
  // Human has been quiet past the idle threshold (no recent prompt to the head).
  idle: boolean;
}

const ADVANCING_LEVELS = new Set<AutonomyLevel>(["L2", "L3"]);

export function decideHeadRouting(input: HeadRoutingInput): HeadRouting {
  if (!input.managed) return { type: "none" };
  if (input.marker === "blocked") return { type: "escalate" };
  // Pipeline advance (done / handoff).
  if (!input.idle) return { type: "pull" };
  return ADVANCING_LEVELS.has(input.autonomyLevel)
    ? { type: "push" }
    : { type: "none" };
}

// The turn pushed to an idle managed head so the pipeline advances on its own
// (tier 3). Event-driven (one message, then the head yields) — never a blocking
// watch — so the human's input always interleaves at the next turn boundary.
export function buildAdvancePush(
  n: HeadNotification,
  autonomyLevel: AutonomyLevel,
): string {
  const stat = n.diffstat && n.diffstat.trim().length > 0 ? n.diffstat : "no diff yet";
  return [
    `[idle advance · autonomy ${autonomyLevel}] ${n.role} (${n.agentId}) on \`${n.branch}\` ${MARKER_VERB[n.marker]}.`,
    `diff: ${stat} · ${n.commitCount} commit${n.commitCount === 1 ? "" : "s"}`,
    n.summary.trim().length > 0 ? `summary: ${n.summary.trim()}` : "",
    "You are idle and the dial permits autonomous advance. Move the pipeline forward: review the diff, dispatch the next stage (e.g. a tester on this branch) or prepare a PR, and update PLAN. Escalate blockers to the human; never land work yourself. Then yield — the human's next message will interleave.",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
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
  // ---- head-session model (all optional; absent → headless behavior) ----
  // Deliver text to the orchestration's head session (briefing, worker
  // notifications). Absent for legacy headless records / tests without a head.
  sendToHead?: (orch: Orchestration, text: string) => Promise<void>;
  // Whether the head session is registered and past its trust prompt.
  headReady?: (orch: Orchestration) => Promise<boolean>;
  // Compact git summary for a worker branch vs base — diffstat + commit count.
  // Used to enrich the worker→head notification without reading any transcript.
  agentGitSummary?: (
    orch: Orchestration,
    agent: OrchAgent,
  ) => Promise<{ diffstat: string; commitCount: number }>;
  // ---- managed PM-head routing (idle loop + escalation, §3.5/§3.6) ----
  // Page the human about a worker blocker (tier 2) through hark's attention
  // layer — the same path a solo session going ASKING uses. Always wired (it
  // doesn't type keystrokes). Absent → no escalation.
  escalateToHuman?: (
    orch: Orchestration,
    agent: OrchAgent,
    reason: string,
  ) => Promise<void>;
  // Push the managed head a single "advance" turn when it's idle and the dial
  // permits (tier 3). Provided ONLY when active autonomy is enabled
  // (HARK_ORCH_AUTONOMY=1), since it types into the session. Absent → no push.
  pushHeadTurn?: (orch: Orchestration, text: string) => Promise<void>;
  // How long the human must be quiet before the head is "idle" (ms).
  idleThresholdMs?: number;
  now?: () => number;
  maxNudges?: number;
}

const DEFAULT_MAX_NUDGES = 3;
// Default idle threshold: no human prompt to the head for 90s → idle. The idle
// loop pushes the head an advance turn only past this, so a momentary pause in
// an active conversation never triggers an autonomous push.
const DEFAULT_IDLE_MS = 90_000;

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
    const prevLifecycle = agent.lifecycle;
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

    // Head-session model: when a worker actually TRANSITIONS to a state the
    // head must act on (done/blocked/review), build a compact notification.
    // Gated on a real transition so the reconcile tick can't spam every 3s
    // while an agent sits blocked. For a task-scoped executor head this pushes
    // into its pane; for a managed PM-head it records the event and ROUTES by
    // mode + dial (escalate / idle-push / pull) per §3.5.
    if (
      action.type === "set_lifecycle" &&
      action.lifecycle !== prevLifecycle &&
      (action.lifecycle === "done" ||
        action.lifecycle === "blocked" ||
        action.lifecycle === "review") &&
      orch.head
    ) {
      const note = await this.notifyHead(orch, agent, scan);
      if (orch.managed && note) {
        await this.routeManagedHead(orch, agent, note);
      }
    }

    return action;
  }

  // Whether the managed head's human has been quiet long enough to be "idle".
  private isHeadIdle(orch: Orchestration): boolean {
    const threshold = this.deps.idleThresholdMs ?? DEFAULT_IDLE_MS;
    const last = orch.lastHumanAt ?? orch.createdAt;
    return this.now() - last > threshold;
  }

  // Route a worker transition for a managed PM-head: page the human on a
  // blocker, push an advance turn when idle + dial permits, else let the
  // newsroom pull handle it.
  private async routeManagedHead(
    orch: Orchestration,
    agent: OrchAgent,
    note: HeadNotification,
  ): Promise<void> {
    const routing = decideHeadRouting({
      managed: true,
      marker: note.marker,
      autonomyLevel: orch.autonomyLevel ?? DEFAULT_AUTONOMY_LEVEL,
      idle: this.isHeadIdle(orch),
    });
    if (routing.type === "escalate" && this.deps.escalateToHuman) {
      await this.deps.escalateToHuman(orch, agent, note.summary);
    } else if (routing.type === "push" && this.deps.pushHeadTurn) {
      await this.deps.pushHeadTurn(
        orch,
        buildAdvancePush(note, orch.autonomyLevel ?? DEFAULT_AUTONOMY_LEVEL),
      );
    }
  }

  // Build and deliver a worker→head notification. The git summary is best-
  // effort (a coordination nicety, not correctness): if it can't be computed
  // the notification still goes out with an empty diffstat.
  private async notifyHead(
    orch: Orchestration,
    agent: OrchAgent,
    scan: MarkerScan,
  ): Promise<HeadNotification | null> {
    if (!orch.head) return null;
    let diffstat = "";
    let commitCount = 0;
    if (this.deps.agentGitSummary) {
      try {
        const s = await this.deps.agentGitSummary(orch, agent);
        diffstat = s.diffstat;
        commitCount = s.commitCount;
      } catch {
        /* best-effort */
      }
    }
    const note: HeadNotification = {
      role: agent.role,
      agentId: agent.id,
      branch: agent.branch,
      marker: (scan.kind ?? "done") as MarkerKind,
      summary: scan.summary,
      diffstat,
      commitCount,
    };
    // A managed PM-head never gets a routine worker update pushed into its live
    // pane — that would force-type into an active conversation. It consumes
    // updates by PULL (newsroom at the next turn) or, when idle + the dial
    // permits, via routeManagedHead's advance push. A task-scoped executor head
    // keeps the original always-push behavior.
    if (!orch.managed && this.deps.sendToHead) {
      await this.deps.sendToHead(orch, buildHeadNotification(note));
    }
    await this.deps.store.appendEvent({
      ts: this.now(),
      orchestrationId: orch.id,
      agentId: agent.id,
      kind: "head_notified",
      message: `head notified: ${agent.role} → ${scan.kind ?? "update"}`,
      data: { marker: scan.kind, pushed: !orch.managed },
    });
    return note;
  }

  // The head's counterpart to onAgentSignal. The head is a coordinator, not a
  // worker, so it is NEVER nudged: it legitimately waits between worker events.
  // This only (1) delivers the head briefing once its session is ready, (2)
  // keeps head metrics fresh, and (3) interprets a head DONE marker as the
  // ORCHESTRATION being complete (Sharp Edge 6 — head markers are orch-scoped).
  async onHeadSignal(
    orchId: string,
    _opts: { stopped: boolean },
  ): Promise<void> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch?.head) return;
    const head = orch.head;

    // Metrics + marker scan (only once the session has registered).
    let scan: MarkerScan = { kind: null, summary: "" };
    if (head.sessionId) {
      const events = await this.deps.readTranscript(head.sessionId);
      scan = scanMarkers(transcriptText(events));
      const tm = metricsFromTranscript(events);
      await this.deps.store.updateHead(orchId, (h) => {
        h.metrics.inputTokens = tm.inputTokens;
        h.metrics.outputTokens = tm.outputTokens;
        h.metrics.cacheReadTokens = tm.cacheReadTokens;
        h.metrics.cacheCreationTokens = tm.cacheCreationTokens;
        h.metrics.turns = tm.turns;
      });
    }

    // A managed PM-head (promoted session) is NOT a task-scoped executor: its
    // charter was delivered as the `hark head init` stdout, it's driven by the
    // user + the idle loop, and it never emits an orchestration-closing DONE.
    // So skip the executor briefing-delivery + DONE-completion flow entirely —
    // we only keep its metrics fresh (above).
    if (orch.managed) return;

    // Deliver the head briefing once, when ready and not yet briefed.
    if (head.briefedAt == null && this.deps.sendToHead && this.deps.headReady) {
      const ready = await this.deps.headReady(orch);
      if (ready) {
        await this.deps.sendToHead(orch, this.deps.orchestrator.headBriefingFor(orch));
        await this.deps.store.updateHead(orchId, (h) => {
          h.briefedAt = this.now();
        });
        await this.deps.store.appendEvent({
          ts: this.now(),
          orchestrationId: orchId,
          kind: "checkpoint",
          message: "head briefing delivered",
          data: { kind: "head_briefing" },
        });
        return;
      }
    }

    // A head DONE closes the whole orchestration.
    if (scan.kind === "done" && orch.status === "active") {
      await this.deps.store.setStatus(orchId, "completed");
    }
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

  // Refresh the head's token/turn metrics from its transcript without making
  // any decision or typing anything. Safe to call on every reconcile tick even
  // with active autonomy off, so the dashboard's head card stays current.
  async refreshHeadMetrics(orchId: string): Promise<void> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch?.head?.sessionId) return;
    const events = await this.deps.readTranscript(orch.head.sessionId);
    const tm = metricsFromTranscript(events);
    await this.deps.store.updateHead(orchId, (h) => {
      h.metrics.inputTokens = tm.inputTokens;
      h.metrics.outputTokens = tm.outputTokens;
      h.metrics.cacheReadTokens = tm.cacheReadTokens;
      h.metrics.cacheCreationTokens = tm.cacheCreationTokens;
      h.metrics.turns = tm.turns;
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
