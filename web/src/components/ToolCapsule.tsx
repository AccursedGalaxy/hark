import { useRef, useState } from "react";
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
  // Subagent spawns get their own capsule variant — different silhouette
  // (eyebrow + prominent task line + structured prompt/report sections)
  // so they're scannable as "another agent did work here" rather than
  // blending into the file-edit / shell-command stream.
  if (name === "Agent" && !standalone) {
    return <AgentCapsule input={input} result={result} />;
  }

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
  const rootRef = useRef<HTMLDivElement>(null);

  const canExpand = !!result || standalone;

  return (
    <div
      ref={rootRef}
      className={"tool " + toneToClass(summary.tone) + " " + statusToClass(status)}
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        className="tool-head"
        onClick={() => {
          if (!canExpand) return;
          const wasOpen = open;
          setOpen((v) => !v);
          if (!wasOpen) scrollIntoViewIfClipped(rootRef.current);
        }}
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

// Dedicated capsule for Agent / subagent spawns. The collapsed head leads
// with an eyebrow chip ("subagent · <type>") so the kind of delegate is
// the first thing you read, with the description as the prominent task
// line. The expanded body splits prompt (what we asked for) from report
// (what the subagent returned) — same content the generic ToolBody would
// dump as one blob, but sectioned so the report (the thing the reader
// actually cares about) doesn't get lost above a 50-line prompt.
function AgentCapsule({
  input,
  result,
}: {
  input?: unknown;
  result?: ToolResultEvent;
}) {
  const obj = (input && typeof input === "object")
    ? (input as Record<string, unknown>)
    : {};
  const sub = typeof obj.subagent_type === "string" ? obj.subagent_type : "agent";
  const description =
    typeof obj.description === "string" && obj.description.trim()
      ? obj.description.trim()
      : `subagent · ${sub}`;
  const prompt =
    typeof obj.prompt === "string" && obj.prompt.trim()
      ? obj.prompt.trim()
      : "";
  const isolation = typeof obj.isolation === "string" ? obj.isolation : undefined;
  const status = deriveStatus(result);
  // Default expanded once we have a report so the user can read it without
  // an extra click — the report is the whole point of having spawned this.
  const [open, setOpen] = useState<boolean>(false);
  const [promptOpen, setPromptOpen] = useState<boolean>(false);
  const canExpand = !!result;
  const rootRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={rootRef}
      className={"tool agent " + statusToClass(status)}
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        className="tool-head agent-head"
        onClick={() => {
          if (!canExpand) return;
          const wasOpen = open;
          setOpen((v) => !v);
          if (!wasOpen) scrollIntoViewIfClipped(rootRef.current);
        }}
        disabled={!canExpand && status !== "running"}
        aria-expanded={open}
      >
        <span className="led"></span>
        <span className="glyph">
          <AgentSpawnIcon />
        </span>
        <span className="agent-title">
          <span className="agent-eyebrow">
            subagent <span className="sep">·</span>
            <span className="agent-type">{sub}</span>
            {isolation && (
              <>
                <span className="sep">·</span>
                <span className="agent-iso">{isolation}</span>
              </>
            )}
          </span>
          <span className="agent-desc">{description}</span>
        </span>
        <span className="tool-meta">
          <AgentStatusBadge status={status} hasResult={!!result} isError={result?.isError} />
        </span>
        {canExpand && (
          <span className="chev">
            <ChevIcon />
          </span>
        )}
      </button>

      {open && (
        <div className="tool-body agent-body">
          {prompt && (
            <div className="agent-section">
              <button
                type="button"
                className="agent-section-head"
                onClick={() => {
                  const wasOpen = promptOpen;
                  setPromptOpen((v) => !v);
                  if (!wasOpen) scrollIntoViewIfClipped(rootRef.current);
                }}
                aria-expanded={promptOpen}
              >
                <span className="lbl">Prompt</span>
                <span className="hint">
                  {promptOpen ? "hide" : `show (${prompt.split("\n").length} lines)`}
                </span>
              </button>
              {promptOpen && (
                <div className="agent-prompt">
                  <OutputBlock text={prompt} />
                </div>
              )}
            </div>
          )}
          <div className="agent-section">
            <div className="agent-section-head static">
              <span className="lbl">Report</span>
            </div>
            {result ? (
              <OutputBlock text={result.output} />
            ) : (
              <div className="tool-running">working…</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentStatusBadge({
  status,
  hasResult,
  isError,
}: {
  status: ToolStatus;
  hasResult: boolean;
  isError: boolean | undefined;
}) {
  if (!hasResult) {
    return <span className="diff-pill info">running</span>;
  }
  if (isError) {
    return <span className="diff-pill del">failed</span>;
  }
  if (status === "warn") {
    return <span className="diff-pill info">interrupted</span>;
  }
  return <span className="diff-pill add">done</span>;
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

// Scroll the capsule into view after the expanded body has laid out, but
// only when its bottom is below the scroll container. We defer to rAF so
// React's commit + the browser's layout pass for the now-mounted body have
// finished — measuring before that would use the pre-expand height.
function scrollIntoViewIfClipped(el: HTMLElement | null) {
  if (!el) return;
  requestAnimationFrame(() => {
    const container = findScrollContainer(el);
    const r = el.getBoundingClientRect();
    if (container) {
      const c = container.getBoundingClientRect();
      if (r.bottom <= c.bottom && r.top >= c.top) return;
    } else {
      if (r.bottom <= window.innerHeight && r.top >= 0) return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

function findScrollContainer(el: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement;
  while (p) {
    const style = getComputedStyle(p);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      p.scrollHeight > p.clientHeight
    ) {
      return p;
    }
    p = p.parentElement;
  }
  return null;
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
    case "agent":
      // Agent has its own tone (plum-tinted) distinct from task/skill (amber)
      // so the subagent capsule reads as a different *kind* of work — a
      // delegate doing its own loop — and isn't confused with TaskCreate /
      // TaskUpdate or Skill invocations.
      return "agent";
    case "task":
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
      return <AgentSpawnIcon />;
    case "task":
      return <ListIcon />;
    case "skill":
      return <SparkIcon />;
    default:
      return <SparkIcon />;
  }
}

// Subagent glyph — a small node branching to a second node, signaling
// "this hands off to another agent." Lives here (not in icons.tsx)
// because it's only used by Agent-toned capsules.
function AgentSpawnIcon() {
  return (
    <svg
      width="13" height="13" viewBox="0 0 24 24"
      stroke-width="2" fill="none" stroke="currentColor"
      stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="5" cy="6" r="2.2"></circle>
      <circle cx="19" cy="18" r="2.2"></circle>
      <path d="M7 7.5 Q 12 11 17 16.5"></path>
    </svg>
  );
}
