import { beforeEach, describe, expect, it } from "vitest";
import { PromptState } from "./promptState.js";
import type { TranscriptEvent } from "../shared/protocol.js";

function userEvent(ts: string, text = "hello"): TranscriptEvent {
  return { kind: "user", uuid: "u1", ts, text };
}

describe("PromptState", () => {
  let state: PromptState;

  beforeEach(() => {
    state = new PromptState();
  });

  it("returns empty snapshot initially", () => {
    expect(state.snapshot()).toEqual({});
  });

  // ---- Existing hook recording semantics (was HookState) ----

  it("records a Notification as needs-attention with promptKind from notificationType", () => {
    const ev = state.record({
      session_id: "s1",
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Claude is waiting",
    });
    expect(ev.sessionId).toBe("s1");
    expect(ev.needsAttention).toBe(true);
    expect(ev.lastEvent).toBe("Notification");
    expect(ev.message).toBe("Claude is waiting");
    expect(ev.promptKind).toBe("permission");
    expect(state.snapshot().s1).toMatchObject({
      needsAttention: true,
      promptKind: "permission",
    });
  });

  it("records a bare Notification (no type) as needs-attention with permission promptKind", () => {
    // Older Claude Code emits Notification with no notification_type. Treat
    // as permission so the user still gets Approve/Deny (back-compat).
    const ev = state.record({
      session_id: "s1",
      hook_event_name: "Notification",
      message: "Claude is waiting",
    });
    expect(ev.needsAttention).toBe(true);
    expect(ev.promptKind).toBe("permission");
  });

  it("Stop hook marks needs-attention but promptKind is null", () => {
    const ev = state.record({
      session_id: "s1",
      hook_event_name: "Stop",
    });
    expect(ev.needsAttention).toBe(true);
    expect(ev.promptKind).toBe(null);
  });

  it("throws on missing session_id", () => {
    expect(() =>
      state.record({ hook_event_name: "Stop" } as never),
    ).toThrow();
  });

  it("clear() drops needs-attention and pending permission and resets promptKind", () => {
    state.record({
      session_id: "s1",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    state.clear("s1");
    const snap = state.snapshot().s1;
    expect(snap.needsAttention).toBe(false);
    expect(snap.pendingPermission).toBeUndefined();
    expect(snap.promptKind).toBe(null);
  });

  it("clearing an unknown session is a no-op", () => {
    expect(() => state.clear("unknown")).not.toThrow();
    expect(state.snapshot()).toEqual({});
  });

  it("informational notification types record without needs-attention and with null promptKind", () => {
    for (const type of ["auth_success", "elicitation_complete", "elicitation_response"]) {
      const fresh = new PromptState();
      const ev = fresh.record({
        session_id: "s1",
        hook_event_name: "Notification",
        notification_type: type,
      });
      expect(ev.needsAttention).toBe(false);
      expect(ev.promptKind).toBe(null);
    }
  });

  it("unknown notification_type falls back to needs-attention with permission promptKind", () => {
    const ev = state.record({
      session_id: "s1",
      hook_event_name: "Notification",
      notification_type: "some_future_type",
    });
    expect(ev.needsAttention).toBe(true);
    expect(ev.promptKind).toBe("permission");
  });

  it("elicitation_dialog → promptKind 'elicitation'", () => {
    const ev = state.record({
      session_id: "s1",
      hook_event_name: "Notification",
      notification_type: "elicitation_dialog",
    });
    expect(ev.promptKind).toBe("elicitation");
  });

  it("idle_prompt → promptKind 'idle' and drops any prior pendingPermission", () => {
    state.record({
      session_id: "s1",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const ev = state.record({
      session_id: "s1",
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
    });
    expect(ev.promptKind).toBe("idle");
    expect(ev.pendingPermission).toBeUndefined();
  });

  it("Stop after PermissionRequest drops pendingPermission and promptKind", () => {
    state.record({
      session_id: "s1",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    const ev = state.record({ session_id: "s1", hook_event_name: "Stop" });
    expect(ev.pendingPermission).toBeUndefined();
    expect(ev.promptKind).toBe(null);
  });

  it("PermissionRequest preserves pendingPermission across follow-up Notification(permission_prompt)", () => {
    state.record({
      session_id: "s1",
      hook_event_name: "PermissionRequest",
      tool_name: "Edit",
      tool_input: { file_path: "/x.ts" },
    });
    const ev = state.record({
      session_id: "s1",
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    });
    expect(ev.pendingPermission?.toolName).toBe("Edit");
    expect(ev.promptKind).toBe("permission");
  });

  it("captures transcript_path for the resolver, off the wire", () => {
    const ev = state.record({
      session_id: "s1",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      transcript_path: "/tmp/sess.jsonl",
    });
    expect((ev.pendingPermission as Record<string, unknown>).transcriptPath).toBeUndefined();
    expect(state.pendingTranscriptPath("s1")).toBe("/tmp/sess.jsonl");
  });

  // ---- NEW: noteTranscriptEvents ----

  describe("noteTranscriptEvents", () => {
    it("returns null when no pending permission exists", () => {
      const broadcast = state.noteTranscriptEvents("s1", [
        userEvent("2026-05-25T00:00:00Z"),
      ]);
      expect(broadcast).toBe(null);
    });

    it("returns null when events are empty", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      const broadcast = state.noteTranscriptEvents("s1", []);
      expect(broadcast).toBe(null);
    });

    it("returns null when no event is newer than requestedAt", () => {
      // Stamp an older event before recording the permission.
      const oldTs = new Date(Date.now() - 60_000).toISOString();
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      const broadcast = state.noteTranscriptEvents("s1", [userEvent(oldTs)]);
      expect(broadcast).toBe(null);
      expect(state.snapshot().s1.pendingPermission).toBeDefined();
    });

    it("resolves pending permission when a transcript event is newer than requestedAt", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      const futureTs = new Date(Date.now() + 60_000).toISOString();
      const broadcast = state.noteTranscriptEvents("s1", [userEvent(futureTs)]);
      expect(broadcast).not.toBe(null);
      expect(broadcast!.needsAttention).toBe(false);
      expect(broadcast!.pendingPermission).toBeUndefined();
      expect(broadcast!.promptKind).toBe(null);
      expect(broadcast!.sessionId).toBe("s1");
    });

    it("ignores events with unparseable timestamps", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      const broadcast = state.noteTranscriptEvents("s1", [
        { kind: "user", uuid: "u1", ts: "not-a-date", text: "x" },
      ]);
      expect(broadcast).toBe(null);
      expect(state.snapshot().s1.pendingPermission).toBeDefined();
    });
  });

  // ---- NEW: noteSendKeys ----

  describe("noteSendKeys", () => {
    it("returns null when there is no state to clear", () => {
      expect(state.noteSendKeys("s1")).toBe(null);
    });

    it("returns null when state is already clean (no attention, no pending)", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "Notification",
        notification_type: "auth_success",
      });
      expect(state.noteSendKeys("s1")).toBe(null);
    });

    it("clears needs-attention and pending and returns a broadcast", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      const broadcast = state.noteSendKeys("s1");
      expect(broadcast).not.toBe(null);
      expect(broadcast!.needsAttention).toBe(false);
      expect(broadcast!.pendingPermission).toBeUndefined();
      expect(broadcast!.promptKind).toBe(null);
    });

    it("clears stale pendingPermission even when needsAttention already false", () => {
      // Mimic PermissionRequest then Notification(auth_success) — pending
      // persists, needsAttention flipped false by auth_success. The send-
      // keys path still needs to drop the pendingPermission.
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      state.record({
        session_id: "s1",
        hook_event_name: "Notification",
        notification_type: "auth_success",
      });
      const broadcast = state.noteSendKeys("s1");
      expect(broadcast).not.toBe(null);
      expect(broadcast!.pendingPermission).toBeUndefined();
    });
  });

  // ---- NEW: resolveStaleFromTranscripts ----

  describe("resolveStaleFromTranscripts", () => {
    it("returns empty list when nothing is pending", async () => {
      const out = await state.resolveStaleFromTranscripts(async () => ({
        mtimeMs: Date.now(),
      }));
      expect(out).toEqual([]);
    });

    it("skips sessions whose pending permission has no transcript path", async () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      const calls: string[] = [];
      const out = await state.resolveStaleFromTranscripts(async (p) => {
        calls.push(p);
        return { mtimeMs: Date.now() + 60_000 };
      });
      expect(out).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("resolves pending when transcript mtime exceeds requestedAt + skew", async () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        transcript_path: "/tmp/sess.jsonl",
      });
      const requestedAt = state.snapshot().s1.pendingPermission!.requestedAt;
      const out = await state.resolveStaleFromTranscripts(async (p) => {
        expect(p).toBe("/tmp/sess.jsonl");
        return { mtimeMs: requestedAt + 1000 };
      });
      expect(out).toHaveLength(1);
      expect(out[0].sessionId).toBe("s1");
      expect(out[0].promptKind).toBe(null);
      expect(out[0].pendingPermission).toBeUndefined();
      // Snapshot reflects the resolution.
      expect(state.snapshot().s1.pendingPermission).toBeUndefined();
    });

    it("respects skew so co-incident writes don't self-resolve", async () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        transcript_path: "/tmp/sess.jsonl",
      });
      const requestedAt = state.snapshot().s1.pendingPermission!.requestedAt;
      const out = await state.resolveStaleFromTranscripts(async () => ({
        mtimeMs: requestedAt, // exactly equal, within skew
      }));
      expect(out).toEqual([]);
      expect(state.snapshot().s1.pendingPermission).toBeDefined();
    });

    it("swallows stat errors per-session", async () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        transcript_path: "/tmp/sess.jsonl",
      });
      const out = await state.resolveStaleFromTranscripts(async () => {
        throw new Error("ENOENT");
      });
      expect(out).toEqual([]);
      expect(state.snapshot().s1.pendingPermission).toBeDefined();
    });
  });
});
