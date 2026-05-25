// Wire protocol shared with the Express host in src/server.ts.
// The host already speaks REST + SSE; these are the exact shapes it returns,
// not an idealized contract. Keep this file in sync with src/server.ts and
// src/lib/{transcript,hookState}.ts.

// ---- Sessions ----

export type SessionStatus = "busy" | "idle" | string;
export type SessionKind = "interactive" | "bg" | string;

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

export type TranscriptEvent =
  | { kind: "user"; uuid: string; ts: string; text: string }
  | { kind: "assistant"; uuid: string; ts: string; blocks: ContentBlock[] }
  | {
      kind: "tool_result";
      uuid: string;
      ts: string;
      toolUseId: string;
      output: string;
      isError: boolean;
    }
  | { kind: "system"; uuid: string; ts: string; text: string };

// ---- Attention (from /api/events SSE) ----

export interface AttentionInfo {
  needsAttention: boolean;
  lastEvent?: string;
  lastEventAt?: number;
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
