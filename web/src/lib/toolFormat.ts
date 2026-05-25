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
}

export function summarizeToolUse({
  name,
  input,
  meta,
  hasResult,
  isError,
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
      const sub =
        typeof obj.subagent_type === "string" ? obj.subagent_type : "agent";
      const desc =
        typeof obj.description === "string" ? obj.description : undefined;
      return {
        tone: "agent",
        label: `Agent · ${sub}`,
        detail: desc,
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
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskStop":
    case "TaskList":
    case "TaskGet":
    case "TaskOutput": {
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
