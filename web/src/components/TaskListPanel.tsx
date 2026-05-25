import { useEffect, useMemo, useState } from "react";
import type { TranscriptEvent } from "../lib/protocol";
import { reduceTaskState, summarizeState, type Task } from "../lib/taskState";

interface Props {
  events: TranscriptEvent[];
  // When the session changes we want the panel to remember its open state
  // per session id (a long-lived session might have its panel open while a
  // freshly-opened one starts collapsed).
  sessionId: string;
}

// Sticky between SessionHeader and Transcript. Always shows the current
// shape of the in-session todo list — the model can push new tasks or
// flip statuses any turn and this panel reflects it without a page reload.
//
// Renders nothing if the session has never used TaskCreate. We don't want
// an empty bar eating header space in normal chats.
export function TaskListPanel({ events, sessionId }: Props) {
  const state = useMemo(() => reduceTaskState(events), [events]);

  // Persist open/closed per session so navigating away and back keeps the
  // user's choice. Default closed — the head bar is enough of a hint that
  // tasks exist; we don't want a freshly opened session to push the chat
  // down unexpectedly.
  const storageKey = `hark.tasklist.open.${sessionId}`;
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(storageKey) === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, open ? "1" : "0");
  }, [storageKey, open]);

  if (!state.hasEverHadTasks || state.tasks.length === 0) return null;

  const summary = summarizeState(state);
  const pct =
    state.counts.total === 0
      ? 0
      : Math.round((state.counts.completed / state.counts.total) * 100);
  const allDone =
    state.counts.total > 0 && state.counts.completed === state.counts.total;

  return (
    <div
      className={`tasklist ${open ? "is-open" : ""} ${allDone ? "is-done" : ""}`}
      data-open={open}
    >
      <button
        type="button"
        className="tasklist-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="tasklist-body"
      >
        <ChecklistIcon />
        <span className="tasklist-label">Tasks</span>
        <span className="tasklist-summary">{summary}</span>
        <span className="tasklist-spacer" />
        <div
          className="tasklist-progress"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          title={`${pct}% complete`}
        >
          <div className="tasklist-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <Chevron />
      </button>
      <div className="tasklist-body-wrap" id="tasklist-body">
        <ol className="tasklist-items">
          {state.tasks.map((t, i) => (
            <TaskRow key={t.id} task={t} index={i + 1} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function TaskRow({ task, index }: { task: Task; index: number }) {
  const label =
    task.status === "in_progress" && task.activeForm
      ? task.activeForm
      : task.subject;
  return (
    <li className={`tasklist-row status-${cssStatus(task.status)}`}>
      <span className="tasklist-marker" aria-hidden>
        <StatusGlyph status={task.status} />
      </span>
      <span className="tasklist-index">{index}.</span>
      <span className="tasklist-text" title={task.description ?? label}>
        {label}
      </span>
      <span className="tasklist-status-badge">{prettyStatus(task.status)}</span>
    </li>
  );
}

function cssStatus(status: string): string {
  switch (status) {
    case "in_progress":
    case "completed":
    case "pending":
      return status;
    default:
      return "pending";
  }
}

function prettyStatus(status: string): string {
  switch (status) {
    case "in_progress":
      return "in progress";
    case "completed":
      return "done";
    case "pending":
      return "pending";
    default:
      return status;
  }
}

function StatusGlyph({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="6.5" fill="currentColor" opacity="0.18" />
        <path
          d="M5 8.2l2 2 4-4.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          opacity="0.5"
        />
        <path
          d="M8 2a6 6 0 0 1 6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="tasklist-spinner-arc"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity="0.55"
      />
    </svg>
  );
}

function ChecklistIcon() {
  return (
    <svg
      className="tasklist-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4l1.5 1.5L7.5 2.5" />
      <path d="M3 8l1.5 1.5L7.5 6.5" />
      <path d="M3 12l1.5 1.5L7.5 10.5" />
      <path d="M9.5 4h4M9.5 8h4M9.5 12h4" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      className="tasklist-chev"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden
    >
      <path
        d="M3 1.5l3 3.5-3 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
