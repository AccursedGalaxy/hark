import { useState } from "react";
import type { ToolResultEvent } from "../lib/protocol";
import { TR_CHAR_LIMIT, TR_LINE_LIMIT } from "../lib/format";
import {
  deriveStatus,
  summarizeToolUse,
  type ToolBadge,
  type ToolStatus,
  type ToolTone,
} from "../lib/toolFormat";
import {
  ChevIcon,
  EditIcon,
  FileIcon,
  GlobeIcon,
  ListIcon,
  SearchIcon,
  SparkIcon,
  TermIcon,
} from "./icons";

interface Props {
  name: string;
  input?: unknown;
  result?: ToolResultEvent;
  // Standalone = orphan tool_result (no matching tool_use in scope).
  standalone?: boolean;
  // For Task* tool calls, the subject of the referenced task at this point
  // in the transcript. Lets the row label say what task it touched.
  taskSubject?: string;
}

// Tool capsule matching the design — led + glyph + label + diff pills,
// click-to-expand body with summary + content.
export function ToolCapsule({ name, input, result, standalone, taskSubject }: Props) {
  const summary = summarizeToolUse({
    name,
    input,
    meta: result?.meta,
    hasResult: !!result,
    isError: result?.isError,
    taskSubject,
  });
  const status = deriveStatus(result);
  const [open, setOpen] = useState<boolean>(status === "bad" || !!standalone);

  const canExpand = !!result || standalone;

  return (
    <div
      className={"tool " + toneToClass(summary.tone) + " " + statusToClass(status)}
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        className="tool-head"
        onClick={() => canExpand && setOpen((v) => !v)}
        disabled={!canExpand && status !== "running"}
        aria-expanded={open}
      >
        <span className="led"></span>
        <span className="glyph">
          <ToolGlyph tone={summary.tone} />
        </span>
        <span className="tool-title">
          <span className="name">{summary.label}</span>
          {summary.detail && (
            <span className="path" title={summary.detail}>
              {summary.detail}
            </span>
          )}
        </span>
        <span className="tool-meta">
          {summary.badges?.map((b, i) => <Badge key={i} badge={b} />)}
        </span>
        {canExpand && (
          <span className="chev">
            <ChevIcon />
          </span>
        )}
      </button>

      {open && (
        <div className="tool-body">
          <ToolBody name={name} input={input} result={result} />
        </div>
      )}
    </div>
  );
}

function ToolBody({
  name,
  input,
  result,
}: {
  name: string;
  input?: unknown;
  result?: ToolResultEvent;
}) {
  if (!result) {
    return <div className="tool-running">working…</div>;
  }
  const meta = result.meta;
  const inputObj = (input ?? {}) as Record<string, unknown>;

  // Bash: cmd + terminal output.
  if (name === "Bash" && meta?.kind === "bash") {
    return (
      <div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--fg-0)",
            marginBottom: 8,
            background: "oklch(from var(--ink-0) l c h / 0.6)",
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid var(--line)",
          }}
        >
          <span style={{ color: "var(--accent)", fontWeight: 600 }}>$ </span>
          {String(inputObj.command ?? "")}
        </div>
        <OutputBlock text={result.output} />
      </div>
    );
  }

  // Edit / Write with structured diff.
  if (
    (name === "Edit" && meta?.kind === "edit") ||
    (name === "Write" && meta?.kind === "write")
  ) {
    const patch = (meta as { structuredPatch?: unknown }).structuredPatch;
    if (Array.isArray(patch) && patch.length > 0) {
      return <DiffBody patch={patch} />;
    }
    return <OutputBlock text={result.output} />;
  }

  // Glob.
  if (name === "Glob" && meta?.kind === "glob") {
    if (meta.filenames.length === 0) {
      return <div className="tool-empty">no matches</div>;
    }
    return (
      <ul className="tool-list">
        {meta.filenames.map((f) => (
          <li key={f}>
            <code>{f}</code>
          </li>
        ))}
      </ul>
    );
  }

  return <OutputBlock text={result.output} />;
}

function OutputBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const tooLong = lines.length > TR_LINE_LIMIT || text.length > TR_CHAR_LIMIT;
  const [expanded, setExpanded] = useState(false);
  let display = text;
  if (tooLong && !expanded) {
    display = lines.slice(0, TR_LINE_LIMIT).join("\n");
    if (display.length > TR_CHAR_LIMIT) display = display.slice(0, TR_CHAR_LIMIT);
  }
  return (
    <div>
      <pre>{display}</pre>
      {tooLong && !expanded && (
        <button
          type="button"
          className="show-more"
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

function DiffBody({ patch }: { patch: unknown[] }) {
  return (
    <div>
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
    <div className="diff-hunk">
      <div className="diff-hunk-head">
        @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
      </div>
      <pre style={{ padding: "6px 0" }}>
        {h.lines.map((ln, i) => {
          if (typeof ln !== "string") return null;
          const cls = ln.startsWith("+")
            ? "add"
            : ln.startsWith("-")
              ? "del"
              : "ctx";
          return (
            <span key={i} className={`diff-line ${cls}`}>
              {ln}
              {"\n"}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

function Badge({ badge }: { badge: ToolBadge }) {
  const cls =
    badge.tone === "good"
      ? "add"
      : badge.tone === "bad"
        ? "del"
        : badge.tone === "info"
          ? "new"
          : "info";
  return <span className={`diff-pill ${cls}`}>{badge.text}</span>;
}

function toneToClass(tone: ToolTone): string {
  switch (tone) {
    case "read":
      return "read";
    case "edit":
    case "write":
      return "write";
    case "bash":
      return "shell";
    case "web":
      return "web";
    case "search":
      return "search";
    case "task":
    case "agent":
    case "skill":
      return "task";
    default:
      return "";
  }
}

function statusToClass(status: ToolStatus): string {
  if (status === "running") return "running";
  if (status === "bad") return "error";
  return "";
}

function ToolGlyph({ tone }: { tone: ToolTone }) {
  switch (tone) {
    case "read":
      return <FileIcon />;
    case "edit":
    case "write":
      return <EditIcon />;
    case "bash":
      return <TermIcon />;
    case "web":
      return <GlobeIcon />;
    case "search":
      return <SearchIcon />;
    case "agent":
    case "task":
      return <ListIcon />;
    case "skill":
      return <SparkIcon />;
    default:
      return <SparkIcon />;
  }
}
