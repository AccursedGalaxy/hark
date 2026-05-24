import fs from "node:fs/promises";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type TranscriptEvent =
  | { kind: "user"; uuid: string; ts: string; text: string }
  | { kind: "assistant"; uuid: string; ts: string; blocks: ContentBlock[] }
  | {
      kind: "tool_result";
      uuid: string;
      ts: string;
      toolUseId: string;
      output: string;
      isError: boolean;
    };

type RawEntry = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

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
  return {
    kind: "tool_result",
    uuid: entry.uuid ?? "",
    ts: entry.timestamp ?? "",
    toolUseId: b.tool_use_id,
    output: stringifyContent(b.content),
    isError: b.is_error === true,
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
      return {
        kind: "user",
        uuid: entry.uuid ?? "",
        ts: entry.timestamp ?? "",
        text: content,
      };
    }
    return parseToolResultUser(entry);
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

export function parseTranscript(blob: string): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  for (const line of blob.split("\n")) {
    const ev = parseLine(line);
    if (ev) out.push(ev);
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
): Promise<{ events: TranscriptEvent[]; offset: number }> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size <= offset) return { events: [], offset };
    const length = stat.size - offset;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, offset);
    return {
      events: parseTranscript(buf.toString("utf8")),
      offset: stat.size,
    };
  } finally {
    await handle.close();
  }
}
