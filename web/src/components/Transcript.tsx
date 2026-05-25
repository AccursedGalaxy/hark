import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type {
  ContentBlock,
  ToolResultEvent,
  TranscriptEvent,
} from "../lib/protocol";
import { indexToolResults } from "../lib/protocol";
import { reduceTaskState } from "../lib/taskState";
import {
  summarizeTaskCreate,
  summarizeTaskUpdate,
  type TaskUpdateLine,
} from "../lib/toolFormat";
import { ChevIcon, ListIcon } from "./icons";
import { Markdown } from "./Markdown";
import { ToolCapsule } from "./ToolCapsule";

export function Transcript({
  events,
  loading,
  error,
  pendingKind,
  onJumpToQuestion,
}: {
  events: TranscriptEvent[];
  loading: boolean;
  error: string | null;
  pendingKind: string | null;
  onJumpToQuestion: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    stick.current = true;
  }, [loading]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const { resultsById, claimedIds, taskSubjectsById } = useMemo(() => {
    const resultsById = indexToolResults(events);
    const claimedIds = new Set<string>();
    for (const ev of events) {
      if (ev.kind !== "assistant") continue;
      for (const b of ev.blocks) {
        if (b.type === "tool_use" && resultsById.has(b.id)) {
          claimedIds.add(b.id);
        }
      }
    }
    // Reduce the full event stream into the current TaskCreate/TaskUpdate
    // list so per-call capsules can show the *subject* of the task they
    // touched, not just `Task #N`. Reusing the same reducer the panel
    // above uses keeps the two views in lock-step.
    const taskSubjectsById = new Map<string, string>();
    for (const t of reduceTaskState(events).tasks) {
      taskSubjectsById.set(t.id, t.subject);
    }
    return { resultsById, claimedIds, taskSubjectsById };
  }, [events]);

  const rows = useMemo(() => {
    const out: { ev: TranscriptEvent; showWho: boolean }[] = [];
    let prevWasAssistant = false;
    for (const ev of events) {
      if (ev.kind === "assistant") {
        if (!hasVisibleBlocks(ev.blocks)) continue;
        out.push({ ev, showWho: !prevWasAssistant });
        prevWasAssistant = true;
        continue;
      }
      if (ev.kind === "tool_result" && claimedIds.has(ev.toolUseId)) continue;
      out.push({ ev, showWho: true });
      prevWasAssistant = false;
    }
    return out;
  }, [events, claimedIds]);

  if (loading) {
    return <div className="transcript transcript-empty">Loading…</div>;
  }
  if (error) {
    return <div className="transcript transcript-empty">{error}</div>;
  }
  if (events.length === 0) {
    return (
      <div className="transcript transcript-empty">
        Start typing to begin the conversation.
      </div>
    );
  }

  const lastQuestionText = pendingKind === "ask_user_question"
    ? "Claude is asking — jump to question"
    : pendingKind === "exit_plan_mode"
      ? "Plan is ready — review and approve"
      : pendingKind === "tool_permission"
        ? "Permission requested"
        : pendingKind === "elicitation"
          ? "Form requested"
          : null;

  return (
    <div className="transcript" ref={ref} onScroll={onScroll}>
      <div className="thread">
        {rows.map(({ ev, showWho }, i) => (
          <EventRow
            key={ev.uuid || `${ev.kind}-${i}`}
            ev={ev}
            showWho={showWho}
            resultsById={resultsById}
            taskSubjectsById={taskSubjectsById}
          />
        ))}
        {lastQuestionText && (
          <button
            type="button"
            className="q-pointer"
            onClick={onJumpToQuestion}
          >
            <span className="led"></span>
            <span>
              <span
                className="lbl"
                style={{ display: "block", marginBottom: 2 }}
              >
                Claude is asking
              </span>
              <span className="txt">{lastQuestionText}</span>
            </span>
            <span className="jump">
              Jump to prompt <ChevIcon />
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function hasVisibleBlocks(blocks: ContentBlock[]): boolean {
  return blocks.some((b) => {
    if (b.type === "text") return b.text.trim().length > 0;
    if (b.type === "thinking") return b.text.trim().length > 0;
    if (b.type === "tool_use") return true;
    return false;
  });
}

function EventRow({
  ev,
  showWho,
  resultsById,
  taskSubjectsById,
}: {
  ev: TranscriptEvent;
  showWho: boolean;
  resultsById: Map<string, ToolResultEvent>;
  taskSubjectsById: Map<string, string>;
}) {
  switch (ev.kind) {
    case "user":
      return (
        <div className="turn user">
          <span className="who">you</span>
          <div className="bubble">{ev.text}</div>
        </div>
      );
    case "system":
      return <SystemRow text={ev.text} />;
    case "assistant":
      return (
        <AssistantRow
          blocks={ev.blocks}
          resultsById={resultsById}
          taskSubjectsById={taskSubjectsById}
          showWho={showWho}
        />
      );
    case "tool_result":
      return (
        <ToolCapsule
          name={ev.toolName ?? "tool"}
          result={ev}
          standalone
        />
      );
    default:
      return null;
  }
}

function SystemRow({ text }: { text: string }) {
  const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        fontFamily: "var(--mono)",
        fontSize: 11,
        color: "var(--fg-3)",
        padding: "4px 0",
      }}
      title={text}
    >
      <span
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--fg-4)",
        }}
      >
        system
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {preview}
      </span>
    </div>
  );
}

function AssistantRow({
  blocks,
  resultsById,
  taskSubjectsById,
  showWho,
}: {
  blocks: ContentBlock[];
  resultsById: Map<string, ToolResultEvent>;
  taskSubjectsById: Map<string, string>;
  showWho: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {showWho && (
        <div className="assistant-marker">
          <span className="av"></span> claude · sonnet
        </div>
      )}
      {blocks.map((b, i) => {
        if (b.type === "text") {
          if (b.text.trim().length === 0) return null;
          return (
            <div key={i} className="assistant-line has-md">
              <Markdown source={b.text} />
            </div>
          );
        }
        if (b.type === "thinking") {
          if (b.text.trim().length === 0) return null;
          return (
            <div key={i} className="assistant-thinking">
              {b.text}
            </div>
          );
        }
        if (b.type === "tool_use") {
          // TaskCreate / TaskUpdate render as compact one-line rows (no
          // expand toggle, no badges) — they're status churn the reader
          // never needs to drill into; the task list panel above is the
          // canonical view.
          if (b.name === "TaskUpdate") {
            return (
              <TaskUpdateRow
                key={i}
                line={summarizeTaskUpdate({
                  input: b.input,
                  meta: resultsById.get(b.id)?.meta,
                  taskSubject: lookupTaskSubject(b, taskSubjectsById),
                })}
              />
            );
          }
          if (b.name === "TaskCreate") {
            return (
              <TaskUpdateRow
                key={i}
                line={summarizeTaskCreate({ input: b.input })}
              />
            );
          }
          return (
            <ToolCapsule
              key={i}
              name={b.name}
              input={b.input}
              result={resultsById.get(b.id)}
              taskSubject={lookupTaskSubject(b, taskSubjectsById)}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

function TaskUpdateRow({ line }: { line: TaskUpdateLine }) {
  return (
    <div className={`task-update-row tone-${line.tone}`} title={line.text}>
      <span className="glyph">
        <ListIcon />
      </span>
      <span className="text">{line.text}</span>
    </div>
  );
}

// For TaskUpdate, find the subject of the task it's modifying. For
// TaskCreate the subject is already in `input` so the formatter doesn't
// need it from us.
function lookupTaskSubject(
  block: Extract<ContentBlock, { type: "tool_use" }>,
  taskSubjectsById: Map<string, string>,
): string | undefined {
  if (block.name !== "TaskUpdate") return undefined;
  const input = block.input as Record<string, unknown> | null | undefined;
  const id = input && typeof input.taskId === "string" ? input.taskId : "";
  if (!id) return undefined;
  return taskSubjectsById.get(id);
}
