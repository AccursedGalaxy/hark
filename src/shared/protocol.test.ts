import { describe, expect, it } from "vitest";
import { derivePromptKind } from "./protocol.js";

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
