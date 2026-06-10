import fs from "node:fs/promises";
import {
  parseTranscript,
  ToolNameIndex,
  type TranscriptEvent,
} from "./transcript.js";

// Opening a session used to read + parse the full JSONL three times: once
// for the transcript GET, once to prime the stream's ToolNameIndex, and once
// to replay history through PromptState. On a multi-MB transcript over a
// phone connection that triple read dominated session-switch latency. This
// cache parses once and hands the same result to all three consumers,
// validated against the file's stat on every read so an appended/rewritten
// file is never served stale.

export interface CachedTranscript {
  // INVARIANT: shared by reference across every concurrent consumer
  // (transcript GET serialization, PromptState replay, multiple streams).
  // No consumer may mutate this array or the events in it — enrichment
  // must copy (ToolNameIndex.enrich already does).
  events: TranscriptEvent[];
  // Byte offset at EOF when parsed — the resume cursor for /stream.
  offset: number;
  size: number;
  mtimeMs: number;
  // The index built during the parse. Shared with the live stream so
  // tool_result enrichment works without re-reading the file. Streams may
  // keep appending names to it; that's idempotent and safe.
  toolNames: ToolNameIndex;
}

export interface TranscriptCacheDeps {
  stat: (p: string) => Promise<{ size: number; mtimeMs: number }>;
  readFile: (p: string) => Promise<Buffer>;
}

const defaultDeps: TranscriptCacheDeps = {
  stat: (p) => fs.stat(p),
  readFile: (p) => fs.readFile(p),
};

export class TranscriptCache {
  // Map iteration order doubles as the LRU order: re-inserting on hit moves
  // the entry to the back, evictions take the front.
  private entries = new Map<string, CachedTranscript>();

  constructor(
    private maxEntries = 20,
    private deps: TranscriptCacheDeps = defaultDeps,
  ) {}

  /**
   * Read + parse a transcript, served from cache when the file's size and
   * mtime are unchanged. Throws (like fs) when the file is missing.
   */
  async read(filePath: string): Promise<CachedTranscript> {
    const stat = await this.deps.stat(filePath);
    const cached = this.entries.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      this.entries.delete(filePath);
      this.entries.set(filePath, cached);
      return cached;
    }
    const buf = await this.deps.readFile(filePath);
    const toolNames = new ToolNameIndex();
    const events = parseTranscript(buf.toString("utf8"), toolNames);
    const entry: CachedTranscript = {
      events,
      offset: buf.length,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      toolNames,
    };
    this.entries.delete(filePath);
    this.entries.set(filePath, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry;
  }
}
