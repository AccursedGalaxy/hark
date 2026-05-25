import {
  derivePromptKind,
  type AskQuestion,
  type AttentionInfo,
  type ElicitationField,
  type HookBroadcast,
  type Pending,
  type PendingPermission,
  type PromptKind,
  type SessionError,
  type StopErrorType,
  type SubagentInfo,
  type TranscriptEvent,
} from "../shared/protocol.js";

export type { HookBroadcast, PendingPermission };

// Raw shape of a hook POST as Claude Code sends it. Most fields are
// event-specific; we read them defensively because Anthropic adds new ones
// each version. Anything we don't recognise is ignored, not rejected.
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
  tool_use_id?: string;
  transcript_path?: string;
  cwd?: string;
  previous_cwd?: string;
  // StopFailure payload.
  error_type?: StopErrorType;
  error_message?: string;
  // Elicitation payload (MCP server-driven forms).
  server_name?: string;
  form_fields?: unknown;
  // SubagentStart / SubagentStop / TaskCreated / TaskCompleted payloads.
  agent_id?: string;
  agent_type?: string;
  task_id?: string;
  task_title?: string;
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

// Build a discriminated `Pending` from a PermissionRequest payload. The
// tool_name decides the variant; everything else stays as raw `toolInput`
// so the per-tool renderer on the frontend can pick its own fields.
function pendingFromPermissionRequest(
  toolName: string,
  toolInput: unknown,
  toolUseId: string | undefined,
  now: number,
): Pending {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  if (toolName === "AskUserQuestion") {
    const questions = Array.isArray(input.questions)
      ? (input.questions as AskQuestion[])
      : [];
    return {
      kind: "ask_user_question",
      questions,
      toolUseId,
      requestedAt: now,
    };
  }
  if (toolName === "ExitPlanMode") {
    return {
      kind: "exit_plan_mode",
      plan: typeof input.plan === "string" ? input.plan : "",
      toolUseId,
      requestedAt: now,
    };
  }
  return {
    kind: "tool_permission",
    toolName,
    toolInput,
    toolUseId,
    requestedAt: now,
  };
}

// Lift form-field JSON the Elicitation hook delivers into our schema.
function normalizeFormFields(raw: unknown): ElicitationField[] {
  if (!Array.isArray(raw)) return [];
  const out: ElicitationField[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name : null;
    if (!name) continue;
    const type = typeof r.type === "string" ? r.type : "string";
    const options = Array.isArray(r.options)
      ? r.options.filter((o): o is string => typeof o === "string")
      : undefined;
    out.push({
      name,
      type,
      required: Boolean(r.required),
      ...(options ? { options } : {}),
      ...(typeof r.description === "string"
        ? { description: r.description }
        : {}),
    });
  }
  return out;
}

/**
 * Per-session "what is Claude waiting for?" state machine.
 *
 * Resolution signals all feed in here:
 *   - hook events (PermissionRequest, Notification, Stop, StopFailure,
 *     Elicitation, SubagentStart/Stop, TaskCreated/Completed, CwdChanged,
 *     SessionStart/End, PreCompact/PostCompact, PermissionDenied) via `record`
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
    const event = input.hook_event_name;

    // ---- PermissionRequest: the user is blocked on a tool call. Promote
    // to the discriminated `pending` shape so the frontend can render the
    // right widget (per-tool card, AskUserQuestion form, plan view, ...).
    if (event === "PermissionRequest") {
      const pending: Pending | undefined =
        typeof input.tool_name === "string"
          ? pendingFromPermissionRequest(
              input.tool_name,
              input.tool_input,
              input.tool_use_id,
              now,
            )
          : prev?.pending;
      const legacy: PendingPermission | undefined =
        pending && pending.kind === "tool_permission"
          ? {
              toolName: pending.toolName,
              toolInput: pending.toolInput,
              requestedAt: pending.requestedAt,
            }
          : prev?.pendingPermission;
      const entry = finalize({
        needsAttention: true,
        lastEvent: event,
        lastEventAt: now,
        message: input.message ?? prev?.message,
        notificationType: prev?.notificationType,
        pending,
        pendingPermission: legacy,
        subagents: prev?.subagents,
        cwd: input.cwd ?? prev?.cwd,
      });
      this.bySession.set(input.session_id, entry);
      if (typeof input.transcript_path === "string" && input.transcript_path) {
        this.pendingMeta.set(input.session_id, {
          transcriptPath: input.transcript_path,
        });
      }
      return { sessionId: input.session_id, ...entry };
    }

    // ---- Elicitation: MCP-driven structured form. Same blocking semantics
    // as PermissionRequest but a different payload shape (server_name +
    // form_fields). ElicitationResult clears it.
    if (event === "Elicitation") {
      const pending: Pending = {
        kind: "elicitation",
        serverName:
          typeof input.server_name === "string" ? input.server_name : "mcp",
        message: input.message,
        fields: normalizeFormFields(input.form_fields),
        requestedAt: now,
      };
      const entry = finalize({
        needsAttention: true,
        lastEvent: event,
        lastEventAt: now,
        message: input.message,
        notificationType: prev?.notificationType,
        pending,
        pendingPermission: prev?.pendingPermission,
        subagents: prev?.subagents,
        cwd: prev?.cwd,
      });
      this.bySession.set(input.session_id, entry);
      return { sessionId: input.session_id, ...entry };
    }

    if (event === "ElicitationResult") {
      // Server confirmed the form is closed (either the user submitted or
      // the MCP server cancelled). Drop pending state but keep the session
      // notified so the UI can flash a "submitted" toast.
      const next = finalize({
        needsAttention: false,
        lastEvent: event,
        lastEventAt: now,
        message: input.message ?? prev?.message,
        notificationType: prev?.notificationType,
        pending: undefined,
        pendingPermission: prev?.pendingPermission,
        subagents: prev?.subagents,
        cwd: prev?.cwd,
        lastError: prev?.lastError,
      });
      this.bySession.set(input.session_id, next);
      return { sessionId: input.session_id, ...next };
    }

    // ---- StopFailure: turn ended with an error. Tier-1 status only; never
    // a blocking pending state, but the UI surfaces a chip + retry button.
    if (event === "StopFailure") {
      const lastError: SessionError | undefined = input.error_type
        ? {
            errorType: input.error_type,
            errorMessage: input.error_message ?? "",
            occurredAt: now,
          }
        : undefined;
      const next = finalize({
        needsAttention: true,
        lastEvent: event,
        lastEventAt: now,
        message: input.message ?? input.error_message,
        notificationType: prev?.notificationType,
        // Errors don't carry a tool decision — drop any stale pending so
        // the composer recovers to an input-friendly state.
        pending: undefined,
        pendingPermission: undefined,
        subagents: prev?.subagents,
        cwd: prev?.cwd,
        lastError,
      });
      this.bySession.set(input.session_id, next);
      this.pendingMeta.delete(input.session_id);
      return { sessionId: input.session_id, ...next };
    }

    // ---- SubagentStart / SubagentStop: maintain running-subagent list so
    // the sidebar can show "running 2 agents". Not needs-attention.
    if (event === "SubagentStart") {
      const subagents = [...(prev?.subagents ?? [])];
      if (input.agent_id) {
        subagents.push({
          agentId: input.agent_id,
          agentType: input.agent_type ?? "agent",
          startedAt: now,
        });
      }
      const next = finalize({
        needsAttention: prev?.needsAttention ?? false,
        lastEvent: event,
        lastEventAt: now,
        message: prev?.message,
        notificationType: prev?.notificationType,
        pending: prev?.pending,
        pendingPermission: prev?.pendingPermission,
        subagents,
        cwd: prev?.cwd,
        lastError: prev?.lastError,
      });
      this.bySession.set(input.session_id, next);
      return { sessionId: input.session_id, ...next };
    }
    if (event === "SubagentStop") {
      const subagents = (prev?.subagents ?? []).filter(
        (a) => a.agentId !== input.agent_id,
      );
      const next = finalize({
        needsAttention: prev?.needsAttention ?? false,
        lastEvent: event,
        lastEventAt: now,
        message: prev?.message,
        notificationType: prev?.notificationType,
        pending: prev?.pending,
        pendingPermission: prev?.pendingPermission,
        subagents,
        cwd: prev?.cwd,
        lastError: prev?.lastError,
      });
      this.bySession.set(input.session_id, next);
      return { sessionId: input.session_id, ...next };
    }

    // ---- CwdChanged: refresh the cached cwd so header + slash command
    // discovery follows the session into its new directory.
    if (event === "CwdChanged") {
      const next = finalize({
        needsAttention: prev?.needsAttention ?? false,
        lastEvent: event,
        lastEventAt: now,
        message: prev?.message,
        notificationType: prev?.notificationType,
        pending: prev?.pending,
        pendingPermission: prev?.pendingPermission,
        subagents: prev?.subagents,
        cwd: input.cwd ?? prev?.cwd,
        lastError: prev?.lastError,
      });
      this.bySession.set(input.session_id, next);
      return { sessionId: input.session_id, ...next };
    }

    // ---- Stop and idle-prompt Notifications mean Claude's turn is over and
    // it's idle / waiting for fresh user input — Claude can't reach those
    // states while a permission is still pending, so any prior pending
    // state must have been resolved (typically by the user answering 1/2
    // directly in the CLI). Drop it so the web UI stops rendering
    // Approve/Deny for a prompt that no longer exists.
    const resolvesPending =
      event === "Stop" ||
      (event === "Notification" &&
        input.notification_type === "idle_prompt");

    const informational =
      typeof input.notification_type === "string" &&
      INFORMATIONAL_NOTIFICATION_TYPES.has(input.notification_type);
    const entry = finalize({
      needsAttention: !informational,
      lastEvent: event,
      lastEventAt: now,
      message: input.message,
      notificationType: input.notification_type,
      pending: resolvesPending ? undefined : prev?.pending,
      pendingPermission: resolvesPending
        ? undefined
        : prev?.pendingPermission,
      subagents: prev?.subagents,
      cwd: input.cwd ?? prev?.cwd,
      // A clean Stop clears the last error; a Notification doesn't.
      lastError: event === "Stop" ? undefined : prev?.lastError,
    });
    this.bySession.set(input.session_id, entry);
    if (resolvesPending) this.pendingMeta.delete(input.session_id);
    return { sessionId: input.session_id, ...entry };
  }

  /**
   * Hard reset: drop needs-attention, pending permission, last error, and
   * recompute promptKind. Called by the badge-dismiss endpoint, by
   * close-session, and by `noteSendKeys` / `noteTranscriptEvents` /
   * `resolveStaleFromTranscripts` when they detect a resolution.
   */
  clear(sessionId: string): SessionAttention | null {
    const cur = this.bySession.get(sessionId);
    if (!cur) return null;
    const next = finalize({
      ...cur,
      needsAttention: false,
      pending: undefined,
      pendingPermission: undefined,
      lastError: undefined,
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
    const pending = att?.pending;
    const requestedAt =
      pending?.requestedAt ?? att?.pendingPermission?.requestedAt;
    if (requestedAt === undefined) return null;
    for (const ev of events) {
      const tsMs = Date.parse(ev.ts ?? "");
      if (Number.isFinite(tsMs) && tsMs > requestedAt) {
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
    // where `needsAttention` is already false but a stale pending state is
    // still hanging on and driving the UI.
    if (
      !prev.needsAttention &&
      !prev.pendingPermission &&
      !prev.pending &&
      !prev.lastError
    )
      return null;
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
      const requestedAt =
        att.pending?.requestedAt ?? att.pendingPermission?.requestedAt;
      if (requestedAt === undefined) continue;
      const path = this.pendingMeta.get(sessionId)?.transcriptPath;
      if (!path) continue;
      try {
        const s = await stat(path);
        if (s.mtimeMs > requestedAt + skewMs) {
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

export type { Pending, SessionError, SubagentInfo };

// Compute the wire-facing `promptKind` once per mutation so every reader
// sees the same verdict. Kept local so the class body stays focused on
// state transitions.
function finalize(
  partial: Omit<SessionAttention, "promptKind">,
): SessionAttention {
  return { ...partial, promptKind: derivePromptKind(partial) };
}
