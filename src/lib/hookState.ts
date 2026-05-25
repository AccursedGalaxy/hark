import type {
  AttentionInfo,
  HookBroadcast,
  PendingPermission,
} from "../shared/protocol.js";

export type { HookBroadcast, PendingPermission };

export type HookEventInput = {
  session_id: string;
  hook_event_name: string;
  message?: string;
  // The Notification hook payload carries `notification_type` with documented
  // values: permission_prompt, idle_prompt, auth_success, elicitation_dialog,
  // elicitation_complete, elicitation_response. See docs/interactions.md.
  notification_type?: string;
  // PermissionRequest payload — tool the model wants to call.
  tool_name?: string;
  tool_input?: unknown;
  transcript_path?: string;
  cwd?: string;
};

// Server-only metadata tied to a session's pending permission. Kept off the
// wire because the absolute transcript path is filesystem detail the web
// client never needs — its only consumer is the periodic resolver that
// detects CLI-side approval by stat'ing the transcript file.
export type PendingMeta = {
  transcriptPath?: string;
};

// Server-internal alias for the on-the-wire AttentionInfo shape. Same fields
// either way; the alias keeps existing call sites in hookState.ts readable
// without inventing a second type.
export type SessionAttention = AttentionInfo;

// Notification types that report status rather than asking the user
// anything. Still recorded so the UI can flash "auth succeeded", but they
// must not mark the session as needs-attention.
const INFORMATIONAL_NOTIFICATION_TYPES = new Set([
  "auth_success",
  "elicitation_complete",
  "elicitation_response",
]);

export class HookState {
  private readonly bySession = new Map<string, SessionAttention>();
  // Server-only sidecar map. The transcript path is needed by the periodic
  // resolver to detect that Claude has appended new events since the
  // permission fired (i.e., the user already answered it in the CLI), but
  // it never goes out on the SSE wire.
  private readonly pendingMeta = new Map<string, PendingMeta>();

  record(input: HookEventInput): HookBroadcast {
    if (!input || typeof input.session_id !== "string" || !input.session_id) {
      throw new Error("hook event missing session_id");
    }
    const now = Date.now();
    const prev = this.bySession.get(input.session_id);

    // PermissionRequest carries the tool detail. We treat it as a strong
    // "needs attention" signal even if no Notification arrives — and we
    // preserve `pendingPermission` across subsequent Notification events so
    // the UI doesn't lose the tool name mid-prompt.
    if (input.hook_event_name === "PermissionRequest") {
      const pending: PendingPermission | undefined =
        typeof input.tool_name === "string"
          ? {
              toolName: input.tool_name,
              toolInput: input.tool_input,
              requestedAt: now,
            }
          : prev?.pendingPermission;
      const entry: SessionAttention = {
        needsAttention: true,
        lastEvent: input.hook_event_name,
        lastEventAt: now,
        message: input.message ?? prev?.message,
        notificationType: prev?.notificationType,
        pendingPermission: pending,
      };
      this.bySession.set(input.session_id, entry);
      if (typeof input.transcript_path === "string" && input.transcript_path) {
        this.pendingMeta.set(input.session_id, {
          transcriptPath: input.transcript_path,
        });
      }
      return { sessionId: input.session_id, ...entry };
    }

    // Stop and idle-prompt Notifications mean Claude's turn is over and
    // it's idle / waiting for fresh user input — Claude can't reach those
    // states while a permission is still pending, so any prior pending
    // state must have been resolved (typically by the user answering 1/2
    // directly in the CLI). Drop it so the web UI stops rendering
    // Approve/Deny for a prompt that no longer exists.
    const resolvesPending =
      input.hook_event_name === "Stop" ||
      (input.hook_event_name === "Notification" &&
        input.notification_type === "idle_prompt");

    const informational =
      typeof input.notification_type === "string" &&
      INFORMATIONAL_NOTIFICATION_TYPES.has(input.notification_type);
    const entry: SessionAttention = {
      needsAttention: !informational,
      lastEvent: input.hook_event_name,
      lastEventAt: now,
      message: input.message,
      notificationType: input.notification_type,
      pendingPermission: resolvesPending ? undefined : prev?.pendingPermission,
    };
    this.bySession.set(input.session_id, entry);
    if (resolvesPending) this.pendingMeta.delete(input.session_id);
    return { sessionId: input.session_id, ...entry };
  }

  clear(sessionId: string): void {
    const cur = this.bySession.get(sessionId);
    if (!cur) return;
    this.bySession.set(sessionId, {
      ...cur,
      needsAttention: false,
      pendingPermission: undefined,
    });
    this.pendingMeta.delete(sessionId);
  }

  get(sessionId: string): SessionAttention | undefined {
    return this.bySession.get(sessionId);
  }

  // Used by the server's periodic resolver. Returns the transcript path
  // that came in with the original PermissionRequest hook, if any.
  pendingTranscriptPath(sessionId: string): string | undefined {
    return this.pendingMeta.get(sessionId)?.transcriptPath;
  }

  snapshot(): Record<string, SessionAttention> {
    const out: Record<string, SessionAttention> = {};
    for (const [k, v] of this.bySession) out[k] = { ...v };
    return out;
  }
}
