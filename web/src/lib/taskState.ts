// Reduce a stream of transcript events into the current state of Claude
// Code's task list (the TaskCreate / TaskUpdate tool family — the in-session
// "todo list", *not* TaskStop/TaskOutput which manage background bash tasks).
//
// Each TaskCreate's tool_result assigns the canonical `id`. TaskUpdate then
// merges status / subject / description changes against that id. A
// TaskUpdate with `status: "deleted"` removes the row.
//
// Pure on purpose: feed it the same events array the Transcript renders and
// the panel above stays in lock-step with the timeline.

import type { ContentBlock, ToolResultEvent, TranscriptEvent } from "./protocol";
import { indexToolResults } from "./protocol";

export type TaskStatus = "pending" | "in_progress" | "completed" | string;

export interface Task {
  id: string;
  subject: string;
  description?: string;
  // Present-continuous label shown while in_progress (e.g. "Running tests").
  activeForm?: string;
  status: TaskStatus;
  // Wall-clock of the most recent mutation. Drives sort stability when the
  // model bunches several updates in one turn.
  updatedAt: string;
}

export interface TaskListState {
  // Insertion-ordered list of tasks (oldest create first).
  tasks: Task[];
  // Cheap counts so the collapsed header doesn't need to recount.
  counts: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
  };
  // True once any TaskCreate has ever landed, even if all are now deleted.
  // Lets the panel show "0/0" cleanly without flickering in and out.
  hasEverHadTasks: boolean;
}

const EMPTY: TaskListState = {
  tasks: [],
  counts: { total: 0, pending: 0, inProgress: 0, completed: 0 },
  hasEverHadTasks: false,
};

function countsFor(tasks: Task[]): TaskListState["counts"] {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const t of tasks) {
    if (t.status === "in_progress") inProgress++;
    else if (t.status === "completed") completed++;
    else pending++;
  }
  return { total: tasks.length, pending, inProgress, completed };
}

// Pull `{task:{id,subject}}` out of a TaskCreate's tool_result. Returns
// null if the result blob doesn't match — we then fall back to a synthetic
// id so the row at least appears (useful while the result is in-flight).
function readCreatedId(result: ToolResultEvent | undefined): string | null {
  if (!result) return null;
  // Typed meta first when present, then raw fallback.
  const data =
    result.meta?.kind === "raw" ? result.meta.data : undefined;
  const obj =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (!obj) return null;
  const task = obj.task;
  if (!task || typeof task !== "object") return null;
  const id = (task as Record<string, unknown>).id;
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number") return String(id);
  return null;
}

function strField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Build the current task list from an ordered event stream. Returns the
 * empty state if no Task* tool calls are present, so callers can decide
 * whether to render the panel at all.
 */
export function reduceTaskState(events: TranscriptEvent[]): TaskListState {
  if (events.length === 0) return EMPTY;

  // Index tool_results once so we can look up the id assigned to each
  // TaskCreate when the create's tool_use block runs.
  const resultsById = indexToolResults(events);

  const byId = new Map<string, Task>();
  // Order tracks first-seen sequence so the panel reads top-to-bottom in
  // the order tasks were created.
  const order: string[] = [];
  let hasEverHadTasks = false;
  // For TaskCreate calls whose tool_result hasn't been written yet (still
  // streaming), we synthesise a stable id so the row appears immediately.
  let pendingCreateCount = 0;

  for (const ev of events) {
    if (ev.kind !== "assistant") continue;
    for (const block of ev.blocks) {
      if (block.type !== "tool_use") continue;
      if (block.name === "TaskCreate") {
        applyCreate(block, ev.ts, resultsById.get(block.id));
      } else if (block.name === "TaskUpdate") {
        applyUpdate(block, ev.ts);
      }
    }
  }

  const tasks = order
    .map((id) => byId.get(id))
    .filter((t): t is Task => !!t);

  return {
    tasks,
    counts: countsFor(tasks),
    hasEverHadTasks,
  };

  function applyCreate(
    block: Extract<ContentBlock, { type: "tool_use" }>,
    ts: string,
    result: ToolResultEvent | undefined,
  ): void {
    const subject = strField(block.input, "subject") ?? "(no subject)";
    const description = strField(block.input, "description");
    const activeForm = strField(block.input, "activeForm");
    let id = readCreatedId(result);
    if (!id) {
      pendingCreateCount += 1;
      id = `pending-${pendingCreateCount}`;
    }
    if (byId.has(id)) return; // duplicate create on the same id — ignore
    byId.set(id, {
      id,
      subject,
      description,
      activeForm,
      status: "pending",
      updatedAt: ts,
    });
    order.push(id);
    hasEverHadTasks = true;
  }

  function applyUpdate(
    block: Extract<ContentBlock, { type: "tool_use" }>,
    ts: string,
  ): void {
    const taskId = strField(block.input, "taskId");
    if (!taskId) return;
    const cur = byId.get(taskId);
    if (!cur) return; // unknown id — could be a TaskUpdate before its create rendered

    const input = block.input as Record<string, unknown>;
    const rawStatus = input.status;
    if (typeof rawStatus === "string" && rawStatus === "deleted") {
      // Hard remove on delete so the panel doesn't carry tombstones.
      byId.delete(taskId);
      const idx = order.indexOf(taskId);
      if (idx >= 0) order.splice(idx, 1);
      return;
    }

    const next: Task = { ...cur, updatedAt: ts };
    if (typeof rawStatus === "string" && rawStatus.length > 0) {
      next.status = rawStatus;
    }
    const newSubject = strField(input, "subject");
    if (newSubject) next.subject = newSubject;
    const newDescription = strField(input, "description");
    if (newDescription) next.description = newDescription;
    const newActiveForm = strField(input, "activeForm");
    if (newActiveForm) next.activeForm = newActiveForm;
    byId.set(taskId, next);
  }
}

/** Pretty short label for the collapsed panel header. */
export function summarizeState(state: TaskListState): string {
  const { counts } = state;
  if (counts.total === 0) return "No tasks";
  if (counts.completed === counts.total) {
    return `All ${counts.total} done`;
  }
  const parts = [`${counts.completed}/${counts.total} done`];
  if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
  return parts.join(" · ");
}
