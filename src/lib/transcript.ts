import fs from "node:fs/promises";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

// Typed view of the raw `toolUseResult` field Claude Code writes alongside
// each tool_result entry. Only tools whose structure pays off in rendering get
// a dedicated shape; everything else falls through as `raw` so nothing is
// silently dropped. Add new kinds as they become useful — the consumer is
// expected to handle `raw` as a graceful default.
export type ToolResultMeta =
  | {
      kind: "read";
      filePath: string;
      numLines: number;
      totalLines: number;
      startLine: number;
    }
  | {
      kind: "bash";
      stderr: string;
      interrupted: boolean;
      backgroundTaskId?: string;
      returnCodeInterpretation?: string;
    }
  | {
      kind: "edit";
      filePath: string;
      replaceAll: boolean;
      userModified: boolean;
      structuredPatch?: unknown;
    }
  | {
      kind: "write";
      filePath: string;
      // "create" for new files, "update" for overwrites. Other values pass
      // through as-is; this is what Claude Code actually emits.
      type: string;
      userModified: boolean;
      structuredPatch?: unknown;
    }
  | {
      kind: "glob";
      numFiles: number;
      truncated: boolean;
      durationMs: number;
      // First N filenames — Claude Code already truncates server-side when
      // there are too many. Treat as a preview list, not authoritative.
      filenames: string[];
    }
  | {
      kind: "webfetch";
      url: string;
      code: number;
      codeText: string;
      bytes: number;
      durationMs: number;
    }
  | {
      kind: "websearch";
      query: string;
      searchCount: number;
      durationSeconds: number;
      resultCount: number;
    }
  // Fallback for tools we haven't typed (MCP tools, Agent, Task*, Skill, etc.)
  // and for the string error shapes most tools degrade to on failure.
  | { kind: "raw"; data: unknown };

export type TranscriptEvent =
  | { kind: "user"; uuid: string; ts: string; text: string }
  | { kind: "assistant"; uuid: string; ts: string; blocks: ContentBlock[] }
  | {
      kind: "tool_result";
      uuid: string;
      ts: string;
      toolUseId: string;
      // Resolved by walking the stream and matching `toolUseId` against a
      // prior assistant `tool_use` block. Undefined when the matching
      // tool_use isn't in scope (e.g. an SSE consumer that started watching
      // after the use was written) — renderers should degrade gracefully.
      toolName?: string;
      output: string;
      isError: boolean;
      // Typed view of the raw `toolUseResult` field. Undefined when the
      // raw entry didn't have one (older Claude Code, errors that don't
      // produce structured output). See `extractToolMeta` for the mapping.
      meta?: ToolResultMeta;
    }
  | { kind: "system"; uuid: string; ts: string; text: string };

type RawEntry = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    content?: unknown;
  };
  // Sibling to `message`. Carries the structured tool-output shape Claude
  // Code records alongside each tool_result. Type is `unknown` because the
  // shape varies per tool — see `extractToolMeta` for the dispatch.
  toolUseResult?: unknown;
};

const SYSTEM_REMINDER_RE = /^<system-reminder>([\s\S]*)<\/system-reminder>$/;
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const LOCAL_STDOUT_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;

function stripSystemReminder(text: string): string {
  const m = text.trim().match(SYSTEM_REMINDER_RE);
  return m ? m[1].trim() : text;
}

function isWholeSystemReminder(text: string): boolean {
  return SYSTEM_REMINDER_RE.test(text.trim());
}

// Detect the `<command-name>/cmd</command-name>` wrapper Claude Code emits
// when the user invokes a slash command from the CLI. The content is
// otherwise mostly XML noise we don't want in the bubble.
function isSlashCommandWrapper(text: string): boolean {
  return COMMAND_NAME_RE.test(text);
}

// Pull a clean "/cmd args" string out of the wrapper. Returns null if the
// content doesn't match the expected shape (in which case fall through to
// rendering the raw text).
function extractSlashCommand(text: string): string | null {
  const name = text.match(COMMAND_NAME_RE)?.[1]?.trim();
  if (!name) return null;
  const args = text.match(COMMAND_ARGS_RE)?.[1]?.trim() ?? "";
  return args ? `${name} ${args}` : name;
}

// Local-command output is wrapped in `<local-command-stdout>…</…>`. The
// "(no content)" sentinel means the command emitted nothing — render as an
// empty system row rather than literal "(no content)".
function isLocalCommandWrapper(text: string): boolean {
  return LOCAL_STDOUT_RE.test(text);
}

function extractLocalCommandOutput(text: string): string {
  const m = text.match(LOCAL_STDOUT_RE);
  if (!m) return "";
  const body = m[1].trim();
  return body === "(no content)" ? "" : body;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c)
          return String((c as { text: unknown }).text);
        return JSON.stringify(c);
      })
      .join("");
  }
  return JSON.stringify(content);
}

function parseAssistantBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      out.push({ type: "thinking", text: b.thinking });
    } else if (
      b.type === "tool_use" &&
      typeof b.id === "string" &&
      typeof b.name === "string"
    ) {
      out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
  }
  return out;
}

function parseToolResultUser(entry: RawEntry): TranscriptEvent | null {
  const content = entry.message?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (!first || typeof first !== "object") return null;
  const b = first as Record<string, unknown>;
  if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") return null;
  const meta = entry.toolUseResult !== undefined
    ? extractToolMeta(undefined, entry.toolUseResult)
    : undefined;
  return {
    kind: "tool_result",
    uuid: entry.uuid ?? "",
    ts: entry.timestamp ?? "",
    toolUseId: b.tool_use_id,
    output: stringifyContent(b.content),
    isError: b.is_error === true,
    meta,
  };
}

/**
 * Parse an array-content user message that is *not* a tool_result. This is
 * how Claude Code records messages that arrive with attachments: a list of
 * `{type:"text",text}` and `{type:"image", source}` blocks. Without this
 * handling the message would vanish from the transcript.
 *
 * Returns null when the array has no recognisable content (so callers can
 * fall back to other branches), otherwise yields a user (or system, when
 * `isMeta=true`) event with text + an `[image attached]` marker per image
 * so the reader knows attachments were sent without us inlining base64.
 */
function parseMultiContentUser(entry: RawEntry): TranscriptEvent | null {
  const content = entry.message?.content;
  if (!Array.isArray(content) || content.length === 0) return null;

  const texts: string[] = [];
  let imageCount = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      if (b.text.length > 0) texts.push(b.text);
    } else if (b.type === "image") {
      imageCount += 1;
    }
  }
  if (texts.length === 0 && imageCount === 0) return null;

  const textJoined = texts.join("\n");
  const imageMarker =
    imageCount > 0
      ? imageCount === 1
        ? "[image attached]"
        : `[${imageCount} images attached]`
      : "";
  const text = [textJoined, imageMarker].filter(Boolean).join("\n");

  // `isMeta=true` on a content-array row means Claude Code recorded it as
  // bookkeeping (the synthesised "[Image: source: ...]" placeholders after
  // a CLI paste). Surface them as system rows so they don't masquerade as
  // user input the model actually saw.
  if (entry.isMeta === true) {
    return {
      kind: "system",
      uuid: entry.uuid ?? "",
      ts: entry.timestamp ?? "",
      text,
    };
  }
  return {
    kind: "user",
    uuid: entry.uuid ?? "",
    ts: entry.timestamp ?? "",
    text,
  };
}

// Type-narrowing helpers for the raw JSONL records — every field is unknown
// until proven otherwise. Keeps `extractToolMeta` readable.
function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function asBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Map a raw `toolUseResult` blob to a typed `ToolResultMeta`. The `toolName`
 * is optional — when omitted (e.g. the matching tool_use hasn't been seen
 * yet), we still return `{kind: "raw", data}` so the consumer can render
 * something useful. When the shape doesn't match the expected schema for a
 * known tool, we also fall back to `raw` rather than emit a half-parsed view.
 */
export function extractToolMeta(
  toolName: string | undefined,
  raw: unknown,
): ToolResultMeta {
  const obj = asObject(raw);
  if (!obj) return { kind: "raw", data: raw };

  switch (toolName) {
    case "Read": {
      const file = asObject(obj.file);
      if (!file) return { kind: "raw", data: raw };
      return {
        kind: "read",
        filePath: asString(file.filePath),
        numLines: asNumber(file.numLines),
        totalLines: asNumber(file.totalLines),
        startLine: asNumber(file.startLine, 1),
      };
    }
    case "Bash": {
      return {
        kind: "bash",
        stderr: asString(obj.stderr),
        interrupted: asBool(obj.interrupted),
        backgroundTaskId:
          typeof obj.backgroundTaskId === "string"
            ? obj.backgroundTaskId
            : undefined,
        returnCodeInterpretation:
          typeof obj.returnCodeInterpretation === "string"
            ? obj.returnCodeInterpretation
            : undefined,
      };
    }
    case "Edit": {
      if (typeof obj.filePath !== "string") return { kind: "raw", data: raw };
      return {
        kind: "edit",
        filePath: obj.filePath,
        replaceAll: asBool(obj.replaceAll),
        userModified: asBool(obj.userModified),
        structuredPatch: obj.structuredPatch,
      };
    }
    case "Write": {
      if (typeof obj.filePath !== "string") return { kind: "raw", data: raw };
      return {
        kind: "write",
        filePath: obj.filePath,
        type: asString(obj.type, "update"),
        userModified: asBool(obj.userModified),
        structuredPatch: obj.structuredPatch,
      };
    }
    case "Glob": {
      return {
        kind: "glob",
        numFiles: asNumber(obj.numFiles),
        truncated: asBool(obj.truncated),
        durationMs: asNumber(obj.durationMs),
        filenames: asStringArray(obj.filenames),
      };
    }
    case "WebFetch": {
      return {
        kind: "webfetch",
        url: asString(obj.url),
        code: asNumber(obj.code),
        codeText: asString(obj.codeText),
        bytes: asNumber(obj.bytes),
        durationMs: asNumber(obj.durationMs),
      };
    }
    case "WebSearch": {
      const results = Array.isArray(obj.results) ? obj.results : [];
      return {
        kind: "websearch",
        query: asString(obj.query),
        searchCount: asNumber(obj.searchCount),
        durationSeconds: asNumber(obj.durationSeconds),
        resultCount: results.length,
      };
    }
    default:
      return { kind: "raw", data: raw };
  }
}

/**
 * Tracks tool-use id → tool name across a stream of events. Same instance
 * works for both the batch parse and the SSE streaming path. The stateful
 * wrapper exists because a `tool_result` line on its own doesn't know which
 * tool produced it — only the prior `tool_use` block does.
 *
 * Memory: one Map entry per assistant tool call. We never delete entries
 * (a single transcript stays bounded by the actual tool calls in it), so a
 * long-running stream holds at most O(toolCalls) names. For interactive
 * sessions that's negligible; if it ever isn't, we can evict on result.
 */
export class ToolNameIndex {
  private names = new Map<string, string>();

  /** Record every tool_use block from an assistant event. Idempotent. */
  noteAssistant(blocks: ContentBlock[]): void {
    for (const b of blocks) {
      if (b.type === "tool_use") this.names.set(b.id, b.name);
    }
  }

  /** Resolve a tool_use_id to its name, or undefined if unknown. */
  resolve(toolUseId: string): string | undefined {
    return this.names.get(toolUseId);
  }

  /**
   * Enrich a tool_result event in place: fills `toolName` from the index
   * and re-runs `extractToolMeta` against the resolved name. Returns a new
   * event (we don't mutate). If `rawMeta` is supplied, it overrides the
   * event's existing `meta`; otherwise we re-extract from the existing
   * `meta.data` when it's a `raw` carry-over.
   */
  enrich(ev: Extract<TranscriptEvent, { kind: "tool_result" }>): Extract<
    TranscriptEvent,
    { kind: "tool_result" }
  > {
    const toolName = this.resolve(ev.toolUseId);
    if (!toolName) return ev;
    // If meta is still `raw` (parsed without name context), re-extract now
    // that we have the name.
    const meta =
      ev.meta?.kind === "raw"
        ? extractToolMeta(toolName, ev.meta.data)
        : ev.meta;
    return { ...ev, toolName, meta };
  }
}

export function parseLine(line: string): TranscriptEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let entry: RawEntry;
  try {
    entry = JSON.parse(trimmed) as RawEntry;
  } catch {
    return null;
  }
  if (entry.type === "user") {
    const content = entry.message?.content;
    if (typeof content === "string") {
      // Slash-command invocation: extract "/cmd [args]" from the XML
      // wrapper and surface it as a clean user message. These are real
      // user-initiated turns; we just don't want the wrapper in the bubble.
      if (isSlashCommandWrapper(content)) {
        const clean = extractSlashCommand(content);
        if (clean) {
          return {
            kind: "user",
            uuid: entry.uuid ?? "",
            ts: entry.timestamp ?? "",
            text: clean,
          };
        }
        // Malformed wrapper — fall through to the system/user branches.
      }
      // Local-command stdout: bookkeeping, not user input. Surface as a
      // system row (or skip the synthetic "(no content)" sentinel).
      if (isLocalCommandWrapper(content)) {
        return {
          kind: "system",
          uuid: entry.uuid ?? "",
          ts: entry.timestamp ?? "",
          text: extractLocalCommandOutput(content),
        };
      }
      if (entry.isMeta === true || isWholeSystemReminder(content)) {
        return {
          kind: "system",
          uuid: entry.uuid ?? "",
          ts: entry.timestamp ?? "",
          text: stripSystemReminder(content),
        };
      }
      return {
        kind: "user",
        uuid: entry.uuid ?? "",
        ts: entry.timestamp ?? "",
        text: content,
      };
    }
    // Array content — try tool_result first (the common case at 2372:1
    // versus the ~70 array-shaped user messages with images), then fall
    // back to the multi-content user/system shape.
    return parseToolResultUser(entry) ?? parseMultiContentUser(entry);
  }
  if (entry.type === "assistant") {
    return {
      kind: "assistant",
      uuid: entry.uuid ?? "",
      ts: entry.timestamp ?? "",
      blocks: parseAssistantBlocks(entry.message?.content),
    };
  }
  return null;
}

/**
 * Parse a multi-line JSONL blob and return enriched events. The second pass
 * resolves `toolName` and re-extracts `meta` once the matching tool_use is
 * known — single-pass-with-state because tool_use always precedes its
 * tool_result in the file.
 */
export function parseTranscript(blob: string): TranscriptEvent[] {
  const index = new ToolNameIndex();
  const out: TranscriptEvent[] = [];
  for (const line of blob.split("\n")) {
    const ev = parseLine(line);
    if (!ev) continue;
    if (ev.kind === "assistant") {
      index.noteAssistant(ev.blocks);
      out.push(ev);
    } else if (ev.kind === "tool_result") {
      out.push(index.enrich(ev));
    } else {
      out.push(ev);
    }
  }
  return out;
}

/**
 * Build a lookup `tool_use_id → tool_result` over a stream of events. Used by
 * the renderer to fuse each tool_use block with its result inline, rather
 * than rendering them as two unrelated rows. Tool_results that have no
 * matching tool_use (e.g. the assistant entry was pruned, or the stream
 * starts mid-conversation) are not included — the renderer can still walk
 * `events` directly to surface orphans.
 */
export function indexToolResults(
  events: TranscriptEvent[],
): Map<string, Extract<TranscriptEvent, { kind: "tool_result" }>> {
  const out = new Map<
    string,
    Extract<TranscriptEvent, { kind: "tool_result" }>
  >();
  for (const ev of events) {
    if (ev.kind === "tool_result") out.set(ev.toolUseId, ev);
  }
  return out;
}

export async function readTranscriptFile(
  filePath: string,
): Promise<{ events: TranscriptEvent[]; offset: number }> {
  const buf = await fs.readFile(filePath);
  return { events: parseTranscript(buf.toString("utf8")), offset: buf.length };
}

export async function readFromOffset(
  filePath: string,
  offset: number,
  index?: ToolNameIndex,
): Promise<{ events: TranscriptEvent[]; offset: number }> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size <= offset) return { events: [], offset };
    const length = stat.size - offset;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, offset);
    const events: TranscriptEvent[] = [];
    for (const line of buf.toString("utf8").split("\n")) {
      const ev = parseLine(line);
      if (!ev) continue;
      if (index && ev.kind === "assistant") {
        index.noteAssistant(ev.blocks);
        events.push(ev);
      } else if (index && ev.kind === "tool_result") {
        events.push(index.enrich(ev));
      } else {
        events.push(ev);
      }
    }
    return { events, offset: stat.size };
  } finally {
    await handle.close();
  }
}
