import { describe, expect, it } from "vitest";
import {
  summarizeTaskCreate,
  summarizeTaskUpdate,
  summarizeToolUse,
} from "./toolFormat";

describe("summarizeToolUse — TaskCreate", () => {
  it("renders subject as the label and a `new task` badge", () => {
    const s = summarizeToolUse({
      name: "TaskCreate",
      input: {
        subject: "Investigate bug",
        description: "Find root cause and write a failing test",
      },
      hasResult: false,
    });
    expect(s.tone).toBe("task");
    expect(s.label).toBe("+ Investigate bug");
    expect(s.detail).toBe("Find root cause and write a failing test");
    const badgeTexts = (s.badges ?? []).map((b) => b.text);
    expect(badgeTexts).toContain("new task");
  });

  it("includes the canonical id as a badge once the result has arrived", () => {
    const s = summarizeToolUse({
      name: "TaskCreate",
      input: { subject: "Step 1" },
      meta: { kind: "raw", data: { task: { id: "1", subject: "Step 1" } } },
      hasResult: true,
    });
    const badgeTexts = (s.badges ?? []).map((b) => b.text);
    expect(badgeTexts).toContain("#1");
    expect(badgeTexts).toContain("new task");
  });
});

describe("summarizeToolUse — TaskUpdate", () => {
  it("shows the status change as a badge with tone matching the destination", () => {
    const s = summarizeToolUse({
      name: "TaskUpdate",
      input: { taskId: "3", status: "completed" },
      meta: {
        kind: "raw",
        data: {
          success: true,
          taskId: "3",
          updatedFields: ["status"],
          statusChange: { from: "in_progress", to: "completed" },
        },
      },
      hasResult: true,
    });
    expect(s.tone).toBe("task");
    expect(s.label).toBe("Task #3");
    const badge = (s.badges ?? [])[0];
    expect(badge).toBeDefined();
    expect(badge.text).toBe("→ done");
    expect(badge.tone).toBe("good");
  });

  it("uses `info` tone for in_progress, `bad` for deleted, `warn` otherwise", () => {
    const inProgress = summarizeToolUse({
      name: "TaskUpdate",
      input: { taskId: "1", status: "in_progress" },
      meta: {
        kind: "raw",
        data: {
          statusChange: { from: "pending", to: "in_progress" },
        },
      },
      hasResult: true,
    });
    expect(inProgress.badges?.[0].tone).toBe("info");

    const reverted = summarizeToolUse({
      name: "TaskUpdate",
      input: { taskId: "1", status: "pending" },
      meta: {
        kind: "raw",
        data: {
          statusChange: { from: "in_progress", to: "pending" },
        },
      },
      hasResult: true,
    });
    expect(reverted.badges?.[0].tone).toBe("warn");

    const deleted = summarizeToolUse({
      name: "TaskUpdate",
      input: { taskId: "1", status: "deleted" },
      meta: {
        kind: "raw",
        data: {
          statusChange: { from: "completed", to: "deleted" },
        },
      },
      hasResult: true,
    });
    expect(deleted.badges?.[0].tone).toBe("bad");
  });

  it("falls back to the raw status when no statusChange meta is present", () => {
    const s = summarizeToolUse({
      name: "TaskUpdate",
      input: { taskId: "1", status: "completed" },
      hasResult: false,
    });
    expect(s.badges?.[0].text).toBe("done");
  });

  it("renders a subject rename as `#id → new subject`", () => {
    const s = summarizeToolUse({
      name: "TaskUpdate",
      input: { taskId: "7", subject: "Refined subject" },
      hasResult: false,
    });
    expect(s.label).toBe("#7 → Refined subject");
  });

  it("uses the looked-up subject so a status-only update still says what task", () => {
    const s = summarizeToolUse({
      name: "TaskUpdate",
      input: { taskId: "3", status: "completed" },
      meta: {
        kind: "raw",
        data: { statusChange: { from: "in_progress", to: "completed" } },
      },
      hasResult: true,
      taskSubject: "Wire task list panel",
    });
    expect(s.label).toBe("#3 · Wire task list panel");
    expect(s.badges?.[0].text).toBe("→ done");
  });

  it("prefers an input-side rename over the looked-up subject", () => {
    const s = summarizeToolUse({
      name: "TaskUpdate",
      input: { taskId: "3", subject: "New name" },
      hasResult: false,
      taskSubject: "Old name",
    });
    expect(s.label).toBe("#3 → New name");
  });
});

describe("summarizeTaskUpdate — inline row text", () => {
  it("uses the looked-up subject and tones `→ done` for completed", () => {
    const r = summarizeTaskUpdate({
      input: { taskId: "1", status: "completed" },
      meta: {
        kind: "raw",
        data: { statusChange: { from: "in_progress", to: "completed" } },
      },
      taskSubject: "Wire task list panel",
    });
    expect(r.tone).toBe("good");
    expect(r.text).toBe("→ done · Wire task list panel");
  });

  it("falls back to `#id` when no subject is available", () => {
    const r = summarizeTaskUpdate({
      input: { taskId: "1", status: "in_progress" },
      meta: {
        kind: "raw",
        data: { statusChange: { from: "pending", to: "in_progress" } },
      },
    });
    expect(r.tone).toBe("info");
    expect(r.text).toBe("→ doing · #1");
  });

  it("renders deleted as `removed` with bad tone", () => {
    const r = summarizeTaskUpdate({
      input: { taskId: "2", status: "deleted" },
      taskSubject: "Old task",
    });
    expect(r.tone).toBe("bad");
    expect(r.text).toBe("removed · Old task");
  });

  it("renders a pure rename as `renamed · <new>`", () => {
    const r = summarizeTaskUpdate({
      input: { taskId: "1", subject: "New subject" },
      taskSubject: "Old subject",
    });
    expect(r.tone).toBe("info");
    expect(r.text).toBe("renamed · New subject");
  });
});

describe("summarizeTaskCreate — inline row text", () => {
  it("renders the subject after a `+ new · ` prefix", () => {
    const r = summarizeTaskCreate({
      input: { subject: "Research all Claude Code prompts" },
    });
    expect(r.tone).toBe("info");
    expect(r.text).toBe("+ new · Research all Claude Code prompts");
  });

  it("falls back to `task` when no subject is provided", () => {
    const r = summarizeTaskCreate({ input: {} });
    expect(r.text).toBe("+ new · task");
  });
});
