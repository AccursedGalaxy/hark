// Wire protocol shared with the Express host in src/server.ts.
// The host already speaks REST + SSE; these are the exact shapes it returns,
// not an idealized contract. Keep this file in sync with src/server.ts and
// src/lib/{transcript,hookState}.ts.

// ---- Sessions ----

export type SessionStatus = "busy" | "idle" | string;
export type SessionKind = "interactive" | "bg" | string;

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
}

export interface HookBroadcast extends AttentionInfo {
  sessionId: string;
}

// ---- Send-key payloads (POST /api/sessions/:id/send) ----

export type SendBody =
  | { text: string; submit?: boolean }
  | { key: string };
