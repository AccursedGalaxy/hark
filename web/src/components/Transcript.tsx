import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ContentBlock, TranscriptEvent } from "../lib/protocol";
import { TR_CHAR_LIMIT, TR_LINE_LIMIT } from "../lib/format";
import { Markdown } from "./Markdown";

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

  // Reset stickiness whenever we load a different transcript.
  useEffect(() => {
    stick.current = true;
  }, [loading]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);

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
        {events.map((ev, i) => (
          <EventRow key={ev.uuid || `${ev.kind}-${i}`} ev={ev} />
        ))}
      </div>
    </div>
  );
}

function EventRow({ ev }: { ev: TranscriptEvent }) {
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
      return <AssistantRow blocks={ev.blocks} />;
    case "tool_result":
      return <ToolResultRow output={ev.output} isError={ev.isError} />;
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

function AssistantRow({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="ev ev-assistant">
      <div className="who">claude</div>
      {blocks.map((b, i) => {
        if (b.type === "text")
          return (
            <div key={i} className="assistant-text">
              <Markdown source={b.text} />
            </div>
          );
        if (b.type === "thinking")
          return (
            <div key={i} className="block-thinking">
              {b.text}
            </div>
          );
        if (b.type === "tool_use") {
          const input =
            typeof b.input === "object"
              ? JSON.stringify(b.input)
              : String(b.input ?? "");
          const trimmed = input.length > 240 ? input.slice(0, 240) + "…" : input;
          return (
            <div key={i} className="block-tool">
              <span className="tool-name">{b.name}</span>
              <span className="tool-args">{trimmed}</span>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function ToolResultRow({
  output,
  isError,
}: {
  output: string;
  isError: boolean;
}) {
  const lines = output.split("\n");
  const tooLong = lines.length > TR_LINE_LIMIT || output.length > TR_CHAR_LIMIT;
  const [expanded, setExpanded] = useState(false);
  let display = output;
  if (tooLong && !expanded) {
    display = lines.slice(0, TR_LINE_LIMIT).join("\n");
    if (display.length > TR_CHAR_LIMIT) display = display.slice(0, TR_CHAR_LIMIT);
  }
  return (
    <div className={`ev ev-tool-result ${isError ? "is-error" : ""}`}>
      <pre>{display}</pre>
      {tooLong && !expanded && (
        <button
          type="button"
          className="tr-more"
          onClick={() => setExpanded(true)}
        >
          show full ({lines.length} lines)
        </button>
      )}
    </div>
  );
}
