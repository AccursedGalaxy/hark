import { useState } from "react";
import type { ContentBlock, ToolResultEvent } from "../lib/protocol";
import { TR_CHAR_LIMIT, TR_LINE_LIMIT } from "../lib/format";
import {
  deriveStatus,
  summarizeToolUse,
  type ToolBadge,
  type ToolStatus,
  type ToolTone,
} from "../lib/toolFormat";

interface Props {
  use: Extract<ContentBlock, { type: "tool_use" }>;
  result?: ToolResultEvent;
}

export function ToolCall({ use, result }: Props) {
  const summary = summarizeToolUse({
    name: use.name,
    input: use.input,
    meta: result?.meta,
    hasResult: !!result,
    isError: result?.isError,
  });
  const status = deriveStatus(result);
  // Errors auto-expand so failures aren't hidden. Otherwise stay collapsed
  // for readability; users open the ones they want.
  const [open, setOpen] = useState<boolean>(status === "bad");

  const canExpand = !!result;
  const onToggle = () => {
    if (canExpand) setOpen((v) => !v);
  };

  return (
    <div
      className={`tc tone-${summary.tone} status-${status} ${open ? "is-open" : ""}`}
      data-open={open}
    >
      <button
        type="button"
        className="tc-head"
        onClick={onToggle}
        aria-expanded={open}
        aria-disabled={!canExpand}
        disabled={!canExpand && status !== "running"}
      >
        <StatusDot status={status} />
        <ToolIcon tone={summary.tone} />
        <span className="tc-label">{summary.label}</span>
        {summary.detail && (
          <span className="tc-detail" title={summary.detail}>
            {summary.detail}
          </span>
        )}
        <span className="tc-spacer" />
        {summary.badges?.map((b, i) => (
          <Badge key={i} badge={b} />
        ))}
        {canExpand && <Chevron />}
      </button>

      {/* Animated body. CSS uses grid-template-rows 0fr→1fr to smoothly
          reveal natural-height content without measuring in JS. */}
      <div className="tc-body-wrap">
        <div className="tc-body">
          {result ? (
            <ToolBody use={use} result={result} />
          ) : (
            <div className="tc-running">working…</div>
          )}
        </div>
      </div>
    </div>
  );
}

// Fallback for a tool_result without a matching tool_use in scope (the
// assistant block was emitted before the SSE consumer started watching).
export function OrphanToolResult({ result }: { result: ToolResultEvent }) {
  return (
    <div className="tc tone-neutral status-good is-open" data-open>
      <div className="tc-head tc-head-static">
        <StatusDot status={result.isError ? "bad" : "good"} />
        <ToolIcon tone="neutral" />
        <span className="tc-label">
          {result.toolName ?? "tool result"}
        </span>
        <span className="tc-spacer" />
      </div>
      <div className="tc-body-wrap">
        <div className="tc-body">
          <OutputBlock text={result.output} />
        </div>
      </div>
    </div>
  );
}

// ---- Body dispatch ----

function ToolBody({
  use,
  result,
}: {
  use: Extract<ContentBlock, { type: "tool_use" }>;
  result: ToolResultEvent;
}) {
  const meta = result.meta;
  const input = (use.input ?? {}) as Record<string, unknown>;

  // Bash: command echo + description + terminal-style output.
  if (use.name === "Bash" && meta?.kind === "bash") {
    return (
      <div className="tc-bash">
        <div className="tc-bash-cmd">
          <span className="tc-bash-prompt">$</span>
          <code>{String(input.command ?? "")}</code>
        </div>
        <OutputBlock text={result.output} variant="terminal" />
      </div>
    );
  }

  // Read: file content already line-numbered by Claude Code (cat -n style).
  if (use.name === "Read" && meta?.kind === "read") {
    return <OutputBlock text={result.output} variant="code" />;
  }

  // Edit/Write: structured diff if we have one, otherwise the model-facing
  // confirmation string.
  if (
    (use.name === "Edit" && meta?.kind === "edit") ||
    (use.name === "Write" && meta?.kind === "write")
  ) {
    const patch = (meta as { structuredPatch?: unknown }).structuredPatch;
    if (Array.isArray(patch) && patch.length > 0) {
      return <DiffBlock patch={patch} />;
    }
    return <OutputBlock text={result.output} />;
  }

  // Glob: list of filenames, one per line.
  if (use.name === "Glob" && meta?.kind === "glob") {
    if (meta.filenames.length === 0) {
      return <div className="tc-empty">no matches</div>;
    }
    return (
      <ul className="tc-list">
        {meta.filenames.map((f) => (
          <li key={f}>
            <code>{f}</code>
          </li>
        ))}
      </ul>
    );
  }

  // WebFetch / WebSearch / unknown — fall back to the model-facing output.
  return <OutputBlock text={result.output} />;
}

// ---- Output block (with collapse) ----

function OutputBlock({
  text,
  variant,
}: {
  text: string;
  variant?: "code" | "terminal";
}) {
  const lines = text.split("\n");
  const tooLong = lines.length > TR_LINE_LIMIT || text.length > TR_CHAR_LIMIT;
  const [expanded, setExpanded] = useState(false);
  let display = text;
  if (tooLong && !expanded) {
    display = lines.slice(0, TR_LINE_LIMIT).join("\n");
    if (display.length > TR_CHAR_LIMIT) display = display.slice(0, TR_CHAR_LIMIT);
  }
  return (
    <div className={`tc-out variant-${variant ?? "plain"}`}>
      <pre>{display}</pre>
      {tooLong && !expanded && (
        <button
          type="button"
          className="tc-more"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
        >
          show full ({lines.length} lines)
        </button>
      )}
    </div>
  );
}

// ---- Diff renderer ----

function DiffBlock({ patch }: { patch: unknown[] }) {
  return (
    <div className="tc-diff">
      {patch.map((hunk, i) => (
        <DiffHunk key={i} hunk={hunk} />
      ))}
    </div>
  );
}

function DiffHunk({ hunk }: { hunk: unknown }) {
  if (!hunk || typeof hunk !== "object") return null;
  const h = hunk as {
    oldStart?: number;
    oldLines?: number;
    newStart?: number;
    newLines?: number;
    lines?: unknown;
  };
  if (!Array.isArray(h.lines)) return null;
  return (
    <div className="tc-hunk">
      <div className="tc-hunk-head">
        @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
      </div>
      {h.lines.map((ln, i) => {
        if (typeof ln !== "string") return null;
        const cls = ln.startsWith("+")
          ? "add"
          : ln.startsWith("-")
            ? "del"
            : "ctx";
        return (
          <div key={i} className={`tc-hunk-line ${cls}`}>
            {ln}
          </div>
        );
      })}
    </div>
  );
}

// ---- Status + icons ----

function StatusDot({ status }: { status: ToolStatus }) {
  return <span className={`tc-dot dot-${status}`} aria-hidden />;
}

function Chevron() {
  return (
    <svg
      className="tc-chev"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden
    >
      <path
        d="M3 1.5l3 3.5-3 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Badge({ badge }: { badge: ToolBadge }) {
  return (
    <span className={`tc-badge badge-${badge.tone ?? "info"}`}>
      {badge.text}
    </span>
  );
}

function ToolIcon({ tone }: { tone: ToolTone }) {
  // 14×14 line icons in currentColor — tone is applied by the wrapper.
  const common = {
    width: 13,
    height: 13,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "tc-icon",
  };
  switch (tone) {
    case "read":
      return (
        <svg {...common}>
          <path d="M3 2.5h6l3 3v8H3z" />
          <path d="M9 2.5v3h3" />
          <path d="M5.5 8.5h5M5.5 11h4" />
        </svg>
      );
    case "bash":
      return (
        <svg {...common}>
          <path d="M3 4l3 4-3 4" />
          <path d="M8.5 12h4.5" />
        </svg>
      );
    case "edit":
      return (
        <svg {...common}>
          <path d="M2.5 13.5l1-3 7-7 2 2-7 7-3 1z" />
          <path d="M9.5 4.5l2 2" />
        </svg>
      );
    case "write":
      return (
        <svg {...common}>
          <path d="M3 2.5h6l3 3v8H3z" />
          <path d="M9 2.5v3h3" />
          <path d="M8 8v4M6 10h4" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4" />
          <path d="M10 10l3 3" />
        </svg>
      );
    case "web":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" />
        </svg>
      );
    case "agent":
      return (
        <svg {...common}>
          <path d="M8 2l1.6 3.4L13 7l-3.4 1.6L8 12l-1.6-3.4L3 7l3.4-1.6z" />
          <path d="M12.5 11.5l1 1" />
        </svg>
      );
    case "task":
      return (
        <svg {...common}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <path d="M5.5 8.5l2 2 3.5-4" />
        </svg>
      );
    case "skill":
      return (
        <svg {...common}>
          <path d="M8.5 2.5L4 9h3.5l-1 4.5L11 7H7.5z" />
        </svg>
      );
    case "neutral":
    default:
      return (
        <svg {...common}>
          <path d="M5 4l-3 4 3 4M11 4l3 4-3 4" />
        </svg>
      );
  }
}
