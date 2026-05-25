import { beforeEach, describe, expect, it } from "vitest";
import { HookState } from "./hookState.js";

describe("HookState", () => {
  let state: HookState;

  beforeEach(() => {
    state = new HookState();
  });

  it("returns empty snapshot initially", () => {
    expect(state.snapshot()).toEqual({});
  });

  it("records a Notification as needs-attention", () => {
    const ev = state.record({
      session_id: "s1",
      hook_event_name: "Notification",
      message: "Claude is waiting",
    });
    expect(ev.sessionId).toBe("s1");
    expect(ev.needsAttention).toBe(true);
    expect(ev.lastEvent).toBe("Notification");
    expect(ev.message).toBe("Claude is waiting");
    expect(ev.lastEventAt).toBeGreaterThan(0);
    expect(state.snapshot().s1).toMatchObject({
      needsAttention: true,
      lastEvent: "Notification",
    });
  });

  it("records a Stop as needs-attention", () => {
    const ev = state.record({
      session_id: "s2",
      hook_event_name: "Stop",
    });
    expect(ev.needsAttention).toBe(true);
    expect(ev.lastEvent).toBe("Stop");
  });

  it("ignores events with no session_id", () => {
    expect(() =>
      state.record({ hook_event_name: "Stop" } as never),
    ).toThrow();
  });

  it("clears attention for a session", () => {
    state.record({ session_id: "s1", hook_event_name: "Stop" });
    state.clear("s1");
    expect(state.snapshot().s1.needsAttention).toBe(false);
  });

  it("preserves lastEventAt after clearing", () => {
    const ev = state.record({ session_id: "s1", hook_event_name: "Stop" });
    state.clear("s1");
    expect(state.snapshot().s1.lastEventAt).toBe(ev.lastEventAt);
  });

  it("clearing an unknown session is a no-op", () => {
    expect(() => state.clear("unknown")).not.toThrow();
    expect(state.snapshot()).toEqual({});
  });

  it("overwrites prior event with later one", () => {
    state.record({ session_id: "s1", hook_event_name: "Notification", message: "first" });
    const second = state.record({
      session_id: "s1",
      hook_event_name: "Stop",
    });
    expect(state.snapshot().s1.lastEvent).toBe("Stop");
    expect(state.snapshot().s1.message).toBeUndefined();
    expect(second.lastEventAt).toBeGreaterThanOrEqual(
      state.snapshot().s1.lastEventAt,
    );
  });

  it("passes through notification_type as notificationType", () => {
    const ev = state.record({
      session_id: "s1",
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use Bash",
    });
    expect(ev.notificationType).toBe("permission_prompt");
    expect(ev.needsAttention).toBe(true);
    expect(state.snapshot().s1.notificationType).toBe("permission_prompt");
  });

  it.each([
    "auth_success",
    "elicitation_complete",
    "elicitation_response",
  ])(
    "treats %s as informational — recorded but not needs-attention",
    (type) => {
      const ev = state.record({
        session_id: "s1",
        hook_event_name: "Notification",
        notification_type: type,
      });
      expect(ev.needsAttention).toBe(false);
      expect(ev.notificationType).toBe(type);
      expect(state.snapshot().s1.needsAttention).toBe(false);
    },
  );

  it("treats unknown notification_type as needs-attention (back-compat)", () => {
    const ev = state.record({
      session_id: "s1",
      hook_event_name: "Notification",
      notification_type: "some_future_type",
    });
    expect(ev.needsAttention).toBe(true);
    expect(ev.notificationType).toBe("some_future_type");
  });

  describe("PermissionRequest", () => {
    it("captures tool_name + tool_input as pendingPermission", () => {
      const ev = state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      });
      expect(ev.needsAttention).toBe(true);
      expect(ev.lastEvent).toBe("PermissionRequest");
      expect(ev.pendingPermission).toMatchObject({
        toolName: "Bash",
        toolInput: { command: "npm test" },
      });
      expect(ev.pendingPermission?.requestedAt).toBeGreaterThan(0);
    });

    it("preserves pendingPermission when Notification arrives after", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Edit",
        tool_input: { file_path: "/x.ts" },
      });
      state.record({
        session_id: "s1",
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        message: "Claude needs your permission to use Edit",
      });
      const snap = state.snapshot().s1;
      expect(snap.pendingPermission?.toolName).toBe("Edit");
      expect(snap.notificationType).toBe("permission_prompt");
      expect(snap.lastEvent).toBe("Notification");
    });

    it("replaces pendingPermission on a new PermissionRequest", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com" },
      });
      const snap = state.snapshot().s1;
      expect(snap.pendingPermission?.toolName).toBe("WebFetch");
      expect(snap.pendingPermission?.toolInput).toEqual({
        url: "https://example.com",
      });
    });

    it("clear() drops pendingPermission alongside needsAttention", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      });
      state.clear("s1");
      const snap = state.snapshot().s1;
      expect(snap.needsAttention).toBe(false);
      expect(snap.pendingPermission).toBeUndefined();
    });
  });
});
