import { useEffect, useMemo, useState } from "react";
import type { TranscriptEvent } from "../lib/protocol";
import { reduceTaskState, type Task } from "../lib/taskState";
import { CheckIcon, ChevIcon, ListIcon } from "./icons";

interface Props {
  events: TranscriptEvent[];
  sessionId: string;
}

// Strip beneath the TopBar. Collapsed: current task + progress bar.
// Expanded: floating overlay listing Done / In progress / Up next groups.
// The overlay sits on top of the transcript so toggling never reflows.
export function TaskListPanel({ events, sessionId }: Props) {
  const state = useMemo(() => reduceTaskState(events), [events]);

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

  const total = state.counts.total;
  const done = state.counts.completed;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const current =
    state.tasks.find((t) => t.status === "in_progress") ??
    state.tasks.find((t) => t.status === "pending");
  const allDone = total > 0 && done === total;

  const groups: { label: string; status: string; items: Task[] }[] = [
    {
      label: "Done",
      status: "done",
      items: state.tasks.filter((t) => t.status === "completed"),
    },
    {
      label: "In progress",
      status: "now",
      items: state.tasks.filter((t) => t.status === "in_progress"),
    },
    {
      label: "Up next",
      status: "todo",
      items: state.tasks.filter(
        (t) => t.status !== "completed" && t.status !== "in_progress",
      ),
    },
  ];

  return (
    <div
      className="tasklist"
      data-open={open ? "true" : "false"}
      data-screen-label="TaskList"
    >
      <button
        type="button"
        className="tasklist-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="glyph">
          <ListIcon />
        </span>
        <span className="tasklist-cur">
          <span className="label">
            Plan · {pct}% complete
          </span>
          <span className="now">
            {allDone
              ? "All tasks complete"
              : current
                ? current.status === "in_progress" && current.activeForm
                  ? current.activeForm
                  : current.subject
                : "(no tasks)"}
          </span>
        </span>
        <span className="tasklist-progress">
          <span>
            {done}/{total}
          </span>
          <span className="bar">
            <i style={{ width: pct + "%" }}></i>
          </span>
        </span>
        <span className="chev">
          <ChevIcon />
        </span>
      </button>
      {open && (
        <div className="tasklist-body">
          {groups.map(
            (g) =>
              g.items.length > 0 && (
                <div key={g.label}>
                  <div className="task-sep">
                    {g.label} · {g.items.length}
                  </div>
                  {g.items.map((t) => (
                    <div key={t.id} className={"tasklist-task " + g.status}>
                      <span className="check">
                        {g.status === "done" && <CheckIcon />}
                      </span>
                      <span className="label" title={t.description ?? t.subject}>
                        {g.status === "now" && t.activeForm
                          ? t.activeForm
                          : t.subject}
                      </span>
                      <span className="meta">
                        {g.status === "now"
                          ? "running"
                          : g.status === "done"
                            ? ""
                            : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ),
          )}
        </div>
      )}
    </div>
  );
}
