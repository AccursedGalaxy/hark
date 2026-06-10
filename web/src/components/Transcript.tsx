import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

// Windowed tail: only the newest TAIL_ROWS rows hit the DOM on open — a
// 5k-event transcript would otherwise mean tens of thousands of nodes on a
// phone. "Show earlier" pages backwards. Pending-prompt rows are always
// newest, so the jump-to-question affordance stays inside the window.
//
// All rows in the window render eagerly. content-visibility was tried and
// reverted: lazy row heights are estimates, so the open-pin chases a
// bottom that keeps growing as rows resolve, with scroll anchoring
// fighting every correction — seconds of visible drift. A fully-laid-out
// window pins exactly, once.
const TAIL_ROWS = 150;
const PAGE_ROWS = 150;

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
  // True between a user gesture (touch/wheel/pointer) and the next return
  // to the bottom. Scroll events also fire for *non-user* reasons — our own
  // pins, and the browser's scroll anchoring compensating while
  // content-visibility rows re-measure after open — and those must not
  // unstick, or the open-scroll drifts and strands mid-transcript.
  const userIntent = useRef(false);
  // Mounted per session (keyed by the parent), so this resets on switch.
  const [visibleCount, setVisibleCount] = useState(TAIL_ROWS);

  const markIntent = () => {
    userIntent.current = true;
  };

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) {
      stick.current = true;
      userIntent.current = false;
    } else if (userIntent.current) {
      stick.current = false;
    }
  };

  useEffect(() => {
    stick.current = true;
  }, [loading]);

  // Pin to the bottom before paint whenever events change — opening a
  // session paints already scrolled to the latest turn, no visible jump.
  // `behavior: "instant"` matters: .transcript has CSS scroll-behavior:
  // smooth (for jump-to-question), which would turn every pin into a
  // seconds-long animated crawl through the whole transcript on open.
  const pinToBottom = () => {
    const el = ref.current;
    if (el && stick.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    }
  };

  useLayoutEffect(pinToBottom, [events]);

  // Stay pinned while content sizes settle. Rows use content-visibility:
  // auto, so offscreen rows re-measure from their 56px estimate to their
  // real height *after* the initial pin, and Markdown/images settle late
  // too. Desktop browsers fix this up via scroll anchoring — iOS Safari
  // has none, so without this the view drifts off the bottom right after
  // opening a session on the phone. Observing the scroller covers
  // keyboard/viewport resizes, the thread covers content growth. A user
  // scroll away from the bottom flips `stick` off (onScroll) and
  // re-pinning stops. Deps: the scroller only exists once loading/error/
  // empty states give way to the real list, so re-attach on those flips.
  const empty = events.length === 0;
  useEffect(() => {
    const el = ref.current;
    const thread = el?.firstElementChild;
    if (!el || !thread) return;
    const ro = new ResizeObserver(pinToBottom);
    ro.observe(el);
    ro.observe(thread);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, error, empty]);

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

  const hiddenCount = Math.max(0, rows.length - visibleCount);
  const visibleRows = hiddenCount > 0 ? rows.slice(hiddenCount) : rows;

  return (
    <div
      className="transcript"
      ref={ref}
      onScroll={onScroll}
      onTouchStart={markIntent}
      onWheel={markIntent}
      onPointerDown={markIntent}
    >
      <div className="thread">
        {hiddenCount > 0 && (
          <button
            type="button"
            className="show-earlier"
            onClick={() => setVisibleCount((c) => c + PAGE_ROWS)}
          >
            Show earlier · {hiddenCount} more
          </button>
        )}
        {visibleRows.map(({ ev, showWho }, i) => (
          <div className="t-row" key={ev.uuid || `${ev.kind}-${hiddenCount + i}`}>
            <MemoEventRow
              ev={ev}
              showWho={showWho}
              resultsById={resultsById}
              taskSubjectsById={taskSubjectsById}
            />
          </div>
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

interface EventRowProps {
  ev: TranscriptEvent;
  showWho: boolean;
  resultsById: Map<string, ToolResultEvent>;
  taskSubjectsById: Map<string, string>;
}

// The Maps get a fresh identity on every appended event, which would
// re-render (and re-run Markdown for) every row in the window per event.
// Events themselves are immutable, so a row only needs to re-render when
// its own event changes or when one of *its* tool_use results lands.
//
// COUPLING: the TaskUpdate special-case below mirrors lookupTaskSubject,
// which only resolves subjects for TaskUpdate blocks. If another block
// type ever consumes taskSubjectsById, extend this comparator with it or
// those rows will render stale subjects.
const MemoEventRow = memo(EventRow, (prev, next) => {
  if (prev.ev !== next.ev || prev.showWho !== next.showWho) return false;
  if (prev.ev.kind !== "assistant") return true;
  for (const b of prev.ev.blocks) {
    if (b.type !== "tool_use") continue;
    if (prev.resultsById.get(b.id) !== next.resultsById.get(b.id)) {
      return false;
    }
    if (b.name === "TaskUpdate") {
      const input = b.input as Record<string, unknown> | null | undefined;
      const taskId =
        input && typeof input.taskId === "string" ? input.taskId : "";
      if (
        taskId &&
        prev.taskSubjectsById.get(taskId) !== next.taskSubjectsById.get(taskId)
      ) {
        return false;
      }
    }
  }
  return true;
});

function EventRow({ ev, showWho, resultsById, taskSubjectsById }: EventRowProps) {
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
