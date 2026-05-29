// Single source of truth for the hark wire protocol.
//
// Both the Express host (src/) and the React app (web/src/) import from this
// file. Anything that crosses the HTTP/SSE seam — request shapes, response
// shapes, hook payloads, pure derivations — lives here. Server-internal
// helpers (parsers, filesystem readers) stay in their own modules.
//
// Web reaches this file via the wrapper at web/src/lib/protocol.ts, which is
// a pure re-export. Don't redeclare types here on either side.

// ---- Sessions ----

// Known values Claude Code writes into `~/.claude/sessions/<pid>.json`:
//   - "busy"    — model is generating
//   - "idle"    — turn over, awaiting user input
//   - "waiting" — blocked on an in-TUI prompt (permission, AskUserQuestion,
//                 ExitPlanMode, trust dialog). Newer than the busy/idle pair
//                 and accompanied by a `waitingFor` string hint.
export type SessionStatus = "busy" | "idle" | "waiting" | string;
// "pending" = a `claude` process running in a tmux pane but not yet
// registered with Claude Code (usually blocked on the trust dialog).
// Synthesized by the server so the user can drive it from the rail.
export type SessionKind = "interactive" | "bg" | "pending" | string;

export interface PendingPermission {
  toolName: string;
  toolInput: unknown;
  requestedAt: number;
}

// ---- AskUserQuestion schema (Tier 0.2) ----
//
// Mirrors the `AskUserQuestion` tool input the model writes when it wants a
// structured clarification. Each call carries 1–4 questions; each question
// 2–4 options. Anthropic auto-injects an "Other" affordance in the TUI.
export interface AskQuestionOption {
  label: string;
  description?: string;
  // Optional inline preview (markdown). Rendered next to the label so the
  // user can compare options visually instead of guessing from labels alone.
  preview?: string;
}
export interface AskQuestion {
  question: string;
  // Short chip-style label (~12 chars) the TUI shows above the question.
  header?: string;
  options: AskQuestionOption[];
  multiSelect?: boolean;
}

// ---- ExitPlanMode (Tier 0.3) ----
//
// `tool_input.plan` is a markdown string the user judges before continuing.
export interface PlanModeInput {
  plan: string;
}

// ---- MCP elicitation (Tier 0.4) ----
//
// Fields the server asks the user to fill in. Type maps loosely to JSON
// Schema primitives; renderer degrades to a plain text field on unknown.
export type ElicitationFieldType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | string;
export interface ElicitationField {
  name: string;
  type: ElicitationFieldType;
  required?: boolean;
  // For `enum` fields. Renderer treats as <select>.
  options?: string[];
  // Optional display hint pulled from the schema's `description`.
  description?: string;
}

// ---- StopFailure (Tier 1.2) ----
//
// Documented `error_type` values as of 2026 — kept open with `string` so
// future categories don't silently drop.
export type StopErrorType =
  | "rate_limit"
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "billing_error"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "max_output_tokens"
  | "unknown"
  | string;
export interface SessionError {
  errorType: StopErrorType;
  errorMessage: string;
  occurredAt: number;
}

// ---- Subagent activity (Tier 1.3) ----
export interface SubagentInfo {
  agentId: string;
  agentType: string;
  startedAt: number;
}

// ---- Discriminated "blocked on user" union ----
//
// Replaces the single `pendingPermission` field. Every Tier-0 state is one
// `Pending` variant; the frontend switches on `kind` to render the right UI.
// We still expose `pendingPermission` on the wire for back-compat (existing
// clients) — the union is the new authoritative field.
export type Pending =
  | {
      kind: "tool_permission";
      toolName: string;
      toolInput: unknown;
      toolUseId?: string;
      requestedAt: number;
    }
  | {
      kind: "ask_user_question";
      questions: AskQuestion[];
      toolUseId?: string;
      requestedAt: number;
    }
  | {
      kind: "exit_plan_mode";
      plan: string;
      toolUseId?: string;
      requestedAt: number;
    }
  | {
      kind: "elicitation";
      serverName: string;
      message?: string;
      fields: ElicitationField[];
      requestedAt: number;
    }
  | {
      kind: "oauth";
      message: string;
      requestedAt: number;
    };

export interface RawSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  version: string;
  kind: SessionKind;
  status?: SessionStatus;
  name?: string;
  hasTmuxPane: boolean;
  // Compact tmux location for the session's pane (e.g., "dev:2"), or null
  // when the session has no pane. Used to distinguish sibling sessions in
  // the same cwd that would otherwise share a label.
  tmuxLocation?: string | null;
  tmuxWindowName?: string | null;
  needsAttention?: boolean;
  lastEvent?: string;
  lastEventAt?: number;
  lastEventMessage?: string;
  notificationType?: string;
  pendingPermission?: PendingPermission;
  // Discriminated "blocked on user" state — superset of pendingPermission.
  pending?: Pending;
  // StopFailure metadata if the last turn ended with an error.
  lastError?: SessionError;
  // Live subagents on this session (populated by Subagent{Start,Stop} hooks).
  subagents?: SubagentInfo[];
  // Free-text hint Claude Code writes alongside `status: "waiting"` (e.g.
  // "permission prompt", "ask user question", "trust prompt"). Carried so the
  // header can show *what* the session is blocked on even before the matching
  // hook arrives.
  waitingFor?: string;
  // Stable identifier of the project this session belongs to (the absolute
  // path of the containing git repo root). `null` when the session's cwd
  // isn't inside any repo — capture is disabled for those.
  projectKey?: string | null;
}

// ---- Projects ----
//
// A project is the git repo containing a session's cwd. Hark derives this
// per-session via `git rev-parse --show-toplevel`. The key is the absolute
// path of the repo root — stable across sessions, URL-encoded in routes.
// `name` is the basename, used purely for display.
export interface ProjectInfo {
  key: string;
  root: string;
  name: string;
  // Whether PLAN.md exists on disk yet. Bootstrap writes the skeleton on
  // first capture / first install — until then this is false and the rail
  // can show a "set up" affordance.
  planExists: boolean;
  // PLAN.md mtime in ms, or null when the file doesn't exist. The rail
  // refetches when this advances so other sessions' updates surface.
  planMtime: number | null;
}

// Captures live as appended lines in PLAN.md's Inbox section. The wire
// shape is intentionally trivial — the doc itself owns the formatting.
export interface CaptureRequest {
  text: string;
}

// Derived UI state. The backend's raw `status` plus the hook attention layer
// collapse into one of these four. Done here so components don't repeat logic.
export type SessionState = "wait" | "busy" | "idle" | "dead";

export function deriveState(s: RawSession): SessionState {
  // The server only lists sessions whose PID is alive, so any session that
  // reaches this derivation is by definition not dead. We still keep "dead"
  // in the union for synthesized/legacy cases, but the live-status branches
  // below must cover every known and unknown status value Claude Code writes,
  // including the newer "waiting" (introduced around 2.1.x) — otherwise the
  // header flashes OFFLINE while Claude is actively blocked on the user.
  if (s.needsAttention) return "wait";
  if (s.status === "busy") return "busy";
  // `status="waiting"` alone is not enough: Claude Code writes it when a
  // prompt opens, but if the user answers directly in the TUI the field can
  // sit stale on disk. Require an actual pending payload from the attention
  // layer before showing the ASKING pill — otherwise the rail gets stuck.
  if (s.status === "waiting" && (s.pending || s.pendingPermission)) return "wait";
  if (typeof s.status === "string") return "idle";
  return "dead";
}

export const STATE_LABEL: Record<SessionState, string> = {
  wait: "needs you",
  busy: "live",
  idle: "idle",
  dead: "idle",
};

// ---- Orchestration ----
//
// An orchestration is a named mission against one project (git repo), worked
// by a set of role-playing agents. Each agent is an ordinary Claude Code
// session driven via tmux (the unchanged interaction model), but pinned to its
// own isolated git worktree + branch so agents never collide on the working
// tree. These shapes cross the HTTP/SSE seam to the orchestration UI; the
// charters/briefings that *drive* the roles live server-side in lib/orch.

export type AgentRole =
  | "researcher"
  | "coder"
  | "tester"
  | "documenter"
  | "reviewer";

// Canonical role order — the default full team, and the spawn-form options.
export const AGENT_ROLES: AgentRole[] = [
  "researcher",
  "coder",
  "tester",
  "documenter",
  "reviewer",
];

// Where an agent is in its lifecycle. Distinct from a session's live/idle
// status: this tracks the agent's progress through the orchestration, derived
// from worktree/spawn steps + the autonomy markers it prints.
export type AgentLifecycle =
  | "pending" // record created, worktree not yet made
  | "spawning" // worktree ready, tmux session launching
  | "running" // actively working toward its definition of done
  | "blocked" // printed BLOCKED — needs a human decision
  | "review" // work handed off, awaiting review
  | "done" // printed DONE and self-reviewed
  | "failed" // errored or abandoned
  | "cancelled"; // stopped by the user

// Per-agent metrics, accumulated from the transcript (tokens/cost) and the
// lifecycle timeline (autonomy time, interventions). The "document everything"
// half of the brief — these power the orchestration dashboard.
export interface AgentMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  // Wall-clock the agent has spent running autonomously (ms), excluding time
  // spent blocked on a human.
  autonomyMs: number;
  // How many times a human had to step in (blocked → resumed).
  interventions: number;
  // Assistant turns taken.
  turns: number;
}

// Persisted state for the runaway circuit-breaker. The breaker (in the
// autonomy controller) trips when a worker repeats an identical no-op command
// `limit` times without advancing its branch; this snapshot is what lets a 3s
// reconcile tick measure new repeats against the window that's already open.
export interface BreakerState {
  // Digit-normalised signature of the command currently being repeated (so a
  // counter-suffixed probe like `recover-check-1`/`recover-check-2` collapses
  // to one signature).
  signature: string;
  // commitCount + diffstat at the time the current no-progress window opened.
  // The breaker resets its window whenever this changes — that's a worker
  // making progress, which must never trip.
  progressKey: string;
  // Trailing-repeat count captured when the window opened; repeats beyond this
  // (signature + progressKey unchanged) are what trip the breaker.
  baseline: number;
}

export function emptyAgentMetrics(): AgentMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    autonomyMs: 0,
    interventions: 0,
    turns: 0,
  };
}

export interface OrchAgent {
  id: string;
  orchestrationId: string;
  role: AgentRole;
  // Isolated branch + worktree directory this agent owns.
  branch: string;
  worktreeDir: string;
  // Claude Code session id once the spawned process registers itself; null
  // until then. PID is captured at spawn so the agent can be correlated to its
  // session/pane even before the session id exists.
  sessionId: string | null;
  pid: number | null;
  lifecycle: AgentLifecycle;
  createdAt: number;
  updatedAt: number;
  // When the role briefing was delivered to the session (the autonomy
  // controller sends it once the session is past its trust prompt). Undefined
  // until then; its presence is how the controller avoids re-briefing.
  briefedAt?: number;
  // When the worker's session process was SIGTERM'd after its lifecycle went
  // terminal (done/blocked/failed). Guards the reconcile loop from re-signalling
  // an already-killed worker every tick. The worktree + branch are kept.
  killedAt?: number;
  // Set when lifecycle is "blocked" — the question the agent is waiting on.
  blockedReason?: string;
  // Runaway circuit-breaker bookkeeping (see decideCircuitBreaker). Persisted
  // across reconcile ticks so the breaker tells a fresh repeat from one it has
  // already counted, and resets its window the moment the worker advances its
  // branch. Undefined until the breaker first observes a tool call.
  breaker?: BreakerState;
  // The specific task the head dispatched this worker (head-session model).
  // Undefined for legacy cold-team agents (their charter is the whole goal).
  // Threaded into the briefing so the worker knows what slice it owns.
  task?: string;
  // Id of an upstream agent this worker's work derives from. Reserved for the
  // handoff-time worktree derivation (PLAN inbox item); carried here so the
  // head can express dependencies at spawn time.
  dependsOn?: string;
  metrics: AgentMetrics;
}

// The head (foreman) of an orchestration in the head-session model: one Claude
// Code session, in its own worktree, that decomposes the goal, spawns workers
// on demand, harvests their branches, and talks to the user in natural
// language. It is NOT an entry in `agents[]` — living on Orchestration.head
// directly is what keeps it exempt from the worker nudge loop (which iterates
// `agents[]`) and makes its markers orchestration-scoped, not agent-scoped.
//
// Optional on Orchestration so legacy "headless" records (created before the
// head model, or by the back-compat createTeam path) keep working unchanged —
// every consumer guards on `head` being present.
export interface OrchHead {
  // Claude Code session id once the head process registers (past its trust
  // prompt); null until then. PID is captured at spawn for correlation.
  sessionId: string | null;
  pid: number | null;
  // The head's own isolated worktree (clean tree for git/gh; reads every
  // worker branch via the shared object store) and the branch checked out.
  worktreeDir: string;
  branch: string;
  // When the head briefing was delivered (the bootstrap message). Undefined
  // until then; its presence is how the controller avoids re-briefing.
  briefedAt?: number;
  // The head accrues real coordination cost and is metered like a worker
  // (Sharp Edge 8) so it's visible, not hidden.
  metrics: AgentMetrics;
}

export type OrchestrationStatus =
  | "active"
  | "completed"
  | "archived"
  | "failed";

// The per-project autonomy dial (PM-head harness, spec §3.6). Governs the idle
// loop only — how far the head advances the pipeline on its own while you're
// quiet. The human always sets the dial, owns every landing, and is paged for
// blockers regardless of level.
//   L0 Propose         — only suggests plans/diffs; you dispatch & apply all.
//   L1 Assisted        — dispatches on your approval; advances on your nod.
//   L2 Supervised-auto — when idle, autonomously advances (done→next, spawn
//                        tester, open PR); escalates blockers, never lands.
//   L3 Background      — runs whole features end-to-end while you're away.
export type AutonomyLevel = "L0" | "L1" | "L2" | "L3";
export const AUTONOMY_LEVELS: AutonomyLevel[] = ["L0", "L1", "L2", "L3"];
// Proposed default (spec §8 decision): supervised-auto.
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "L2";
export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  L0: "Propose",
  L1: "Assisted",
  L2: "Supervised-auto",
  L3: "Background",
};

export interface Orchestration {
  id: string;
  name: string;
  goal: string;
  // Absolute repo root (matches ProjectInfo.key) and its display basename.
  projectRoot: string;
  projectName: string;
  // Ref agents branch from (e.g. "main" or a feature branch).
  baseRef: string;
  status: OrchestrationStatus;
  createdAt: number;
  updatedAt: number;
  agents: OrchAgent[];
  // The coordinating head session (head-session model). Undefined for legacy
  // headless records — consumers guard on its presence.
  head?: OrchHead;
  // PM-head harness (spec): true when this is a persistent, project-scoped
  // PM-head promoted from an existing session (the head's worktreeDir is the
  // project root itself, observed read-only), rather than a task-scoped
  // executor head spawned in an isolated worktree. The per-project autonomy
  // dial lives here; absent → DEFAULT_AUTONOMY_LEVEL.
  managed?: boolean;
  autonomyLevel?: AutonomyLevel;
  // High-water timestamp (ms) of the newsroom delta the managed head has
  // already been shown (via the UserPromptSubmit injection). Advanced each turn
  // so the head pulls only what's new. Initialized to the promotion time so a
  // fresh head isn't flooded with pre-promotion history.
  newsCursor?: number;
  // Last time the human submitted a prompt to the managed head (ms). Drives the
  // idle-loop mode decision (§3.5): a worker transition routes to pull while
  // the conversation is active, and to an autonomous advance-push once the
  // human has been quiet past the idle threshold. Initialized to promotion time.
  lastHumanAt?: number;
}

// Append-only event log entry. Decisions, checkpoints, blocks, handoffs,
// failures, and metric snapshots all flow through one ordered JSONL stream per
// orchestration — the session log / audit trail the brief asks for.
export type OrchEventKind =
  | "orchestration_created"
  | "orchestration_status"
  | "agent_spawned"
  | "agent_lifecycle"
  // Head-session model: the head session was spawned for an orchestration.
  | "head_spawned"
  // A worker marker was forwarded to the head as an inbound notification.
  | "head_notified"
  | "decision"
  | "checkpoint"
  | "blocked"
  | "handoff"
  | "failure"
  | "metric"
  | "note";

export interface OrchEvent {
  ts: number;
  orchestrationId: string;
  agentId?: string;
  kind: OrchEventKind;
  message: string;
  // Arbitrary structured payload (e.g. a metric delta, a decision's options).
  data?: unknown;
}

// Orchestration-level roll-up (computed by summarizeOrchestration), embedded
// in the list/detail responses so the dashboard renders metrics without
// re-aggregating client-side.
export interface OrchestrationSummary {
  agentCount: number;
  byLifecycle: Record<AgentLifecycle, number>;
  // done / (done + failed); null until an agent reaches a terminal verdict.
  successRate: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalTurns: number;
  totalInterventions: number;
  totalAutonomyMs: number;
}

// ---- Head-session CLI status view (GET /orchestrations/:id/status) ----
//
// The lean, one-line-per-agent shape the `hark orch status` command renders.
// Deliberately compact (context discipline — the head works from summaries,
// never transcripts): no transcripts, diffstat as a short string, the last
// marker summary truncated. Computed server-side so the CLI stays a thin
// formatter.
export interface AgentStatusLine {
  id: string;
  role: AgentRole;
  lifecycle: AgentLifecycle;
  branch: string;
  // Compact `git diff --shortstat base...branch`, e.g. "2 files +30/-4", or ""
  // when there's nothing committed yet / the diff couldn't be computed.
  diffstat: string;
  turns: number;
  tokens: number;
  task?: string;
  // Why a worker stopped, when it carries one — currently the `blocked` reason
  // (a human question or a tripped circuit-breaker). Surfaced so `orch status`
  // tells the PM WHY without a separate lookup.
  reason?: string;
}

export interface HeadStatusLine {
  branch: string;
  sessionId: string | null;
  briefed: boolean;
  turns: number;
  tokens: number;
}

export interface OrchStatusView {
  id: string;
  name: string;
  goal: string;
  status: OrchestrationStatus;
  head?: HeadStatusLine;
  agents: AgentStatusLine[];
}

// ---- Transcript events (exactly what /api/sessions/:id/transcript returns) ----

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

// Per-message token accounting Claude Code persists on every assistant row.
// Drives the context-rail meter, cost estimates, and cache-hit ratio.
// All counts are non-negative integers. Fields not reported by older Claude
// Code versions default to 0 so consumers can sum without nullish checks.
export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
}

// Typed view of the raw `toolUseResult` field Claude Code writes alongside
// each tool_result entry. Only tools whose structure pays off in rendering get
// a dedicated shape; everything else falls through as `raw` so nothing is
// silently dropped. Add new kinds as they become useful — the consumer is
// expected to handle `raw` as a graceful default.
export type ToolResultMeta =
  | {
      kind: "read";
      filePath: string;
      numLines: number;
      totalLines: number;
      startLine: number;
    }
  | {
      kind: "bash";
      stderr: string;
      interrupted: boolean;
      backgroundTaskId?: string;
      returnCodeInterpretation?: string;
    }
  | {
      kind: "edit";
      filePath: string;
      replaceAll: boolean;
      userModified: boolean;
      structuredPatch?: unknown;
    }
  | {
      kind: "write";
      filePath: string;
      // "create" for new files, "update" for overwrites. Other values pass
      // through as-is; this is what Claude Code actually emits.
      type: string;
      userModified: boolean;
      structuredPatch?: unknown;
    }
  | {
      kind: "glob";
      numFiles: number;
      truncated: boolean;
      durationMs: number;
      // First N filenames — Claude Code already truncates server-side when
      // there are too many. Treat as a preview list, not authoritative.
      filenames: string[];
    }
  | {
      kind: "webfetch";
      url: string;
      code: number;
      codeText: string;
      bytes: number;
      durationMs: number;
    }
  | {
      kind: "websearch";
      query: string;
      searchCount: number;
      durationSeconds: number;
      resultCount: number;
    }
  // Fallback for tools we haven't typed (MCP tools, Agent, Task*, Skill, etc.)
  // and for the string error shapes most tools degrade to on failure.
  | { kind: "raw"; data: unknown };

export interface ToolResultEvent {
  kind: "tool_result";
  uuid: string;
  ts: string;
  toolUseId: string;
  // Resolved by walking the stream and matching `toolUseId` against a prior
  // assistant `tool_use` block. Undefined when the matching tool_use isn't
  // in scope (e.g. an SSE consumer that started watching after the use was
  // written) — renderers should degrade gracefully.
  toolName?: string;
  output: string;
  isError: boolean;
  // Typed view of the raw `toolUseResult` field. Undefined when the raw
  // entry didn't have one (older Claude Code, errors that don't produce
  // structured output). See `extractToolMeta` in src/lib/transcript.ts.
  meta?: ToolResultMeta;
}

export interface AssistantEvent {
  kind: "assistant";
  uuid: string;
  ts: string;
  blocks: ContentBlock[];
  // Model id Claude Code recorded for this turn (e.g. "claude-opus-4-7").
  // Sessions can switch models mid-conversation, so this is per-message.
  model?: string;
  // Token accounting. Undefined for synthetic/error rows that never reached
  // the API; otherwise always present (zeroed fields are fine to display).
  usage?: MessageUsage;
  // Anthropic stop_reason: "tool_use" | "end_turn" | "max_tokens" |
  // "stop_sequence" | "pause_turn" | string (kept open for future values).
  stopReason?: string;
  // Set when Claude Code marks the row as an API failure (rate limit,
  // auth, server error). Pairs with `apiErrorStatus` on the raw row.
  isApiError?: boolean;
  // 1-indexed retry attempt for transient failures. Undefined on the
  // primary attempt.
  retryAttempt?: number;
}

export type TranscriptEvent =
  | { kind: "user"; uuid: string; ts: string; text: string }
  | AssistantEvent
  | ToolResultEvent
  | { kind: "system"; uuid: string; ts: string; text: string };

/**
 * Index tool_result events by their `toolUseId` so a renderer can fuse each
 * `tool_use` block with its result inline.
 */
export function indexToolResults(
  events: TranscriptEvent[],
): Map<string, ToolResultEvent> {
  const out = new Map<string, ToolResultEvent>();
  for (const ev of events) {
    if (ev.kind === "tool_result") out.set(ev.toolUseId, ev);
  }
  return out;
}

// ---- Attention (from /api/events SSE) ----

// What kind of input Claude Code is waiting for. Drives Composer UI:
// "permission" shows Approve/Deny; "elicitation" shows just the keypad;
// "idle" lets the user type freely; null means not waiting on the user.
// Map per docs/interactions.md — informational types collapse to null.
//
// Note: this is the *coarse* kind for back-compat. The fine-grained shape
// lives on `pending` (discriminated union) and supersedes it for new
// renderers. `permission` here covers ALL Pending variants except `idle`,
// so legacy code that only branches on `promptKind` still behaves.
export type PromptKind = "permission" | "elicitation" | "idle" | null;

// Per-session attention state, exactly as recorded by PromptState on the
// server. The snapshot endpoint and the streamed hook events both carry
// this shape; clients consume it verbatim.
//
// `promptKind` is the server's verdict on what Claude is waiting for —
// derived from the hook stream + transcript growth + send-keys signals.
// Clients render it directly; they no longer derive their own answer.
export interface AttentionInfo {
  needsAttention: boolean;
  lastEvent: string;
  lastEventAt: number;
  message?: string;
  notificationType?: string;
  // Legacy field: present only when `pending.kind === "tool_permission"`,
  // mirrored from `pending` for back-compat. New clients should read
  // `pending` directly.
  pendingPermission?: PendingPermission;
  // Authoritative "what is Claude waiting for" — discriminated by `kind`.
  // Absent when nothing is pending (idle or just status notifications).
  pending?: Pending;
  promptKind: PromptKind;
  // Most recent StopFailure on this session, if any. Cleared when the user
  // takes any action (send, clear-attention) or the session goes idle.
  lastError?: SessionError;
  // Currently-running subagents on this session, indexed by id.
  subagents?: SubagentInfo[];
  // Cached working directory — updated by CwdChanged hooks so the header
  // reflects the live cwd without round-tripping `claude --info`.
  cwd?: string;
}

export interface HookBroadcast extends AttentionInfo {
  sessionId: string;
}

// Pure derivation from AttentionInfo's hook-shaped fields. Server-side
// PromptState calls this once per state mutation so the wire field stays
// in sync with the other fields. No `resolvedAt` parameter — resolution
// now mutates the underlying state directly (drops pendingPermission /
// flips needsAttention), so derivation reads the post-resolution view.
export function derivePromptKind(
  att:
    | (Pick<AttentionInfo, "needsAttention" | "lastEvent" | "notificationType"> & {
        pendingPermission?: PendingPermission;
        pending?: Pending;
      })
    | undefined,
): PromptKind {
  if (!att) return null;
  // The discriminated `pending` field is authoritative when present. We
  // intentionally do NOT gate on `needsAttention` here: viewing a session
  // soft-clears the red dot but keeps the form/prompt alive, and the
  // composer needs `promptKind` to keep showing the right action surface.
  if (att.pending) {
    return att.pending.kind === "elicitation" ? "elicitation" : "permission";
  }
  // Legacy: PermissionRequest may have set only the back-compat field.
  if (att.pendingPermission) return "permission";
  // Notification-only signals (no structured pending) still depend on the
  // red dot — without it we have no way to distinguish a stale notification
  // from a live one.
  if (!att.needsAttention) return null;
  if (att.lastEvent !== "Notification") return null;
  switch (att.notificationType) {
    case "permission_prompt":
      return "permission";
    case "elicitation_dialog":
      return "elicitation";
    case "idle_prompt":
      return "idle";
    case "auth_success":
    case "elicitation_complete":
    case "elicitation_response":
      return null;
    default:
      // Missing or unknown — older Claude Code or a future type. Assume
      // permission so the user still gets Approve/Deny.
      return "permission";
  }
}

// ---- Send-key payloads (POST /api/sessions/:id/send) ----

export type SendBody =
  | { text: string; submit?: boolean; attachments?: string[] }
  | { key: string }
  | { attachments: string[]; text?: string; submit?: boolean };

// ---- Uploads (POST /api/sessions/:id/upload) ----

export interface UploadedFile {
  // Original filename as provided by the browser.
  name: string;
  // Absolute path on the host where the server saved it. Sent back to the
  // server in the `attachments` field of a subsequent send.
  path: string;
  size: number;
  mime: string;
}

export interface UploadResponse {
  files: UploadedFile[];
}

// ---- Slash commands (GET /api/commands?cwd=) ----

// Plugin namespace is open-ended, so we keep this as a template-literal
// union with a string fallback rather than enumerating known plugins.
export type SlashCommandSource = "project" | "user" | `plugin:${string}`;

// Discriminator between markdown `.md` slash commands and skill manifests.
// Same name can exist in both kinds; the renderer shows a chip for each.
export type SlashCommandKind = "command" | "skill";

export interface SlashCommand {
  name: string;
  source: SlashCommandSource;
  kind: SlashCommandKind;
  description: string;
  argumentHint: string;
}

// ---- Synthetic (pending) session ids ----

// A "pending" session is a claude process in a tmux pane that hasn't yet
// written ~/.claude/sessions/<pid>.json — usually because it's blocked on
// the trust dialog. The server synthesises an id like `pending-<pid>` so
// the web layer can address it uniformly with registered sessions.

const SYNTHETIC_ID_PREFIX = "pending-";

export function syntheticSessionId(pid: number): string {
  return `${SYNTHETIC_ID_PREFIX}${pid}`;
}

export function parseSyntheticSessionId(id: string): number | null {
  if (!id.startsWith(SYNTHETIC_ID_PREFIX)) return null;
  const pid = Number(id.slice(SYNTHETIC_ID_PREFIX.length));
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}
