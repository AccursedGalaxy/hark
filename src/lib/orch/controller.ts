import {
  BLOCKED_MARKER,
  DONE_MARKER,
  HANDOFF_MARKER,
} from "./roles.js";
import type { OrchStore } from "./store.js";
import type { Orchestrator } from "./orchestrator.js";
import {
  DEFAULT_AUTONOMY_LEVEL,
  isTerminalLifecycle,
  type AgentLifecycle,
  type AgentMetrics,
  type AgentRole,
  type AutonomyLevel,
  type BreakerState,
  type ContentBlock,
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
  return { kind: best.kind, summary: leanSummary(before) };
}

// Trailing few non-empty lines of a block — the lean, head-facing summary kept
// small for the head's context budget. Reused to trim the persisted full marker
// text back down when building a head notification from it.
export function leanSummary(text: string, maxLines = 8): string {
  const lines = text.split("\n").map((l) => l.trim());
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < maxLines; i--) {
    if (lines[i].length > 0) tail.unshift(lines[i]);
    else if (tail.length > 0) break; // stop at the first blank above the block
  }
  return tail.join("\n");
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

// The worker's FULL final message with the marker tokens stripped — the
// untruncated deliverable persisted on the record (`hark agent summary`). The
// marker always lands in the last assistant turn, so the final message text IS
// the agent's "what changed / why blocked" prose. Distinct from scanMarkers'
// lean `summary`, which is deliberately truncated for the head notification.
export function finalMarkerText(events: TranscriptEvent[]): string {
  let text = "";
  for (const e of events) {
    if (e.kind !== "assistant") continue;
    const parts: string[] = [];
    for (const b of e.blocks) {
      if (b.type === "text") parts.push(b.text);
    }
    if (parts.length > 0) text = parts.join("\n");
  }
  for (const m of MARKERS) text = text.split(m.token).join("");
  return text.trim();
}

// ---- Runaway circuit-breaker ------------------------------------------------

// A worker that lost confidence its tools ran has been observed spiralling into
// repeated identical no-op probe commands (recover-check-N / retry-burst-N),
// never reaching a terminal state and burning 1M+ tokens until a human kills
// it. The breaker watches each worker's transcript and trips when it issues a
// run of identical tool calls WITHOUT advancing its branch (no new commits, no
// diff change). Tripping flips the worker to `blocked` with a reason; the
// reconcile loop's existing terminal-reap then SIGTERMs it. A worker that IS
// progressing — its commit count or diffstat moves — resets the window and
// never trips, even if it repeats a command.

// Default run length that trips the breaker. Five identical no-progress calls
// in a row is well past any legitimate retry (a real retry loop changes
// something between attempts, which breaks the identical run) while leaving
// headroom against a twitchy false positive.
export const DEFAULT_RUNAWAY_LIMIT = 5;

// Normalise a tool call into a signature for the "identical command" test.
// Runs of digits collapse to `#` so a counter-incrementing probe
// (`recover-check-1`, `recover-check-2`, …) reads as one repeated command.
// Returns null for non-tool blocks (text/thinking).
export function toolUseSignature(block: ContentBlock): string | null {
  if (block.type !== "tool_use") return null;
  const norm = (s: string) =>
    s.trim().replace(/\s+/g, " ").replace(/\d+/g, "#");
  if (block.name === "Bash") {
    const cmd = (block.input as { command?: unknown } | null)?.command;
    if (typeof cmd === "string") return `bash:${norm(cmd)}`;
  }
  // Any other tool: name + a normalised view of its input, so a differing tool
  // call (an Edit landed between two probes) breaks the identical run.
  let input = "";
  try {
    input = norm(JSON.stringify(block.input ?? ""));
  } catch {
    /* unserialisable input — the tool name alone still distinguishes it */
  }
  return `${block.name}:${input}`;
}

// The ordered signatures of every tool call in the transcript, oldest→newest.
export function toolUseSignatures(events: TranscriptEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind !== "assistant") continue;
    for (const b of e.blocks) {
      const sig = toolUseSignature(b);
      if (sig) out.push(sig);
    }
  }
  return out;
}

// Length of the trailing run of the SAME signature at the end of the list.
// `{ signature: null, count: 0 }` when there are no tool calls.
export function trailingRepeat(signatures: string[]): {
  signature: string | null;
  count: number;
} {
  if (signatures.length === 0) return { signature: null, count: 0 };
  const signature = signatures[signatures.length - 1];
  let count = 0;
  for (
    let i = signatures.length - 1;
    i >= 0 && signatures[i] === signature;
    i--
  ) {
    count++;
  }
  return { signature, count };
}

export interface BreakerInput {
  // Trailing identical-run signature + length from the transcript.
  signature: string | null;
  repeatCount: number;
  // Key that changes whenever the worker advances its branch: commitCount +
  // committed diffstat. A run spent making progress moves this; a no-op spiral
  // leaves it frozen.
  progressKey: string;
  // The snapshot persisted from the previous observation (agent.breaker).
  prior?: BreakerState;
  limit: number;
}

export interface BreakerDecision {
  tripped: boolean;
  reason?: string;
  // Always returned — persisted onto the agent so the next tick measures
  // against it.
  snapshot: BreakerState;
}

// Pure breaker policy. The window of "consecutive no-progress repeats" opens
// fresh whenever the repeated command changes OR progress advances; inside an
// open window we count repeats beyond the baseline captured when it opened.
// Deliberately conservative: the first observation of any window never trips
// (baseline == repeatCount), so a worker already mid-run when we start watching
// gets a clean window first — and a worker that advances its branch resets the
// window every time, so genuine progress can never trip even while repeating.
export function decideCircuitBreaker(input: BreakerInput): BreakerDecision {
  const { signature, repeatCount, progressKey, prior, limit } = input;
  if (!signature) {
    return {
      tripped: false,
      snapshot: { signature: "", progressKey, baseline: 0 },
    };
  }
  const windowReset =
    !prior ||
    prior.signature !== signature ||
    prior.progressKey !== progressKey;
  const baseline = windowReset ? repeatCount : prior.baseline;
  const snapshot: BreakerState = { signature, progressKey, baseline };
  const streak = repeatCount - baseline;
  if (streak >= limit) {
    return {
      tripped: true,
      reason: `circuit-breaker: ${repeatCount} consecutive identical no-op commands with no new commits or diff (\`${truncateSignature(signature)}\`)`,
      snapshot,
    };
  }
  return { tripped: false, snapshot };
}

function truncateSignature(sig: string, max = 60): string {
  return sig.length <= max ? sig : `${sig.slice(0, max - 1)}…`;
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
  // The FULL marker text to persist on the record when this turn drives a
  // terminal/handoff transition (untruncated; see finalMarkerText). Empty when
  // there's no marker.
  fullSummary: string;
  // Self-review nudges already sent this run.
  nudges: number;
  maxNudges: number;
}

export type AutonomyAction =
  | { type: "deliver_briefing" }
  | {
      type: "set_lifecycle";
      lifecycle: AgentLifecycle;
      reason?: string;
      // FULL marker text to persist on the record (hark agent summary).
      summary?: string;
    }
  | { type: "nudge" }
  | { type: "none" };

const TERMINAL: AgentLifecycle[] = ["done", "failed", "stopped", "cancelled"];

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
      return { type: "set_lifecycle", lifecycle: "done", summary: s.fullSummary };
    case "blocked":
      return {
        type: "set_lifecycle",
        lifecycle: "blocked",
        reason: s.scan.summary || "agent reported it is blocked",
        summary: s.fullSummary,
      };
    case "handoff":
      return {
        type: "set_lifecycle",
        lifecycle: "review",
        reason: s.scan.summary,
        summary: s.fullSummary,
      };
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

// Map a terminal lifecycle to the head-notification marker that drives routing
// (blocked → escalate to the human; done → advance the pipeline). `failed` is a
// needs-you event like `blocked`; `stopped` was a deliberate halt, so it routes
// like `done` (re-plan / advance). `cancelled` is a teardown — null means "don't
// wake" (the worktree is being removed anyway).
export function markerForLifecycle(
  lifecycle: AgentLifecycle,
): MarkerKind | null {
  switch (lifecycle) {
    case "blocked":
    case "failed":
      return "blocked";
    case "done":
    case "stopped":
      return "done";
    default:
      return null;
  }
}

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
  // Consecutive identical no-op commands that trip the runaway breaker.
  // Defaults to DEFAULT_RUNAWAY_LIMIT.
  runawayLimit?: number;
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
    let fullSummary = "";
    if (agent.sessionId) {
      const events = await this.deps.readTranscript(agent.sessionId);
      scan = scanMarkers(transcriptText(events));
      if (scan.kind) fullSummary = finalMarkerText(events);
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
      fullSummary,
      nudges,
      maxNudges: this.deps.maxNudges ?? DEFAULT_MAX_NUDGES,
    });

    await this.perform(orch.id, agent, action);

    // Head-session model: when a worker actually TRANSITIONS to a state the
    // head must act on, notify the head. Gated on a real transition so the
    // reconcile tick can't spam every 3s while an agent sits in place.
    if (
      action.type === "set_lifecycle" &&
      action.lifecycle !== prevLifecycle &&
      orch.head
    ) {
      if (isTerminalLifecycle(action.lifecycle)) {
        // Terminal (done/blocked): route through the fire-once wake so the head
        // is woken exactly once whether the transition is seen here (marker) or
        // by the reconcile loop — robust to the marker-vs-reconcile race.
        await this.wakeHeadForTerminal(orch.id, agent.id);
      } else if (action.lifecycle === "review") {
        // Handoff → review is NOT terminal (the work is awaiting review, not
        // finished), so it keeps the immediate transition-guarded notification.
        const note = await this.notifyHead(orch, agent, "handoff", scan.summary);
        if (orch.managed && note) {
          await this.routeManagedHead(orch, agent, note);
        }
      }
    }

    return action;
  }

  // Wake the head exactly once for a worker that has reached a terminal
  // lifecycle (done/blocked/failed/stopped). This is the single guaranteed
  // wake-up: it fires whether the terminal transition was detected via the
  // worker's marker (onAgentSignal, immediately) or via the reconcile loop (a
  // stop / circuit-breaker trip / failure that never emitted a marker). The
  // `headWokeAt` guard — mirroring `killedAt` — makes the double-cover idempotent
  // so the head is never woken twice nor missed. Builds the notification from
  // the PERSISTED summary (trimmed lean), so it works even after the live
  // session is gone. Best-effort: a routing failure leaves the guard set (it has
  // been "woken" as far as the once-guarantee is concerned) and is swallowed.
  async wakeHeadForTerminal(orchId: string, agentId: string): Promise<void> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch?.head) return;
    const agent = orch.agents.find((a) => a.id === agentId);
    if (!agent || agent.headWokeAt != null) return;
    if (!isTerminalLifecycle(agent.lifecycle)) return;
    const marker = markerForLifecycle(agent.lifecycle);
    if (!marker) return; // cancelled (teardown) — nothing to wake for.

    // Fire-once guard set up front so a re-entrant reconcile tick can't double.
    await this.deps.store.updateAgent(orchId, agentId, (a) => {
      a.headWokeAt = this.now();
    });
    try {
      const note = await this.notifyHead(
        orch,
        agent,
        marker,
        leanSummary(agent.summary ?? ""),
      );
      if (orch.managed && note) {
        await this.routeManagedHead(orch, agent, note);
      }
    } catch {
      /* best-effort — the guard is set; the record carries the summary/reason */
    }
  }

  // Runaway circuit-breaker: trip a worker that's spiralling on identical no-op
  // commands without advancing its branch. Called on every reconcile tick for a
  // running worker, INDEPENDENT of the autonomy dial — a spiral burns tokens
  // regardless of whether hark is actively driving the team, so the harness
  // must self-defend either way. Reads only the transcript + a git progress
  // summary; on a trip it flips the worker to `blocked` with a reason (the
  // reconcile loop's terminal-reap then SIGTERMs it — termination is not
  // re-implemented here). Returns whether the breaker tripped this tick.
  async checkCircuitBreaker(orchId: string, agentId: string): Promise<boolean> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch) return false;
    const agent = orch.agents.find((a) => a.id === agentId);
    // Only an actively-running worker can be a runaway. A terminal/blocked/
    // pending agent isn't spiralling, and one already reaped (killedAt) is done.
    if (
      !agent ||
      agent.lifecycle !== "running" ||
      agent.killedAt != null ||
      !agent.sessionId
    ) {
      return false;
    }

    const events = await this.deps.readTranscript(agent.sessionId);
    const { signature, count } = trailingRepeat(toolUseSignatures(events));

    // Progress signal: a worker advancing its branch moves commit count / diff.
    // Best-effort — if it can't be computed the window simply won't reset on
    // progress, and the identical-run requirement alone still guards a trip.
    let progressKey = "";
    if (this.deps.agentGitSummary) {
      try {
        const s = await this.deps.agentGitSummary(orch, agent);
        progressKey = `${s.commitCount}:${s.diffstat}`;
      } catch {
        /* best-effort */
      }
    }

    const decision = decideCircuitBreaker({
      signature,
      repeatCount: count,
      progressKey,
      prior: agent.breaker,
      limit: this.deps.runawayLimit ?? DEFAULT_RUNAWAY_LIMIT,
    });

    // Persist the snapshot every tick so the next observation measures the run
    // against this window.
    await this.deps.store.updateAgent(orchId, agentId, (a) => {
      a.breaker = decision.snapshot;
    });

    if (!decision.tripped) return false;

    const reason = decision.reason ?? "circuit-breaker tripped";
    // setAgentLifecycle records the reason on the worker record (blockedReason)
    // + an agent_lifecycle event, so the PM sees WHY in `orch status`. The
    // breaker has no marker text, so the reason IS the persisted summary
    // (retrievable via `hark agent summary`).
    await this.deps.store.setAgentLifecycle(orchId, agentId, "blocked", {
      reason,
      summary: reason,
    });
    await this.deps.store.appendEvent({
      ts: this.now(),
      orchestrationId: orchId,
      agentId,
      kind: "failure",
      message: reason,
      data: { kind: "circuit_breaker" },
    });
    // A runaway is a needs-you event: page the human through the same path a
    // worker BLOCKED marker uses, so the PM-head learns WHY it stopped (the
    // reason is also on the record regardless). Best-effort. This escalation IS
    // this worker's head-wake, so set the `headWokeAt` guard to keep the
    // reconcile loop's generic wake-up from escalating the same trip twice.
    await this.deps.store.updateAgent(orchId, agentId, (a) => {
      a.headWokeAt = this.now();
    });
    if (orch.head && this.deps.escalateToHuman) {
      try {
        await this.deps.escalateToHuman(orch, agent, reason);
      } catch {
        /* best-effort — the record + event already carry the reason */
      }
    }
    return true;
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
    marker: MarkerKind,
    summary: string,
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
      marker,
      summary,
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
      message: `head notified: ${agent.role} → ${marker}`,
      data: { marker, pushed: !orch.managed },
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
