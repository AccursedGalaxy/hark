import {
  derivePromptKind,
  type AttentionInfo,
  type HookBroadcast,
  type PendingPermission,
  type PromptKind,
  type TranscriptEvent,
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
// either way; the alias keeps existing call sites readable without inventing
// a second type.
export type SessionAttention = AttentionInfo;

// Result type for the periodic resolver: just enough for the route layer to
// fs.stat without caring about other file fields.
export type StatLike = { mtimeMs: number };
export type StatFn = (path: string) => Promise<StatLike>;

// Notification types that report status rather than asking the user
// anything. Still recorded so the UI can flash "auth succeeded", but they
// must not mark the session as needs-attention.
const INFORMATIONAL_NOTIFICATION_TYPES = new Set([
  "auth_success",
  "elicitation_complete",
  "elicitation_response",
]);

// Small fudge so a transcript write that landed in the same millisecond as
// the PermissionRequest (unlikely but possible on a fast machine) doesn't
// instantly self-resolve. Real CLI approvals take humans seconds.
const PERMISSION_RESOLVE_SKEW_MS = 50;

/**
 * Per-session "what is Claude waiting for?" state machine.
 *
 * Three resolution signals all feed in here:
 *   - hook events (PermissionRequest, Stop, Notification) via `record`
 *   - transcript growth via `noteTranscriptEvents` / `resolveStaleFromTranscripts`
 *   - user-initiated send-keys via `noteSendKeys`
 *
 * One source of truth: the snapshot returned to the wire (including the
 * computed `promptKind`) is what every client renders.
 */
export class PromptState {
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
      const entry = finalize({
        needsAttention: true,
        lastEvent: input.hook_event_name,
        lastEventAt: now,
        message: input.message ?? prev?.message,
        notificationType: prev?.notificationType,
        pendingPermission: pending,
      });
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
    const entry = finalize({
      needsAttention: !informational,
      lastEvent: input.hook_event_name,
      lastEventAt: now,
      message: input.message,
      notificationType: input.notification_type,
      pendingPermission: resolvesPending ? undefined : prev?.pendingPermission,
    });
    this.bySession.set(input.session_id, entry);
    if (resolvesPending) this.pendingMeta.delete(input.session_id);
    return { sessionId: input.session_id, ...entry };
  }

  /**
   * Hard reset: drop needs-attention, pending permission, and recompute
   * promptKind. Called by the badge-dismiss endpoint, by close-session, and
   * by `noteSendKeys` / `noteTranscriptEvents` / `resolveStaleFromTranscripts`
   * when they detect a resolution.
   */
  clear(sessionId: string): SessionAttention | null {
    const cur = this.bySession.get(sessionId);
    if (!cur) return null;
    const next = finalize({
      ...cur,
      needsAttention: false,
      pendingPermission: undefined,
    });
    this.bySession.set(sessionId, next);
    this.pendingMeta.delete(sessionId);
    return next;
  }

  /**
   * Tell the state machine that the transcript advanced. If any of the
   * supplied events is newer than the pending permission's `requestedAt`,
   * the permission is considered resolved (the user answered 1/2 in the
   * CLI). Returns a broadcast iff a resolution actually happened.
   */
  noteTranscriptEvents(
    sessionId: string,
    events: TranscriptEvent[],
  ): HookBroadcast | null {
    if (events.length === 0) return null;
    const att = this.bySession.get(sessionId);
    const pp = att?.pendingPermission;
    if (!pp) return null;
    for (const ev of events) {
      const tsMs = Date.parse(ev.ts ?? "");
      if (Number.isFinite(tsMs) && tsMs > pp.requestedAt) {
        const next = this.clear(sessionId);
        return next ? { sessionId, ...next } : null;
      }
    }
    return null;
  }

  /**
   * Tell the state machine that the user just sent keys from the web UI.
   * Drops needs-attention and pending permission (the user is now driving
   * the session, so any prior prompt is moot). Returns a broadcast iff
   * there was state to clear.
   */
  noteSendKeys(sessionId: string): HookBroadcast | null {
    const prev = this.bySession.get(sessionId);
    if (!prev) return null;
    // Either condition is enough to do work. The pending-only branch covers
    // weird sequences like PermissionRequest → Notification(auth_success),
    // where `needsAttention` is already false but a stale pendingPermission
    // is still hanging on and driving the UI.
    if (!prev.needsAttention && !prev.pendingPermission) return null;
    const next = this.clear(sessionId);
    return next ? { sessionId, ...next } : null;
  }

  /**
   * Periodic safety net: for every session with a pending permission and a
   * known transcript path, stat the file and resolve the permission if the
   * file mtime is past `requestedAt + skew`. Returns the broadcasts the
   * route layer should send.
   *
   * `stat` is injected so tests can run without touching the filesystem.
   */
  async resolveStaleFromTranscripts(
    stat: StatFn,
    skewMs: number = PERMISSION_RESOLVE_SKEW_MS,
  ): Promise<HookBroadcast[]> {
    const out: HookBroadcast[] = [];
    for (const [sessionId, att] of this.bySession) {
      const pp = att.pendingPermission;
      if (!pp) continue;
      const path = this.pendingMeta.get(sessionId)?.transcriptPath;
      if (!path) continue;
      try {
        const s = await stat(path);
        if (s.mtimeMs > pp.requestedAt + skewMs) {
          const next = this.clear(sessionId);
          if (next) out.push({ sessionId, ...next });
        }
      } catch {
        /* transcript missing or transiently unreadable — try again next tick */
      }
    }
    return out;
  }

  get(sessionId: string): SessionAttention | undefined {
    return this.bySession.get(sessionId);
  }

  pendingTranscriptPath(sessionId: string): string | undefined {
    return this.pendingMeta.get(sessionId)?.transcriptPath;
  }

  snapshot(): Record<string, SessionAttention> {
    const out: Record<string, SessionAttention> = {};
    for (const [k, v] of this.bySession) out[k] = { ...v };
    return out;
  }
}

// Compute the wire-facing `promptKind` once per mutation so every reader
// sees the same verdict. Kept local so the class body stays focused on
// state transitions.
function finalize(
  partial: Omit<SessionAttention, "promptKind">,
): SessionAttention {
  return { ...partial, promptKind: derivePromptKind(partial) };
}
