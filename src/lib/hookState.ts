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

export type PendingPermission = {
  toolName: string;
  toolInput: unknown;
  requestedAt: number;
};

export type SessionAttention = {
  needsAttention: boolean;
  lastEvent: string;
  lastEventAt: number;
  message?: string;
  notificationType?: string;
  pendingPermission?: PendingPermission;
};

export type HookBroadcast = {
  sessionId: string;
} & SessionAttention;

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

  record(input: HookEventInput): HookBroadcast {
    if (!input || typeof input.session_id !== "string" || !input.session_id) {
      throw new Error("hook event missing session_id");
    }
    const now = Date.now();
    const prev = this.bySession.get(input.session_id);

    // PermissionRequest carries the tool detail. We treat it as a strong
    // "needs attention" signal even if no Notification arrives — and we
    // preserve `pendingPermission` across subsequent Notification/Stop
    // events so the UI doesn't lose the tool name mid-prompt.
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
      return { sessionId: input.session_id, ...entry };
    }

    const informational =
      typeof input.notification_type === "string" &&
      INFORMATIONAL_NOTIFICATION_TYPES.has(input.notification_type);
    const entry: SessionAttention = {
      needsAttention: !informational,
      lastEvent: input.hook_event_name,
      lastEventAt: now,
      message: input.message,
      notificationType: input.notification_type,
      // Preserve any pendingPermission from an earlier PermissionRequest
      // until the user acts (clear()) or a new PermissionRequest replaces
      // it — Notification/Stop alone shouldn't drop the tool detail.
      pendingPermission: prev?.pendingPermission,
    };
    this.bySession.set(input.session_id, entry);
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
  }

  get(sessionId: string): SessionAttention | undefined {
    return this.bySession.get(sessionId);
  }

  snapshot(): Record<string, SessionAttention> {
    const out: Record<string, SessionAttention> = {};
    for (const [k, v] of this.bySession) out[k] = { ...v };
    return out;
  }
}
