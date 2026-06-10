import fs from "node:fs/promises";
import {
  asNumber,
  asObject,
  extractToolMeta,
  ToolNameIndex,
} from "../shared/protocol.js";
import type {
  ContentBlock,
  MessageUsage,
  ToolResultEvent,
  ToolResultMeta,
  TranscriptEvent,
} from "../shared/protocol.js";

export type {
  ContentBlock,
  MessageUsage,
  ToolResultEvent,
  ToolResultMeta,
  TranscriptEvent,
};
// Moved to the shared protocol (the web client needs them for delta
// enrichment); re-exported so server-side callers keep their import path.
export { extractToolMeta, ToolNameIndex };

type RawEntry = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  // Claude Code marks transient API failures with `isApiErrorMessage: true`.
  // Surfaced on assistant events so the rail can render a retries pill.
  isApiErrorMessage?: boolean;
  retryAttempt?: number;
  message?: {
    role?: string;
    content?: unknown;
    // Anthropic-shaped fields on assistant rows. Only the bits we surface
    // are typed; the rest stays unknown.
    model?: unknown;
    stop_reason?: unknown;
    usage?: unknown;
  };
  // Sibling to `message`. Carries the structured tool-output shape Claude
  // Code records alongside each tool_result. Type is `unknown` because the
  // shape varies per tool — see `extractToolMeta` for the dispatch.
  toolUseResult?: unknown;
  // Present on `type:"attachment"` rows. The inner `type` discriminates
  // between bookkeeping (`deferred_tools_delta`) and user-facing payloads
  // like `queued_command` (a prompt the user typed while the model was
  // busy — Claude Code never writes a `type:"user"` row for these).
  attachment?: {
    type?: string;
    prompt?: string;
    commandMode?: string;
  };
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

// Pull token counts off the Anthropic-shaped `usage` object Claude Code
// persists on every assistant row. Missing fields default to 0 so callers
// can sum without nullish checks. Returns undefined only when the input is
// not an object at all (synthesised rows where the API never ran).
export function parseUsage(raw: unknown): MessageUsage | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;
  const serverToolUse = asObject(obj.server_tool_use);
  return {
    inputTokens: asNumber(obj.input_tokens),
    outputTokens: asNumber(obj.output_tokens),
    cacheCreationInputTokens: asNumber(obj.cache_creation_input_tokens),
    cacheReadInputTokens: asNumber(obj.cache_read_input_tokens),
    webSearchRequests: asNumber(serverToolUse?.web_search_requests),
    webFetchRequests: asNumber(serverToolUse?.web_fetch_requests),
  };
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
    const msg = entry.message;
    const usage = parseUsage(msg?.usage);
    const model = typeof msg?.model === "string" ? msg.model : undefined;
    const stopReason =
      typeof msg?.stop_reason === "string" ? msg.stop_reason : undefined;
    const isApiError = entry.isApiErrorMessage === true || undefined;
    const retryAttempt =
      typeof entry.retryAttempt === "number" ? entry.retryAttempt : undefined;
    return {
      kind: "assistant",
      uuid: entry.uuid ?? "",
      ts: entry.timestamp ?? "",
      blocks: parseAssistantBlocks(msg?.content),
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(stopReason ? { stopReason } : {}),
      ...(isApiError ? { isApiError } : {}),
      ...(retryAttempt !== undefined ? { retryAttempt } : {}),
    };
  }
  // Queued user prompts: when the user types into the composer while the
  // model is busy, Claude Code writes a `type:"attachment"` row with
  // `attachment.type === "queued_command"` instead of a `type:"user"` row.
  // This is the only record carrying the prompt text — without this branch
  // the queued message never appears in the transcript, even after the
  // model eventually processes it.
  if (entry.type === "attachment") {
    const att = entry.attachment;
    if (att?.type === "queued_command" && typeof att.prompt === "string") {
      return {
        kind: "user",
        uuid: entry.uuid ?? "",
        ts: entry.timestamp ?? "",
        text: att.prompt,
      };
    }
    return null;
  }
  return null;
}

/**
 * Parse a multi-line JSONL blob and return enriched events. The second pass
 * resolves `toolName` and re-extracts `meta` once the matching tool_use is
 * known — single-pass-with-state because tool_use always precedes its
 * tool_result in the file. Callers that need the populated index afterwards
 * (e.g. to seed a live stream's enrichment) can pass their own.
 */
export function parseTranscript(
  blob: string,
  index: ToolNameIndex = new ToolNameIndex(),
): TranscriptEvent[] {
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

export { indexToolResults } from "../shared/protocol.js";

export async function readTranscriptFile(
  filePath: string,
): Promise<{ events: TranscriptEvent[]; offset: number }> {
  const buf = await fs.readFile(filePath);
  return { events: parseTranscript(buf.toString("utf8")), offset: buf.length };
}

// Claude Code rewrites the title repeatedly as it refines, so the last
// occurrence wins. Scanning only the tail keeps this cheap on multi-MB files.
const TITLE_TAIL_BYTES = 32 * 1024;

export async function readSessionTitle(
  filePath: string,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, TITLE_TAIL_BYTES);
    const offset = stat.size - length;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, offset);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"ai-title"')) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          aiTitle?: string;
        };
        if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
          return entry.aiTitle;
        }
      } catch {
        /* truncated head-line at the tail-read boundary — keep walking */
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

// How far back from the client's offset we look for the event the client
// saw last. Trailing rows are often non-events (system rows, ai-title
// rewrites) and individual event lines can be large, so the window has to
// be generous. A window that yields no verdict fails the check (→ reset),
// which is the safe direction — just a wasted full refetch.
const CONTINUITY_WINDOW_BYTES = 64 * 1024;

/**
 * Continuity check for `?after=<offset>` delta reads: does the content
 * immediately before `offset` end with the event the client saw last?
 * JSONL is append-only, so byte offsets are perfect cursors — except when a
 * file is rewritten (compaction, manual truncation). Reading a window
 * ending at the cursor and matching against the client's `lastUuid`
 * detects that case without hashing or a server-side transcript DB.
 *
 * Two passes over the window, both walking backwards (the window's first
 * line is usually truncated mid-record and parses to null):
 *
 * 1. The last complete *client-visible event* line must carry `lastUuid` —
 *    strict positional match.
 * 2. If the window holds no event line at all (the tail is bookkeeping
 *    rows, which is common — they're what usually separates the cursor
 *    from the last real event), accept a raw line whose `uuid` or
 *    `parentUuid` references `lastUuid`: descendants prove the client's
 *    last event exists in this file before the cursor.
 */
export async function confirmTranscriptContinuity(
  filePath: string,
  offset: number,
  lastUuid: string,
): Promise<boolean> {
  if (offset <= 0) return false;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return false;
  }
  try {
    const stat = await handle.stat();
    if (offset > stat.size) return false;
    const length = Math.min(offset, CONTINUITY_WINDOW_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, offset - length);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const ev = parseLine(lines[i]);
      if (ev && ev.uuid) return ev.uuid === lastUuid;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as {
          uuid?: unknown;
          parentUuid?: unknown;
        };
        if (raw.uuid === lastUuid || raw.parentUuid === lastUuid) return true;
      } catch {
        /* truncated head line — keep walking */
      }
    }
    return false;
  } finally {
    await handle.close();
  }
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
