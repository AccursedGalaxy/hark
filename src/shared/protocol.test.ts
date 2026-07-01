import { describe, expect, it } from "vitest";
import {
  deriveAttentionKind,
  derivePromptKind,
  deriveState,
  type RawSession,
} from "./protocol.js";

function baseSession(overrides: Partial<RawSession> = {}): RawSession {
  return {
    pid: 1,
    sessionId: "s1",
    cwd: "/tmp",
    startedAt: 0,
    updatedAt: 0,
    version: "0.0.0",
    kind: "interactive",
    hasTmuxPane: true,
    ...overrides,
  };
}

describe("deriveState", () => {
  it("needsAttention always wins", () => {
    expect(
      deriveState(baseSession({ status: "busy", needsAttention: true })),
    ).toBe("wait");
  });

  it("status='busy' → 'busy'", () => {
    expect(deriveState(baseSession({ status: "busy" }))).toBe("busy");
  });

  it("status='idle' → 'idle'", () => {
    expect(deriveState(baseSession({ status: "idle" }))).toBe("idle");
  });

  it("status='waiting' with a real pending prompt → 'wait'", () => {
    expect(
      deriveState(
        baseSession({
          status: "waiting",
          pending: {
            kind: "oauth",
            message: "Authorize on desktop",
            requestedAt: 1,
          },
        }),
      ),
    ).toBe("wait");
  });

  it("status='waiting' alone → 'idle' (stale 'waiting' the user already answered in the TUI)", () => {
    // Claude Code writes status='waiting' to session.json when it prompts,
    // but if the user answers directly in the TUI, that field can sit stale.
    // Without a backing pending payload, treat it as idle so the rail's
    // ASKING pill doesn't get stuck.
    expect(deriveState(baseSession({ status: "waiting" }))).toBe("idle");
  });

  it("unknown status string → 'idle' (not 'dead')", () => {
    // Forward-compat: a future Claude Code value must not flash OFFLINE.
    expect(deriveState(baseSession({ status: "some_new_status" }))).toBe(
      "idle",
    );
  });

  it("missing status → 'dead' (legacy synthesized rows only)", () => {
    expect(deriveState(baseSession({ status: undefined }))).toBe("dead");
  });
});

describe("derivePromptKind", () => {
  it("returns null when nothing has happened yet", () => {
    expect(derivePromptKind(undefined)).toBe(null);
  });

  it("returns null when the session no longer needs attention", () => {
    expect(
      derivePromptKind({
        needsAttention: false,
        lastEvent: "Stop",
      }),
    ).toBe(null);
  });

  // ---- New discriminated `pending` paths ---------------------------------

  it("pending.kind 'tool_permission' → 'permission'", () => {
    expect(
      derivePromptKind({
        needsAttention: true,
        lastEvent: "PermissionRequest",
        pending: {
          kind: "tool_permission",
          toolName: "Bash",
          toolInput: {},
          requestedAt: 1,
        },
      }),
    ).toBe("permission");
  });

  it("pending.kind 'ask_user_question' → 'permission'", () => {
    expect(
      derivePromptKind({
        needsAttention: true,
        lastEvent: "PermissionRequest",
        pending: {
          kind: "ask_user_question",
          questions: [],
          requestedAt: 1,
        },
      }),
    ).toBe("permission");
  });

  it("pending.kind 'exit_plan_mode' → 'permission'", () => {
    expect(
      derivePromptKind({
        needsAttention: true,
        lastEvent: "PermissionRequest",
        pending: {
          kind: "exit_plan_mode",
          plan: "# plan",
          requestedAt: 1,
        },
      }),
    ).toBe("permission");
  });

  it("pending.kind 'elicitation' → 'elicitation'", () => {
    expect(
      derivePromptKind({
        needsAttention: true,
        lastEvent: "Elicitation",
        pending: {
          kind: "elicitation",
          serverName: "github",
          fields: [],
          requestedAt: 1,
        },
      }),
    ).toBe("elicitation");
  });

  it("pending wins over a stale notificationType from a previous event", () => {
    expect(
      derivePromptKind({
        needsAttention: true,
        lastEvent: "PermissionRequest",
        notificationType: "auth_success",
        pending: {
          kind: "tool_permission",
          toolName: "Bash",
          toolInput: {},
          requestedAt: 1,
        },
      }),
    ).toBe("permission");
  });

  // ---- Legacy paths (no `pending`) — back-compat -------------------------

  it("legacy pendingPermission still maps to 'permission'", () => {
    expect(
      derivePromptKind({
        needsAttention: true,
        lastEvent: "PermissionRequest",
        pendingPermission: {
          toolName: "Bash",
          toolInput: {},
          requestedAt: 1,
        },
      }),
    ).toBe("permission");
  });

  it("Notification(permission_prompt) maps to 'permission'", () => {
    expect(
      derivePromptKind({
        needsAttention: true,
        lastEvent: "Notification",
        notificationType: "permission_prompt",
      }),
    ).toBe("permission");
  });

  it("Notification(elicitation_dialog) maps to 'elicitation'", () => {
    expect(
      derivePromptKind({
        needsAttention: true,
        lastEvent: "Notification",
        notificationType: "elicitation_dialog",
      }),
    ).toBe("elicitation");
  });

  it("Notification(idle_prompt) maps to 'idle'", () => {
    expect(
      derivePromptKind({
        needsAttention: true,
        lastEvent: "Notification",
        notificationType: "idle_prompt",
      }),
    ).toBe("idle");
  });

  it("informational Notifications map to null (caller already cleared needsAttention)", () => {
    expect(
      derivePromptKind({
        needsAttention: false,
        lastEvent: "Notification",
        notificationType: "auth_success",
      }),
    ).toBe(null);
  });
});

describe("deriveAttentionKind", () => {
  it("returns null for no state / no attention", () => {
    expect(deriveAttentionKind(undefined)).toBe(null);
    // The kind mirrors the boolean: even with a pending prompt alive
    // (viewed-but-unanswered), a cleared needsAttention means no ambient
    // signal.
    expect(
      deriveAttentionKind({
        needsAttention: false,
        lastEvent: "PermissionRequest",
        pending: {
          kind: "tool_permission",
          toolName: "Bash",
          toolInput: {},
          requestedAt: 1,
        },
      }),
    ).toBe(null);
  });

  it("a live pending decision → 'blocking' regardless of the last event", () => {
    expect(
      deriveAttentionKind({
        needsAttention: true,
        lastEvent: "SubagentStart",
        pending: {
          kind: "ask_user_question",
          questions: [],
          requestedAt: 1,
        },
      }),
    ).toBe("blocking");
  });

  it("legacy pendingPermission alone → 'blocking'", () => {
    expect(
      deriveAttentionKind({
        needsAttention: true,
        lastEvent: "PermissionRequest",
        pendingPermission: { toolName: "Bash", toolInput: {}, requestedAt: 1 },
      }),
    ).toBe("blocking");
  });

  it("Notification(permission_prompt / elicitation_dialog) → 'blocking'", () => {
    for (const notificationType of [
      "permission_prompt",
      "elicitation_dialog",
    ]) {
      expect(
        deriveAttentionKind({
          needsAttention: true,
          lastEvent: "Notification",
          notificationType,
        }),
      ).toBe("blocking");
    }
  });

  it("lastError → 'error'; blocking still dominates when both are present", () => {
    expect(
      deriveAttentionKind({
        needsAttention: true,
        lastEvent: "Notification",
        notificationType: "idle_prompt",
        lastError: { errorType: "rate_limit", errorMessage: "", occurredAt: 1 },
      }),
    ).toBe("error");
    expect(
      deriveAttentionKind({
        needsAttention: true,
        lastEvent: "PermissionRequest",
        pending: {
          kind: "tool_permission",
          toolName: "Bash",
          toolInput: {},
          requestedAt: 1,
        },
        lastError: { errorType: "rate_limit", errorMessage: "", occurredAt: 1 },
      }),
    ).toBe("blocking");
  });

  it("unknown notification types → 'idle', never 'blocking' (unlike promptKind's permission default)", () => {
    expect(
      deriveAttentionKind({
        needsAttention: true,
        lastEvent: "Notification",
        notificationType: "some_future_type",
      }),
    ).toBe("idle");
  });

  it("Stop / idle_prompt → 'idle'", () => {
    expect(
      deriveAttentionKind({ needsAttention: true, lastEvent: "Stop" }),
    ).toBe("idle");
    expect(
      deriveAttentionKind({
        needsAttention: true,
        lastEvent: "Notification",
        notificationType: "idle_prompt",
      }),
    ).toBe("idle");
  });
});
