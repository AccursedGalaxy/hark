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

  describe("dismissAttention", () => {
    it("drops needsAttention but preserves the pending prompt", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{ question: "?", options: [{ label: "a" }] }],
        },
      });
      const out = state.dismissAttention("s1");
      expect(out).not.toBeNull();
      expect(out!.needsAttention).toBe(false);
      // The form data must survive — viewing != answering.
      expect(out!.pending?.kind).toBe("ask_user_question");
      // promptKind also survives because pending is intact.
      expect(out!.promptKind).toBe("permission");
    });

    it("returns the existing snapshot unchanged when needsAttention is already false", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "Notification",
        notification_type: "auth_success",
      });
      const before = state.snapshot().s1;
      const out = state.dismissAttention("s1");
      expect(out).toEqual(before);
    });

    it("returns null for an unknown session", () => {
      expect(state.dismissAttention("nope")).toBeNull();
    });
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

    // ---- transcript-origin pending (AskUserQuestion / ExitPlanMode) -------
    // Claude Code does not fire PermissionRequest hooks for these two tools
    // (issue #33625); the only outside-the-TUI signal is the tool_use block
    // landing in the JSONL.

    it("promotes AskUserQuestion tool_use into pending(ask_user_question)", () => {
      const questions = [
        {
          question: "Pick one",
          header: "Choice",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: false,
        },
      ];
      const broadcast = state.noteTranscriptEvents("s1", [
        {
          kind: "assistant",
          uuid: "a1",
          ts: "2026-05-25T16:18:16.751Z",
          blocks: [
            {
              type: "tool_use",
              id: "use-ask-1",
              name: "AskUserQuestion",
              input: { questions },
            },
          ],
        },
      ]);
      expect(broadcast).not.toBe(null);
      expect(broadcast!.pending?.kind).toBe("ask_user_question");
      if (broadcast!.pending?.kind !== "ask_user_question")
        throw new Error("kind");
      expect(broadcast!.pending.questions).toEqual(questions);
      expect(broadcast!.pending.toolUseId).toBe("use-ask-1");
      expect(broadcast!.needsAttention).toBe(true);
      expect(broadcast!.promptKind).toBe("permission");
    });

    it("promotes ExitPlanMode tool_use into pending(exit_plan_mode)", () => {
      const broadcast = state.noteTranscriptEvents("s1", [
        {
          kind: "assistant",
          uuid: "a1",
          ts: "2026-05-25T16:18:16.751Z",
          blocks: [
            {
              type: "tool_use",
              id: "use-plan-1",
              name: "ExitPlanMode",
              input: { plan: "# Plan\n- step" },
            },
          ],
        },
      ]);
      expect(broadcast).not.toBe(null);
      expect(broadcast!.pending?.kind).toBe("exit_plan_mode");
      if (broadcast!.pending?.kind !== "exit_plan_mode")
        throw new Error("kind");
      expect(broadcast!.pending.plan).toContain("step");
      expect(broadcast!.pending.toolUseId).toBe("use-plan-1");
    });

    it("does not promote a second time when the same tool_use is replayed", () => {
      const block = {
        type: "tool_use" as const,
        id: "use-ask-1",
        name: "AskUserQuestion",
        input: { questions: [] },
      };
      const ev: TranscriptEvent = {
        kind: "assistant",
        uuid: "a1",
        ts: "2026-05-25T16:18:16.751Z",
        blocks: [block],
      };
      const first = state.noteTranscriptEvents("s1", [ev]);
      expect(first).not.toBe(null);
      const requestedAt = state.snapshot().s1.pending!.requestedAt;
      const second = state.noteTranscriptEvents("s1", [ev]);
      // Idempotent — same toolUseId, no churn.
      expect(second).toBe(null);
      expect(state.snapshot().s1.pending!.requestedAt).toBe(requestedAt);
    });

    it("clears transcript-origin pending only on a matching tool_result", () => {
      // Promote pending.
      state.noteTranscriptEvents("s1", [
        {
          kind: "assistant",
          uuid: "a1",
          ts: "2026-05-25T16:18:16.751Z",
          blocks: [
            {
              type: "tool_use",
              id: "use-ask-1",
              name: "AskUserQuestion",
              input: { questions: [] },
            },
          ],
        },
      ]);
      // A *newer* unrelated transcript event must NOT clear it (the time-
      // based heuristic only applies to hook-originated pendings).
      const unrelated = state.noteTranscriptEvents("s1", [
        userEvent("2026-05-25T16:19:00.000Z"),
      ]);
      expect(unrelated).toBe(null);
      expect(state.snapshot().s1.pending).toBeDefined();
      // A matching tool_result clears it.
      const broadcast = state.noteTranscriptEvents("s1", [
        {
          kind: "tool_result",
          uuid: "r1",
          ts: "2026-05-25T16:20:00.000Z",
          toolUseId: "use-ask-1",
          output: "answered",
          isError: false,
        },
      ]);
      expect(broadcast).not.toBe(null);
      expect(broadcast!.pending).toBeUndefined();
      expect(broadcast!.needsAttention).toBe(false);
    });

    it("a non-matching tool_result leaves the transcript-origin pending in place", () => {
      state.noteTranscriptEvents("s1", [
        {
          kind: "assistant",
          uuid: "a1",
          ts: "2026-05-25T16:18:16.751Z",
          blocks: [
            {
              type: "tool_use",
              id: "use-ask-1",
              name: "AskUserQuestion",
              input: { questions: [] },
            },
          ],
        },
      ]);
      const out = state.noteTranscriptEvents("s1", [
        {
          kind: "tool_result",
          uuid: "r1",
          ts: "2026-05-25T16:19:00.000Z",
          toolUseId: "use-other",
          output: "x",
          isError: false,
        },
      ]);
      expect(out).toBe(null);
      expect(state.snapshot().s1.pending).toBeDefined();
    });

    it("promote+resolve in the same batch collapses to no pending", () => {
      const out = state.noteTranscriptEvents("s1", [
        {
          kind: "assistant",
          uuid: "a1",
          ts: "2026-05-25T16:18:16.751Z",
          blocks: [
            {
              type: "tool_use",
              id: "use-ask-1",
              name: "AskUserQuestion",
              input: { questions: [] },
            },
          ],
        },
        {
          kind: "tool_result",
          uuid: "r1",
          ts: "2026-05-25T16:20:00.000Z",
          toolUseId: "use-ask-1",
          output: "answered",
          isError: false,
        },
      ]);
      expect(out).not.toBe(null);
      expect(out!.pending).toBeUndefined();
      expect(state.snapshot().s1.pending).toBeUndefined();
    });

    it("ignores tool_use for non-blocking tools", () => {
      const out = state.noteTranscriptEvents("s1", [
        {
          kind: "assistant",
          uuid: "a1",
          ts: "2026-05-25T16:18:16.751Z",
          blocks: [
            {
              type: "tool_use",
              id: "use-bash-1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      ]);
      expect(out).toBe(null);
      expect(state.snapshot().s1).toBeUndefined();
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

  // ---- NEW: discriminated `pending` for AskUserQuestion / plan / etc. ---

  describe("pending discriminated union", () => {
    it("Bash PermissionRequest → pending.kind 'tool_permission'", () => {
      const ev = state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "use-1",
      });
      expect(ev.pending?.kind).toBe("tool_permission");
      if (ev.pending?.kind !== "tool_permission") throw new Error("kind");
      expect(ev.pending.toolName).toBe("Bash");
      expect(ev.pending.toolUseId).toBe("use-1");
      // Legacy field still set for back-compat with old clients.
      expect(ev.pendingPermission?.toolName).toBe("Bash");
    });

    it("AskUserQuestion PermissionRequest → pending.kind 'ask_user_question' with questions", () => {
      const questions = [
        {
          question: "How should I format?",
          header: "Format",
          options: [{ label: "Summary" }, { label: "Detailed" }],
          multiSelect: false,
        },
      ];
      const ev = state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "AskUserQuestion",
        tool_input: { questions },
      });
      expect(ev.pending?.kind).toBe("ask_user_question");
      if (ev.pending?.kind !== "ask_user_question") throw new Error("kind");
      expect(ev.pending.questions).toHaveLength(1);
      expect(ev.pending.questions[0].header).toBe("Format");
      // No legacy mirror — only tool_permission variants set pendingPermission.
      expect(ev.pendingPermission).toBeUndefined();
      // promptKind stays "permission" — covers all blocking variants.
      expect(ev.promptKind).toBe("permission");
    });

    it("ExitPlanMode PermissionRequest → pending.kind 'exit_plan_mode' with plan", () => {
      const ev = state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "# Plan\n- Step one\n- Step two" },
      });
      expect(ev.pending?.kind).toBe("exit_plan_mode");
      if (ev.pending?.kind !== "exit_plan_mode") throw new Error("kind");
      expect(ev.pending.plan).toContain("Step one");
    });

    it("AskUserQuestion with malformed tool_input still yields an empty questions array", () => {
      const ev = state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "AskUserQuestion",
        tool_input: { questions: "not-an-array" },
      });
      expect(ev.pending?.kind).toBe("ask_user_question");
      if (ev.pending?.kind !== "ask_user_question") throw new Error("kind");
      expect(ev.pending.questions).toEqual([]);
    });

    it("Stop after PermissionRequest drops pending union as well as legacy field", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{ question: "?", options: [{ label: "a" }] }],
        },
      });
      const ev = state.record({ session_id: "s1", hook_event_name: "Stop" });
      expect(ev.pending).toBeUndefined();
      expect(ev.pendingPermission).toBeUndefined();
      expect(ev.promptKind).toBe(null);
    });

    it("transcript-based resolver also clears pending union state", async () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{ question: "?", options: [{ label: "a" }] }],
        },
        transcript_path: "/tmp/sess.jsonl",
      });
      const requestedAt = state.snapshot().s1.pending!.requestedAt;
      const out = await state.resolveStaleFromTranscripts(async () => ({
        mtimeMs: requestedAt + 1000,
      }));
      expect(out).toHaveLength(1);
      expect(state.snapshot().s1.pending).toBeUndefined();
    });
  });

  // ---- NEW: Elicitation hook --------------------------------------------

  describe("Elicitation", () => {
    it("records form fields as pending.kind 'elicitation' with normalized fields", () => {
      const ev = state.record({
        session_id: "s1",
        hook_event_name: "Elicitation",
        server_name: "github",
        message: "Pick a repo",
        form_fields: [
          { name: "repo", type: "string", required: true },
          {
            name: "visibility",
            type: "enum",
            options: ["public", "private"],
            required: false,
          },
          // malformed entry — must be skipped, not thrown
          { type: "string" },
          "garbage",
        ],
      });
      expect(ev.pending?.kind).toBe("elicitation");
      if (ev.pending?.kind !== "elicitation") throw new Error("kind");
      expect(ev.pending.serverName).toBe("github");
      expect(ev.pending.fields).toHaveLength(2);
      expect(ev.pending.fields[0]).toMatchObject({
        name: "repo",
        type: "string",
        required: true,
      });
      expect(ev.pending.fields[1]).toMatchObject({
        name: "visibility",
        type: "enum",
        options: ["public", "private"],
      });
      expect(ev.promptKind).toBe("elicitation");
    });

    it("ElicitationResult clears pending state without raising needsAttention", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "Elicitation",
        server_name: "github",
        form_fields: [{ name: "repo", type: "string" }],
      });
      const ev = state.record({
        session_id: "s1",
        hook_event_name: "ElicitationResult",
      });
      expect(ev.needsAttention).toBe(false);
      expect(ev.pending).toBeUndefined();
    });
  });

  // ---- NEW: StopFailure --------------------------------------------------

  describe("StopFailure", () => {
    it("records lastError with type + message; drops any prior pending", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      const ev = state.record({
        session_id: "s1",
        hook_event_name: "StopFailure",
        error_type: "rate_limit",
        error_message: "Try again in 30s",
      });
      expect(ev.lastError).toEqual(
        expect.objectContaining({
          errorType: "rate_limit",
          errorMessage: "Try again in 30s",
        }),
      );
      expect(ev.pending).toBeUndefined();
      expect(ev.pendingPermission).toBeUndefined();
      expect(ev.needsAttention).toBe(true);
    });

    it("clear() also drops lastError", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "StopFailure",
        error_type: "server_error",
        error_message: "x",
      });
      state.clear("s1");
      expect(state.snapshot().s1.lastError).toBeUndefined();
    });

    it("clean Stop clears any stale lastError", () => {
      state.record({
        session_id: "s1",
        hook_event_name: "StopFailure",
        error_type: "server_error",
        error_message: "boom",
      });
      const ev = state.record({ session_id: "s1", hook_event_name: "Stop" });
      expect(ev.lastError).toBeUndefined();
    });
  });

  // ---- NEW: Subagent activity -------------------------------------------

  describe("subagent tracking", () => {
    it("SubagentStart adds an entry; SubagentStop removes it; neither marks needs-attention", () => {
      const a = state.record({
        session_id: "s1",
        hook_event_name: "SubagentStart",
        agent_id: "sub-1",
        agent_type: "general-purpose",
      });
      expect(a.subagents).toHaveLength(1);
      expect(a.subagents?.[0]).toMatchObject({
        agentId: "sub-1",
        agentType: "general-purpose",
      });
      expect(a.needsAttention).toBe(false);

      const b = state.record({
        session_id: "s1",
        hook_event_name: "SubagentStart",
        agent_id: "sub-2",
        agent_type: "explore",
      });
      expect(b.subagents).toHaveLength(2);

      const c = state.record({
        session_id: "s1",
        hook_event_name: "SubagentStop",
        agent_id: "sub-1",
      });
      expect(c.subagents).toHaveLength(1);
      expect(c.subagents?.[0].agentId).toBe("sub-2");
    });
  });

  // ---- NEW: CwdChanged ---------------------------------------------------

  describe("CwdChanged", () => {
    it("updates the cached cwd without raising needs-attention", () => {
      const ev = state.record({
        session_id: "s1",
        hook_event_name: "CwdChanged",
        cwd: "/new/dir",
        previous_cwd: "/old/dir",
      });
      expect(ev.cwd).toBe("/new/dir");
      expect(ev.needsAttention).toBe(false);
    });
  });
});
