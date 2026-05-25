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

export type SessionStatus = "busy" | "idle" | string;
// "pending" = a `claude` process running in a tmux pane but not yet
// registered with Claude Code (usually blocked on the trust dialog).
// Synthesized by the server so the user can drive it from the rail.
export type SessionKind = "interactive" | "bg" | "pending" | string;

export interface PendingPermission {
  toolName: string;
  toolInput: unknown;
  requestedAt: number;
}

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
}

// Derived UI state. The backend's raw `status` plus the hook attention layer
// collapse into one of these four. Done here so components don't repeat logic.
export type SessionState = "wait" | "busy" | "idle" | "dead";

export function deriveState(s: RawSession): SessionState {
  if (s.needsAttention) return "wait";
  if (s.status === "busy") return "busy";
  if (s.status === "idle") return "idle";
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

export type TranscriptEvent =
  | { kind: "user"; uuid: string; ts: string; text: string }
  | { kind: "assistant"; uuid: string; ts: string; blocks: ContentBlock[] }
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

// Per-session attention state, exactly as recorded by HookState on the
// server. The snapshot endpoint and the streamed hook events both carry
// this shape; clients consume it verbatim.
export interface AttentionInfo {
  needsAttention: boolean;
  lastEvent: string;
  lastEventAt: number;
  message?: string;
  notificationType?: string;
  pendingPermission?: PendingPermission;
}

export interface HookBroadcast extends AttentionInfo {
  sessionId: string;
}

// What kind of input Claude Code is waiting for. Drives Composer UI:
// "permission" shows Approve/Deny; "elicitation" shows just the keypad;
// "idle" lets the user type freely; null means not waiting on the user.
// Map per docs/interactions.md — informational types collapse to null.
export type PromptKind = "permission" | "elicitation" | "idle" | null;

export function derivePromptKind(
  att: AttentionInfo | undefined,
  resolvedAt: number,
): PromptKind {
  if (!att) return null;
  // PermissionRequest always wins — even if a later Notification of a
  // different kind arrived, the tool decision is the user's actual gate.
  if (att.pendingPermission && att.pendingPermission.requestedAt > resolvedAt) {
    return "permission";
  }
  if (att.lastEvent !== "Notification") return null;
  const last = att.lastEventAt ?? 0;
  if (last <= resolvedAt) return null;
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
