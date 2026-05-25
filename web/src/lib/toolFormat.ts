// Per-tool presentation helpers. Given a `tool_use` block (the request) and
// optionally the matching `ToolResultEvent` (the outcome), produce the small
// pieces the ToolCall component needs to render a single capsule: a colour
// tone, a one-line label, an optional dim sub-line, and zero or more badges.
//
// Add a new tool by extending the switch in `summarizeToolUse`. Unknown
// tools fall through to a neutral display rather than throwing.

import type { ToolResultEvent, ToolResultMeta } from "./protocol";
import { basename, tildeify } from "./format";

// Colour family for the icon + left edge. Stays in the theme's accent
// vocabulary — we never reach for raw hex. Each tone maps to a CSS class.
export type ToolTone =
  | "read"
  | "bash"
  | "edit"
  | "write"
  | "search"
  | "web"
  | "agent"
  | "task"
  | "skill"
  | "neutral";

// Agent / subagent tool calls get their own capsule variant — see
// `AgentCapsule` in components/ToolCapsule.tsx. We still emit a summary
// from `summarizeToolUse` so other code paths (search, debugging) can
// reason about them uniformly, but the renderer picks the dedicated
// component based on `name === "Agent"`.

export type BadgeTone = "good" | "bad" | "info" | "warn";

export interface ToolBadge {
  text: string;
  tone?: BadgeTone;
}

export interface ToolSummary {
  tone: ToolTone;
  // Compact label after the icon. Mono-styled. Examples:
  // "Read package.json", "$ ls -la /home/aki", "Edit transcript.ts".
  label: string;
  // Optional sub-line (dim sans). Examples: command description, fetched URL.
  detail?: string;
  // Right-aligned chips: line counts, status codes, +/- diff counts.
  badges?: ToolBadge[];
}

const MAX_LABEL = 80;

function truncate(s: string, n = MAX_LABEL): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function shortPath(p: string): string {
  return tildeify(p);
}

// Count +/- prefixed lines in a structuredPatch (unified-diff style array
// of hunks). Returns null if the patch isn't the expected shape.
function countPatch(
  patch: unknown,
): { added: number; removed: number } | null {
  if (!Array.isArray(patch)) return null;
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    if (!hunk || typeof hunk !== "object") continue;
    const lines = (hunk as { lines?: unknown }).lines;
    if (!Array.isArray(lines)) continue;
    for (const ln of lines) {
      if (typeof ln !== "string") continue;
      if (ln.startsWith("+")) added++;
      else if (ln.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

// Heuristic: pluck the most useful field out of an unknown tool's input so
// the collapsed card still says something. Avoids dumping whole JSON.
function pickInputBlurb(input: unknown): string {
  if (typeof input === "string") return truncate(input);
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of [
    "command",
    "query",
    "url",
    "prompt",
    "subject",
    "description",
    "file_path",
    "path",
    "pattern",
    "message",
  ]) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return truncate(v);
  }
  // Last resort: a tiny JSON peek.
  return truncate(JSON.stringify(input), 60);
}

interface Args {
  name: string;
  input: unknown;
  meta?: ToolResultMeta;
  isError?: boolean;
  hasResult: boolean;
  // Subject of the task this call refers to, looked up from the session's
  // running TaskCreate→TaskUpdate state. Lets TaskUpdate rows say *what*
  // changed, not just `Task #N`.
  taskSubject?: string;
}

export function summarizeToolUse({
  name,
  input,
  meta,
  hasResult,
  isError,
  taskSubject,
}: Args): ToolSummary {
  const obj = (input && typeof input === "object")
    ? (input as Record<string, unknown>)
    : {};

  switch (name) {
    case "Read": {
      const p = typeof obj.file_path === "string" ? obj.file_path : "";
      const badges: ToolBadge[] = [];
      if (meta?.kind === "read") {
        badges.push({ text: `${meta.totalLines} lines` });
      }
      return {
        tone: "read",
        label: p ? basename(p) : "Read",
        detail: p ? shortPath(p) : undefined,
        badges,
      };
    }
    case "Edit": {
      const p =
        typeof obj.file_path === "string"
          ? obj.file_path
          : meta?.kind === "edit"
            ? meta.filePath
            : "";
      const badges: ToolBadge[] = [];
      if (meta?.kind === "edit") {
        const diff = countPatch(meta.structuredPatch);
        if (diff) {
          if (diff.added) badges.push({ text: `+${diff.added}`, tone: "good" });
          if (diff.removed)
            badges.push({ text: `−${diff.removed}`, tone: "bad" });
        }
        if (meta.replaceAll) badges.push({ text: "replace all", tone: "info" });
      }
      return {
        tone: "edit",
        label: p ? basename(p) : "Edit",
        detail: p ? shortPath(p) : undefined,
        badges,
      };
    }
    case "Write": {
      const p =
        typeof obj.file_path === "string"
          ? obj.file_path
          : meta?.kind === "write"
            ? meta.filePath
            : "";
      const isCreate = meta?.kind === "write" && meta.type === "create";
      const badges: ToolBadge[] = [];
      if (isCreate) badges.push({ text: "new", tone: "good" });
      else if (meta?.kind === "write")
        badges.push({ text: "overwrite", tone: "info" });
      if (meta?.kind === "write") {
        const diff = countPatch(meta.structuredPatch);
        if (diff && (diff.added || diff.removed)) {
          if (diff.added) badges.push({ text: `+${diff.added}`, tone: "good" });
          if (diff.removed)
            badges.push({ text: `−${diff.removed}`, tone: "bad" });
        }
      }
      return {
        tone: "write",
        label: p ? basename(p) : "Write",
        detail: p ? shortPath(p) : undefined,
        badges,
      };
    }
    case "Bash": {
      const cmd = typeof obj.command === "string" ? obj.command : "";
      const desc =
        typeof obj.description === "string" ? obj.description : undefined;
      const badges: ToolBadge[] = [];
      if (meta?.kind === "bash") {
        if (meta.interrupted) badges.push({ text: "interrupted", tone: "warn" });
        if (meta.backgroundTaskId)
          badges.push({ text: "background", tone: "info" });
        if (meta.stderr && meta.stderr.trim().length > 0)
          badges.push({ text: "stderr", tone: "warn" });
      }
      return {
        tone: "bash",
        label: cmd ? `$ ${truncate(cmd)}` : "Bash",
        detail: desc,
        badges,
      };
    }
    case "Glob": {
      const pat = typeof obj.pattern === "string" ? obj.pattern : "";
      const badges: ToolBadge[] = [];
      if (meta?.kind === "glob") {
        badges.push({
          text: `${meta.numFiles} ${meta.numFiles === 1 ? "file" : "files"}`,
        });
        if (meta.truncated) badges.push({ text: "truncated", tone: "warn" });
      }
      return {
        tone: "search",
        label: pat ? `Glob "${truncate(pat)}"` : "Glob",
        detail:
          typeof obj.path === "string" && obj.path ? shortPath(obj.path) : undefined,
        badges,
      };
    }
    case "Grep": {
      const pat = typeof obj.pattern === "string" ? obj.pattern : "";
      return {
        tone: "search",
        label: pat ? `Grep "${truncate(pat)}"` : "Grep",
        detail:
          typeof obj.path === "string" && obj.path ? shortPath(obj.path) : undefined,
      };
    }
    case "WebFetch": {
      const url = typeof obj.url === "string" ? obj.url : "";
      const badges: ToolBadge[] = [];
      if (meta?.kind === "webfetch") {
        const ok = meta.code >= 200 && meta.code < 300;
        badges.push({
          text: `${meta.code} ${meta.codeText}`.trim(),
          tone: ok ? "good" : "bad",
        });
        if (meta.bytes)
          badges.push({ text: formatBytes(meta.bytes), tone: "info" });
      }
      return {
        tone: "web",
        label: url ? hostFromUrl(url) : "WebFetch",
        detail: url ? truncate(url) : undefined,
        badges,
      };
    }
    case "WebSearch": {
      const q = typeof obj.query === "string" ? obj.query : "";
      const badges: ToolBadge[] = [];
      if (meta?.kind === "websearch") {
        badges.push({
          text: `${meta.resultCount} ${meta.resultCount === 1 ? "result" : "results"}`,
        });
      }
      return {
        tone: "web",
        label: q ? `"${truncate(q)}"` : "WebSearch",
        detail: "Web search",
        badges,
      };
    }
    case "Agent": {
      // The dedicated AgentCapsule renderer reads `subagent_type`,
      // `description`, and `prompt` directly. This summary is the
      // text-only fallback (used if the renderer is ever bypassed) and
      // also drives the in-app fuzzy search over tool calls.
      const sub =
        typeof obj.subagent_type === "string" ? obj.subagent_type : "agent";
      const desc =
        typeof obj.description === "string" ? obj.description : undefined;
      return {
        tone: "agent",
        label: desc ? truncate(desc) : `subagent · ${sub}`,
        detail: desc ? `subagent · ${sub}` : undefined,
        badges: [{ text: sub, tone: "info" }],
      };
    }
    case "Skill": {
      const sk = typeof obj.skill === "string" ? obj.skill : "Skill";
      return {
        tone: "skill",
        label: `/${sk}`,
        detail: typeof obj.args === "string" ? obj.args : undefined,
      };
    }
    case "TaskCreate": {
      // Surface the actual task subject + description so the row carries
      // meaning on its own. The aggregate TaskListPanel above the
      // transcript shows the evolving list; these per-call capsules read
      // as "what changed in this turn".
      const subject = typeof obj.subject === "string" ? obj.subject : "";
      const desc =
        typeof obj.description === "string" ? obj.description : undefined;
      const badges: ToolBadge[] = [{ text: "new task", tone: "info" }];
      // Once the result lands we have the canonical id — show it so the
      // capsule and the panel can be cross-referenced.
      const id = readTaskIdFromMeta(meta);
      if (id) badges.unshift({ text: `#${id}` });
      return {
        tone: "task",
        label: subject ? `+ ${truncate(subject)}` : "New task",
        detail: desc,
        badges,
      };
    }
    case "TaskUpdate": {
      const taskId = typeof obj.taskId === "string" ? obj.taskId : "";
      const change = readStatusChange(meta);
      const updatedSubject =
        typeof obj.subject === "string" ? obj.subject : undefined;
      // Prefer a subject rename from the input (the model intentionally
      // chose new wording); fall back to the looked-up subject from state
      // so a status-only update still tells the reader what task it is.
      const subjectForLabel = updatedSubject ?? taskSubject;
      const label = subjectForLabel
        ? taskId
          ? `#${taskId} ${updatedSubject ? "→" : "·"} ${truncate(subjectForLabel)}`
          : truncate(subjectForLabel)
        : taskId
          ? `Task #${taskId}`
          : "Task update";
      const badges: ToolBadge[] = [];
      if (change) {
        const tone: BadgeTone =
          change.to === "completed"
            ? "good"
            : change.to === "in_progress"
              ? "info"
              : change.to === "deleted"
                ? "bad"
                : "warn";
        badges.push({ text: `→ ${shortStatus(change.to)}`, tone });
      } else if (typeof obj.status === "string") {
        badges.push({ text: shortStatus(String(obj.status)), tone: "info" });
      }
      return {
        tone: "task",
        label,
        detail: updatedSubject
          ? undefined
          : typeof obj.description === "string"
            ? obj.description
            : undefined,
        badges,
      };
    }
    case "TaskStop":
    case "TaskList":
    case "TaskGet":
    case "TaskOutput": {
      // Background-task management (TaskStop/TaskOutput/etc.) — different
      // system from the in-session todo list above. Keep the simple form.
      return {
        tone: "task",
        label: name.replace(/^Task/, "Task "),
        detail: pickInputBlurb(input) || undefined,
      };
    }
    default: {
      // Unknown tool — including MCP names like
      // `mcp__plugin_playwright_playwright__browser_click`. The MCP shape is
      // `mcp__<server>__<tool>`; we take just the trailing tool segment for
      // the label and surface the server (de-duped) under it. Anything else
      // we leave alone.
      let label = name;
      let serverLabel: string | undefined;
      if (name.startsWith("mcp__")) {
        const parts = name.split("__");
        const tool = parts[parts.length - 1] ?? name;
        label = tool.replace(/_+/g, " ");
        const server = (parts[1] ?? "")
          .replace(/^plugin_/, "")
          .split("_")
          // Collapse adjacent duplicates: ["playwright","playwright"] → ["playwright"]
          .filter((seg, i, arr) => seg && seg !== arr[i - 1]);
        serverLabel = server.join(" ") || undefined;
      }
      const blurb = pickInputBlurb(input);
      const detail = [serverLabel, blurb].filter(Boolean).join(" · ");
      return {
        tone: "neutral",
        label,
        detail: detail || undefined,
      };
    }
  }

  // Unreachable — every case returns. Kept for future linting safety.
  void hasResult;
  void isError;
}

// TaskCreate's tool_result is `{task:{id, subject}}`. When `meta` carries
// the raw blob (we don't have a typed kind for Task* yet), pluck the id.
function readTaskIdFromMeta(meta: ToolResultMeta | undefined): string | null {
  if (!meta || meta.kind !== "raw") return null;
  const data = meta.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const task = (data as Record<string, unknown>).task;
  if (!task || typeof task !== "object") return null;
  const id = (task as Record<string, unknown>).id;
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number") return String(id);
  return null;
}

// TaskUpdate emits `{success, taskId, updatedFields, statusChange:{from,to}}`.
function readStatusChange(
  meta: ToolResultMeta | undefined,
): { from: string; to: string } | null {
  if (!meta || meta.kind !== "raw") return null;
  const data = meta.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const sc = (data as Record<string, unknown>).statusChange;
  if (!sc || typeof sc !== "object") return null;
  const from = (sc as Record<string, unknown>).from;
  const to = (sc as Record<string, unknown>).to;
  if (typeof from !== "string" || typeof to !== "string") return null;
  return { from, to };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return truncate(url, 40);
  }
}

// Compact status label for Task badges so they don't crowd the capsule head.
// Maps Claude Code's snake_case statuses to short display strings.
function shortStatus(s: string): string {
  switch (s) {
    case "in_progress":
      return "doing";
    case "completed":
      return "done";
    case "pending":
      return "pending";
    case "deleted":
      return "deleted";
    default:
      return s;
  }
}

// Compact one-line summary for an inline Task* row (rendered instead of
// the expandable capsule). Returns the text after the icon — the caller
// adds the glyph. Examples:
//   `+ new · Research all Claude Code prompts`
//   `→ done · Wire task list panel`
//   `→ doing · #3`
//   `renamed · New subject`
//   `removed · Old task`
export interface TaskUpdateLine {
  /** Tone hint so the caller can colour the arrow/verb. */
  tone: "good" | "bad" | "info" | "warn";
  /** The text shown after the icon. */
  text: string;
}

export function summarizeTaskCreate(args: {
  input: unknown;
}): TaskUpdateLine {
  const obj =
    args.input && typeof args.input === "object"
      ? (args.input as Record<string, unknown>)
      : {};
  const subject =
    typeof obj.subject === "string" && obj.subject.length > 0
      ? truncate(obj.subject)
      : "task";
  return { tone: "info", text: `+ new · ${subject}` };
}

export function summarizeTaskUpdate(args: {
  input: unknown;
  meta?: ToolResultMeta;
  taskSubject?: string;
}): TaskUpdateLine {
  const obj =
    args.input && typeof args.input === "object"
      ? (args.input as Record<string, unknown>)
      : {};
  const taskId = typeof obj.taskId === "string" ? obj.taskId : "";
  const renamedSubject =
    typeof obj.subject === "string" && obj.subject.length > 0
      ? obj.subject
      : undefined;
  const change = readStatusChange(args.meta);
  const status =
    change?.to ??
    (typeof obj.status === "string" ? obj.status : undefined);

  const idTag = taskId ? `#${taskId}` : "";
  const subject = renamedSubject ?? args.taskSubject;
  // "#3 Wire task list" — id is shown only when we don't also have a
  // subject from state (otherwise the subject is enough to identify it).
  const ref = subject
    ? truncate(subject)
    : idTag || "task";

  if (status === "deleted") {
    return { tone: "bad", text: `removed · ${ref}` };
  }
  if (status === "completed") {
    return { tone: "good", text: `→ done · ${ref}` };
  }
  if (status === "in_progress") {
    return { tone: "info", text: `→ doing · ${ref}` };
  }
  if (status === "pending") {
    return { tone: "warn", text: `→ pending · ${ref}` };
  }
  if (renamedSubject) {
    return { tone: "info", text: `renamed · ${truncate(renamedSubject)}` };
  }
  return { tone: "info", text: `updated · ${ref}` };
}

// Status: running (no result yet), good (result ok), bad (result error),
// warn (e.g. interrupted, partial). Drives the dot colour + pulse.
export type ToolStatus = "running" | "good" | "bad" | "warn";

export function deriveStatus(
  result: ToolResultEvent | undefined,
): ToolStatus {
  if (!result) return "running";
  if (result.isError) return "bad";
  if (result.meta?.kind === "bash" && result.meta.interrupted) return "warn";
  return "good";
}
