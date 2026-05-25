import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type {
  ContentBlock,
  ToolResultEvent,
  TranscriptEvent,
} from "../lib/protocol";
import { indexToolResults } from "../lib/protocol";
import { Markdown } from "./Markdown";
import { OrphanToolResult, ToolCall } from "./ToolCall";

export function Transcript({
  events,
  loading,
  error,
}: {
  events: TranscriptEvent[];
  loading: boolean;
  error: string | null;
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

  // Build a tool_use_id -> tool_result lookup once per render. Used to:
  //   (a) fuse each tool_use block with its result inside the assistant row
  //   (b) skip rendering top-level tool_result events claimed by a pairing
  const { resultsById, claimedIds } = useMemo(() => {
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
    return { resultsById, claimedIds };
  }, [events]);

  // Pre-pass: derive what each event renders to. Two responsibilities:
  //   1. Drop assistant events whose blocks are all empty (Claude Code
  //      sometimes writes a `thinking: ""` row before the real one).
  //   2. Merge consecutive assistant entries into one visual turn — the
  //      JSONL splits a logical turn into multiple lines (thinking, then
  //      tool_use, sometimes also text) and we want one "claude" label per
  //      turn, not one per line.
  // Claimed tool_results render to nothing but don't break the assistant
  // streak (visually they belong to the prior turn).
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
      if (ev.kind === "tool_result" && claimedIds.has(ev.toolUseId)) {
        // Don't emit a row, and don't break the assistant streak.
        continue;
      }
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
      <div className="transcript transcript-empty">No transcript yet.</div>
    );
  }

  return (
    <div className="transcript" ref={ref} onScroll={onScroll}>
      <div className="transcript-inner">
        {rows.map(({ ev, showWho }, i) => (
          <EventRow
            key={ev.uuid || `${ev.kind}-${i}`}
            ev={ev}
            showWho={showWho}
            resultsById={resultsById}
          />
        ))}
      </div>
    </div>
  );
}

// A block contributes to the visible row only if it has actual content.
// Empty thinking/text blocks (Claude Code sometimes writes `thinking: ""`)
// would otherwise produce a styled-but-empty `block-thinking` element.
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
}: {
  ev: TranscriptEvent;
  showWho: boolean;
  resultsById: Map<string, ToolResultEvent>;
}) {
  switch (ev.kind) {
    case "user":
      return (
        <div className="ev ev-user">
          <div className="who">you</div>
          <div className="bubble-user">{ev.text}</div>
        </div>
      );
    case "system":
      return <SystemRow text={ev.text} />;
    case "assistant":
      return (
        <AssistantRow
          blocks={ev.blocks}
          resultsById={resultsById}
          showWho={showWho}
        />
      );
    case "tool_result":
      // Reaching this branch means the result is genuinely orphaned (no
      // matching tool_use in the visible event window). Render a fallback
      // card so nothing is silently dropped.
      return <OrphanToolResult result={ev} />;
    default:
      return null;
  }
}

function SystemRow({ text }: { text: string }) {
  const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
  return (
    <div className="ev ev-system" title={text}>
      <span className="system-label">system</span>
      <span className="system-text">{preview}</span>
    </div>
  );
}

function AssistantRow({
  blocks,
  resultsById,
  showWho,
}: {
  blocks: ContentBlock[];
  resultsById: Map<string, ToolResultEvent>;
  showWho: boolean;
}) {
  return (
    <div className={`ev ev-assistant ${showWho ? "" : "is-cont"}`}>
      {showWho && <div className="who">claude</div>}
      {blocks.map((b, i) => {
        if (b.type === "text") {
          if (b.text.trim().length === 0) return null;
          return (
            <div key={i} className="assistant-text">
              <Markdown source={b.text} />
            </div>
          );
        }
        if (b.type === "thinking") {
          if (b.text.trim().length === 0) return null;
          return (
            <div key={i} className="block-thinking">
              {b.text}
            </div>
          );
        }
        if (b.type === "tool_use") {
          return <ToolCall key={i} use={b} result={resultsById.get(b.id)} />;
        }
        return null;
      })}
    </div>
  );
}
