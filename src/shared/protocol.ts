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
  // Severity tier of `needsAttention` (blocking > error > idle), null when
  // no attention is needed. Same lifecycle as the boolean; see
  // `deriveAttentionKind`.
  attentionKind?: AttentionKind;
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

// Type-narrowing helpers for raw JSONL records — every field is unknown
// until proven otherwise. Exported because the server's transcript parser
// reuses them.
export function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
export function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
export function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
export function asBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}
export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Map a raw `toolUseResult` blob to a typed `ToolResultMeta`. The `toolName`
 * is optional — when omitted (e.g. the matching tool_use hasn't been seen
 * yet), we still return `{kind: "raw", data}` so the consumer can render
 * something useful. When the shape doesn't match the expected schema for a
 * known tool, we also fall back to `raw` rather than emit a half-parsed view.
 *
 * Lives in the shared protocol (not the server's transcript parser) because
 * the web client re-runs it when enriching `?after=` delta events whose
 * matching tool_use sits in its cached history.
 */
export function extractToolMeta(
  toolName: string | undefined,
  raw: unknown,
): ToolResultMeta {
  const obj = asObject(raw);
  if (!obj) return { kind: "raw", data: raw };

  switch (toolName) {
    case "Read": {
      const file = asObject(obj.file);
      if (!file) return { kind: "raw", data: raw };
      return {
        kind: "read",
        filePath: asString(file.filePath),
        numLines: asNumber(file.numLines),
        totalLines: asNumber(file.totalLines),
        startLine: asNumber(file.startLine, 1),
      };
    }
    case "Bash": {
      return {
        kind: "bash",
        stderr: asString(obj.stderr),
        interrupted: asBool(obj.interrupted),
        backgroundTaskId:
          typeof obj.backgroundTaskId === "string"
            ? obj.backgroundTaskId
            : undefined,
        returnCodeInterpretation:
          typeof obj.returnCodeInterpretation === "string"
            ? obj.returnCodeInterpretation
            : undefined,
      };
    }
    case "Edit": {
      if (typeof obj.filePath !== "string") return { kind: "raw", data: raw };
      return {
        kind: "edit",
        filePath: obj.filePath,
        replaceAll: asBool(obj.replaceAll),
        userModified: asBool(obj.userModified),
        structuredPatch: obj.structuredPatch,
      };
    }
    case "Write": {
      if (typeof obj.filePath !== "string") return { kind: "raw", data: raw };
      return {
        kind: "write",
        filePath: obj.filePath,
        type: asString(obj.type, "update"),
        userModified: asBool(obj.userModified),
        structuredPatch: obj.structuredPatch,
      };
    }
    case "Glob": {
      return {
        kind: "glob",
        numFiles: asNumber(obj.numFiles),
        truncated: asBool(obj.truncated),
        durationMs: asNumber(obj.durationMs),
        filenames: asStringArray(obj.filenames),
      };
    }
    case "WebFetch": {
      return {
        kind: "webfetch",
        url: asString(obj.url),
        code: asNumber(obj.code),
        codeText: asString(obj.codeText),
        bytes: asNumber(obj.bytes),
        durationMs: asNumber(obj.durationMs),
      };
    }
    case "WebSearch": {
      const results = Array.isArray(obj.results) ? obj.results : [];
      return {
        kind: "websearch",
        query: asString(obj.query),
        searchCount: asNumber(obj.searchCount),
        durationSeconds: asNumber(obj.durationSeconds),
        resultCount: results.length,
      };
    }
    default:
      return { kind: "raw", data: raw };
  }
}

/**
 * Tracks tool-use id → tool name across a stream of events. Same instance
 * works for the batch parse, the SSE streaming path, and the web client's
 * delta enrichment. The stateful wrapper exists because a `tool_result`
 * line on its own doesn't know which tool produced it — only the prior
 * `tool_use` block does.
 *
 * Memory: one Map entry per assistant tool call. We never delete entries
 * (a single transcript stays bounded by the actual tool calls in it), so a
 * long-running stream holds at most O(toolCalls) names. For interactive
 * sessions that's negligible; if it ever isn't, we can evict on result.
 */
export class ToolNameIndex {
  private names = new Map<string, string>();

  /** Record every tool_use block from an assistant event. Idempotent. */
  noteAssistant(blocks: ContentBlock[]): void {
    for (const b of blocks) {
      if (b.type === "tool_use") this.names.set(b.id, b.name);
    }
  }

  /** Resolve a tool_use_id to its name, or undefined if unknown. */
  resolve(toolUseId: string): string | undefined {
    return this.names.get(toolUseId);
  }

  /**
   * Enrich a tool_result event: fills `toolName` from the index and re-runs
   * `extractToolMeta` against the resolved name. Returns a new event (we
   * don't mutate). If `meta` is still `raw` (parsed without name context),
   * it's re-extracted now that the name is known.
   */
  enrich(ev: ToolResultEvent): ToolResultEvent {
    const toolName = this.resolve(ev.toolUseId);
    if (!toolName) return ev;
    const meta =
      ev.meta?.kind === "raw"
        ? extractToolMeta(toolName, ev.meta.data)
        : ev.meta;
    return { ...ev, toolName, meta };
  }
}

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
  // Severity classification of `needsAttention` — null exactly when the
  // boolean is false. See `deriveAttentionKind` for the tier semantics.
  attentionKind: AttentionKind;
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

// ---- Attention severity tiers ----
//
// `needsAttention` lumps three very different situations into one boolean:
// "Claude is stuck waiting on a decision", "the turn died with an error",
// and "the turn finished, your move". `attentionKind` splits them so
// ambient surfaces (favicon, title, rail ordering) can signal at the right
// volume instead of treating everything as the same red dot.
//
//   "blocking" — Claude is waiting on a decision (tool permission,
//                AskUserQuestion, ExitPlanMode, MCP elicitation, oauth).
//                The session makes zero progress until the user acts.
//   "error"    — StopFailure (rate limit, auth, billing, …). Nothing is
//                waiting on input, but the user should take a look.
//   "idle"     — turn finished / idle nudge. Informational "your turn".
//   null       — no attention needed. Mirrors `needsAttention === false`,
//                so the two fields always clear together (dismiss, clear,
//                send-keys, transcript resolution all just flip the bool
//                and this derivation follows).
export type AttentionKind = "blocking" | "error" | "idle" | null;

// Pure derivation, computed by PromptState alongside `promptKind` on every
// state mutation so the wire field can never drift from the fields it is
// derived from.
//
// Unlike `derivePromptKind` (which defaults unknown notification types to
// "permission" so the composer still offers Approve/Deny), the ambient tier
// is deliberately conservative: an unknown/future notification type keeps
// `needsAttention` (safe default — worth a look) but classifies as "idle",
// never "blocking", so a new benign type Claude Code ships can't spuriously
// scream "Claude is stuck".
export function deriveAttentionKind(
  att:
    | (Pick<
        AttentionInfo,
        "needsAttention" | "lastEvent" | "notificationType" | "lastError"
      > & {
        pendingPermission?: PendingPermission;
        pending?: Pending;
      })
    | undefined,
): AttentionKind {
  if (!att || !att.needsAttention) return null;
  // Blocking dominates every other signal. A live pending decision means
  // the session is stuck regardless of what event arrived last (subagent
  // chatter, unrelated notifications) — PromptState carries `pending`
  // across those events, so deriving from it keeps the tier pinned until a
  // real resolution path (Stop / idle_prompt, matching tool_result, the
  // transcript resolver, send-keys, clear) drops the pending state.
  if (att.pending || att.pendingPermission) return "blocking";
  // Blocking hook events where the payload was too degenerate to build a
  // structured `pending` (e.g. PermissionRequest without a tool_name).
  if (att.lastEvent === "PermissionRequest" || att.lastEvent === "Elicitation")
    return "blocking";
  // Notification-only signals: only the documented "a prompt is open in the
  // TUI right now" types count as blocking. Everything else — including
  // unknown/future types — falls through to "idle" (see note above).
  if (
    att.lastEvent === "Notification" &&
    (att.notificationType === "permission_prompt" ||
      att.notificationType === "elicitation_dialog")
  )
    return "blocking";
  // Error tier: the last turn died. `lastError` persists across follow-up
  // notifications until a clean Stop or a user action clears it, so an
  // unresolved error outranks a later idle nudge.
  if (att.lastError || att.lastEvent === "StopFailure") return "error";
  // Everything else that still needs attention is a "your turn" nudge:
  // Stop, idle_prompt, and unknown notification types.
  return "idle";
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
