import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "./protocol";
import { reduceTaskState, summarizeState } from "./taskState";

function assistant(
  uuid: string,
  ts: string,
  ...blocks: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >
): TranscriptEvent {
  return { kind: "assistant", uuid, ts, blocks };
}

function createResult(
  toolUseId: string,
  ts: string,
  id: string,
  subject: string,
): TranscriptEvent {
  return {
    kind: "tool_result",
    uuid: `r-${toolUseId}`,
    ts,
    toolUseId,
    toolName: "TaskCreate",
    output: JSON.stringify({ task: { id, subject } }),
    isError: false,
    meta: { kind: "raw", data: { task: { id, subject } } },
  };
}

function updateResult(
  toolUseId: string,
  ts: string,
  taskId: string,
  from: string,
  to: string,
): TranscriptEvent {
  return {
    kind: "tool_result",
    uuid: `r-${toolUseId}`,
    ts,
    toolUseId,
    toolName: "TaskUpdate",
    output: "ok",
    isError: false,
    meta: {
      kind: "raw",
      data: {
        success: true,
        taskId,
        updatedFields: ["status"],
        statusChange: { from, to },
      },
    },
  };
}

describe("reduceTaskState", () => {
  it("returns the empty state for an empty stream", () => {
    expect(reduceTaskState([])).toEqual({
      tasks: [],
      counts: { total: 0, pending: 0, inProgress: 0, completed: 0 },
      hasEverHadTasks: false,
    });
  });

  it("ignores transcripts that contain no Task* tool_use", () => {
    const events: TranscriptEvent[] = [
      { kind: "user", uuid: "u1", ts: "t1", text: "hi" },
      assistant("a1", "t2", { type: "text", text: "hello" }),
    ];
    const s = reduceTaskState(events);
    expect(s.hasEverHadTasks).toBe(false);
    expect(s.tasks).toEqual([]);
  });

  it("adds a TaskCreate using the id from its tool_result", () => {
    const events: TranscriptEvent[] = [
      assistant("a1", "t1", {
        type: "tool_use",
        id: "tu1",
        name: "TaskCreate",
        input: {
          subject: "Investigate bug",
          description: "Find the root cause",
          activeForm: "Investigating bug",
        },
      }),
      createResult("tu1", "t1", "1", "Investigate bug"),
    ];
    const s = reduceTaskState(events);
    expect(s.tasks).toEqual([
      {
        id: "1",
        subject: "Investigate bug",
        description: "Find the root cause",
        activeForm: "Investigating bug",
        status: "pending",
        updatedAt: "t1",
      },
    ]);
    expect(s.counts).toEqual({
      total: 1,
      pending: 1,
      inProgress: 0,
      completed: 0,
    });
    expect(s.hasEverHadTasks).toBe(true);
  });

  it("synthesises a pending id when the create's tool_result hasn't arrived", () => {
    // Streaming case: the create block is in the transcript but the
    // tool_result row hasn't been emitted yet. The row should still appear
    // so the user sees the new task immediately.
    const events: TranscriptEvent[] = [
      assistant("a1", "t1", {
        type: "tool_use",
        id: "tu1",
        name: "TaskCreate",
        input: { subject: "Streaming task" },
      }),
    ];
    const s = reduceTaskState(events);
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0].id).toBe("pending-1");
    expect(s.tasks[0].subject).toBe("Streaming task");
    expect(s.tasks[0].status).toBe("pending");
  });

  it("applies a status change from TaskUpdate", () => {
    const events: TranscriptEvent[] = [
      assistant("a1", "t1", {
        type: "tool_use",
        id: "tu1",
        name: "TaskCreate",
        input: { subject: "Step 1" },
      }),
      createResult("tu1", "t1", "1", "Step 1"),
      assistant("a2", "t2", {
        type: "tool_use",
        id: "tu2",
        name: "TaskUpdate",
        input: { taskId: "1", status: "in_progress" },
      }),
      updateResult("tu2", "t2", "1", "pending", "in_progress"),
    ];
    const s = reduceTaskState(events);
    expect(s.tasks[0].status).toBe("in_progress");
    expect(s.tasks[0].updatedAt).toBe("t2");
    expect(s.counts).toEqual({
      total: 1,
      pending: 0,
      inProgress: 1,
      completed: 0,
    });
  });

  it("removes a task when status is deleted", () => {
    const events: TranscriptEvent[] = [
      assistant("a1", "t1", {
        type: "tool_use",
        id: "tu1",
        name: "TaskCreate",
        input: { subject: "Keep me" },
      }),
      createResult("tu1", "t1", "1", "Keep me"),
      assistant("a2", "t2", {
        type: "tool_use",
        id: "tu2",
        name: "TaskCreate",
        input: { subject: "Throw me away" },
      }),
      createResult("tu2", "t2", "2", "Throw me away"),
      assistant("a3", "t3", {
        type: "tool_use",
        id: "tu3",
        name: "TaskUpdate",
        input: { taskId: "2", status: "deleted" },
      }),
    ];
    const s = reduceTaskState(events);
    expect(s.tasks.map((t) => t.id)).toEqual(["1"]);
    // Still true — at least one task ever existed; lets the panel keep its
    // sticky position rather than collapsing immediately on the last delete.
    expect(s.hasEverHadTasks).toBe(true);
  });

  it("preserves insertion order across multiple creates", () => {
    const events: TranscriptEvent[] = [
      assistant("a1", "t1", {
        type: "tool_use",
        id: "tu1",
        name: "TaskCreate",
        input: { subject: "first" },
      }),
      createResult("tu1", "t1", "1", "first"),
      assistant("a2", "t2", {
        type: "tool_use",
        id: "tu2",
        name: "TaskCreate",
        input: { subject: "second" },
      }),
      createResult("tu2", "t2", "2", "second"),
      assistant("a3", "t3", {
        type: "tool_use",
        id: "tu3",
        name: "TaskCreate",
        input: { subject: "third" },
      }),
      createResult("tu3", "t3", "3", "third"),
    ];
    const s = reduceTaskState(events);
    expect(s.tasks.map((t) => t.subject)).toEqual(["first", "second", "third"]);
  });

  it("merges subject and activeForm changes from TaskUpdate", () => {
    const events: TranscriptEvent[] = [
      assistant("a1", "t1", {
        type: "tool_use",
        id: "tu1",
        name: "TaskCreate",
        input: { subject: "Initial subject" },
      }),
      createResult("tu1", "t1", "7", "Initial subject"),
      assistant("a2", "t2", {
        type: "tool_use",
        id: "tu2",
        name: "TaskUpdate",
        input: {
          taskId: "7",
          subject: "Refined subject",
          activeForm: "Refining subject",
        },
      }),
    ];
    const s = reduceTaskState(events);
    expect(s.tasks[0].subject).toBe("Refined subject");
    expect(s.tasks[0].activeForm).toBe("Refining subject");
    // No status was sent — status should stay pending.
    expect(s.tasks[0].status).toBe("pending");
  });

  it("ignores TaskUpdate for unknown ids without crashing", () => {
    const events: TranscriptEvent[] = [
      assistant("a1", "t1", {
        type: "tool_use",
        id: "tu1",
        name: "TaskUpdate",
        input: { taskId: "999", status: "completed" },
      }),
    ];
    const s = reduceTaskState(events);
    expect(s.tasks).toEqual([]);
    expect(s.hasEverHadTasks).toBe(false);
  });

  it("ignores unrelated Task* tools (TaskStop / TaskList / TaskOutput)", () => {
    // These manage background bash tasks, not the todo list — they share
    // the prefix but live in a different system. Mixing them in would
    // pollute the panel with bash commands.
    const events: TranscriptEvent[] = [
      assistant("a1", "t1", {
        type: "tool_use",
        id: "tu1",
        name: "TaskStop",
        input: { task_id: "b5sf11uuj" },
      }),
      assistant("a2", "t2", {
        type: "tool_use",
        id: "tu2",
        name: "TaskOutput",
        input: { task_id: "abc" },
      }),
      assistant("a3", "t3", {
        type: "tool_use",
        id: "tu3",
        name: "TaskList",
        input: {},
      }),
    ];
    const s = reduceTaskState(events);
    expect(s.tasks).toEqual([]);
    expect(s.hasEverHadTasks).toBe(false);
  });
});

describe("summarizeState", () => {
  it("says 'No tasks' when empty", () => {
    expect(
      summarizeState({
        tasks: [],
        counts: { total: 0, pending: 0, inProgress: 0, completed: 0 },
        hasEverHadTasks: false,
      }),
    ).toBe("No tasks");
  });

  it("says 'All N done' when every task completed", () => {
    expect(
      summarizeState({
        tasks: [],
        counts: { total: 3, pending: 0, inProgress: 0, completed: 3 },
        hasEverHadTasks: true,
      }),
    ).toBe("All 3 done");
  });

  it("shows in-progress count when not all done", () => {
    expect(
      summarizeState({
        tasks: [],
        counts: { total: 5, pending: 2, inProgress: 1, completed: 2 },
        hasEverHadTasks: true,
      }),
    ).toBe("2/5 done · 1 in progress");
  });

  it("omits the in-progress segment when zero", () => {
    expect(
      summarizeState({
        tasks: [],
        counts: { total: 5, pending: 3, inProgress: 0, completed: 2 },
        hasEverHadTasks: true,
      }),
    ).toBe("2/5 done");
  });
});
