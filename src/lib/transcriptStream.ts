import { watch } from "node:fs";
import fs from "node:fs/promises";
import {
  parseLine,
  readFromOffset,
  ToolNameIndex,
  type TranscriptEvent,
} from "./transcript.js";

// SSE sink. The route handler wires this to an Express `res`; tests wire it
// to a buffer. The module never sees Express or HTTP.
export interface SseWriter {
  // Heartbeat / comment line (`: <text>\n\n`). Used to keep proxies awake;
  // not visible to EventSource consumers.
  comment: (text: string) => void;
  // Named SSE event with a JSON-serialised payload.
  event: (name: string, data: unknown) => void;
}

export interface TranscriptStreamHandle {
  // Stop watch + heartbeat. Idempotent; safe to call from a request close
  // handler that may also be racing the drain loop.
  close: () => void;
}

export interface TranscriptStreamOptions {
  // Called once per drain batch, before events are written to the writer.
  // Lets the caller run side effects (permission resolution, logging) on
  // the exact events the client is about to see.
  onEvents?: (events: TranscriptEvent[]) => void;
  // When true, attach a `_timing` field to each event payload and emit a
  // per-event log line. Off by default.
  timing?: boolean;
  // Heartbeat interval in milliseconds. Default 15_000. Set to 0 to disable
  // (useful in tests).
  heartbeatMs?: number;
  // Log sink for TIMING lines. Defaults to console.log.
  log?: (line: string) => void;
  // Tag included in TIMING log lines so concurrent streams can be told
  // apart. Defaults to "-".
  tag?: string;
  // Byte offset to start streaming from. Defaults to the file's current
  // size (tail-only — the normal case, where the client just fetched the
  // historical transcript over /transcript). Set to 0 (or another value)
  // when the caller knows the file's existing content hasn't been delivered
  // yet — e.g. openLazyTranscriptStream upgrading after a brand-new
  // session's JSONL appears, where fetchTranscript got an empty response
  // because the file didn't exist at fetch time. An offset beyond EOF means
  // the file was rewritten under the client — clamped to 0 so everything is
  // redelivered (the client dedupes by uuid).
  initialOffset?: number;
  // Pre-populated tool_use-id → name index (e.g. from TranscriptCache).
  // When provided, the full-file priming read on open is skipped — the
  // single biggest cost of opening a stream on a large transcript. The
  // stream keeps appending to it as new assistant events arrive.
  toolNames?: ToolNameIndex;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_LAZY_POLL_MS = 500;

/**
 * Open an SSE stream with no source. Emits one `ready` event with offset 0
 * and then only heartbeats until closed. Used for synthetic "pending"
 * sessions whose JSONL will never appear under the current id (a real
 * session id is issued after trust confirmation and the client switches
 * streams then). Holding the connection open (rather than 404'ing) means
 * a mobile EventSource doesn't reconnect-loop while waiting.
 */
export function openEmptyStream(
  writer: SseWriter,
  opts: { heartbeatMs?: number } = {},
): TranscriptStreamHandle {
  writer.event("ready", { offset: 0 });
  return startHeartbeat(writer, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
}

/**
 * Open an SSE stream for a registered session whose JSONL file hasn't been
 * written yet. Emits `ready` immediately, heartbeats while polling for the
 * file to appear, and upgrades to a normal watching stream the moment it
 * does. Without this, a fresh session's first turn lands in the JSONL but
 * the stream sits idle — the user only sees their message after refresh.
 *
 * `resolveFilePath` is called on each poll tick; returning a string ends
 * the wait and starts watching. Returning null keeps waiting.
 */
export function openLazyTranscriptStream(
  resolveFilePath: () => Promise<string | null>,
  writer: SseWriter,
  opts: TranscriptStreamOptions & { pollMs?: number } = {},
): TranscriptStreamHandle {
  writer.event("ready", { offset: 0 });

  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_LAZY_POLL_MS;

  let closed = false;
  // Heartbeat runs until we upgrade; the watching stream then starts its own.
  let activeHandle: TranscriptStreamHandle = startHeartbeat(writer, heartbeatMs);
  let pollTimer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (closed) return;
    let filePath: string | null = null;
    try {
      filePath = await resolveFilePath();
    } catch {
      /* transient lookup error — try again next tick */
    }
    if (closed) return;
    if (!filePath) {
      pollTimer = setTimeout(() => void tick(), pollMs);
      return;
    }
    try {
      // initialOffset: 0 — the file just appeared and the fetchTranscript
      // that the client ran while waiting for it returned empty. Start from
      // the beginning so the first turn (user message + assistant init) is
      // actually delivered; without this the user only sees what arrives
      // after we attach the watcher, which on a fresh session means the
      // assistant's reply but not their own prompt.
      const real = await openTranscriptStream(filePath, writer, {
        ...opts,
        initialOffset: 0,
      });
      if (closed) {
        real.close();
        return;
      }
      activeHandle.close();
      activeHandle = real;
    } catch {
      if (!closed) pollTimer = setTimeout(() => void tick(), pollMs);
    }
  };

  pollTimer = setTimeout(() => void tick(), pollMs);

  return {
    close: () => {
      if (closed) return;
      closed = true;
      if (pollTimer) clearTimeout(pollTimer);
      activeHandle.close();
    },
  };
}

/**
 * Open an SSE stream backed by a JSONL transcript file.
 *
 * Sequence on open: prime a ToolNameIndex from the existing file content
 * (so tool_result events arriving on the stream can be enriched even when
 * their matching tool_use blocks were emitted earlier), stat the file for
 * the initial offset, emit `ready`, then watch the file for changes.
 *
 * Watch-fires trigger a `drain()` that reads from `offset` to EOF, parses
 * new events, runs `onEvents`, and writes each event to the writer. Only
 * one drain runs at a time — fires during a drain are coalesced into the
 * next pass via `pendingWatchTs`, which preserves the first watch-fire
 * timestamp for accurate TIMING latency.
 */
export async function openTranscriptStream(
  filePath: string,
  writer: SseWriter,
  opts: TranscriptStreamOptions = {},
): Promise<TranscriptStreamHandle> {
  const toolNames = opts.toolNames ?? new ToolNameIndex();
  if (!opts.toolNames) {
    try {
      const existing = await fs.readFile(filePath, "utf8");
      for (const line of existing.split("\n")) {
        const ev = parseLine(line);
        if (ev?.kind === "assistant") toolNames.noteAssistant(ev.blocks);
      }
    } catch {
      /* missing or transiently unreadable — start with an empty index */
    }
  }

  const fileSize = (await fs.stat(filePath)).size;
  let offset = opts.initialOffset ?? fileSize;
  if (offset > fileSize) offset = 0;
  writer.event("ready", { offset });
  // If the caller asked us to start before EOF, drain the gap up-front so the
  // existing content is delivered as proper `event` frames (not just exposed
  // by the next watch-fire, which only sees content written after attach).
  const shouldPrime = offset < fileSize;

  const log = opts.log ?? ((line) => console.log(line));
  const tag = opts.tag ?? "-";

  let inFlight = false;
  let pendingWatchTs: number | null = null;
  let closed = false;

  const drain = async (): Promise<void> => {
    if (closed || inFlight) return;
    inFlight = true;
    const tWatch = pendingWatchTs ?? Date.now();
    pendingWatchTs = null;
    try {
      const { events, offset: newOffset } = await readFromOffset(
        filePath,
        offset,
        toolNames,
      );
      const tParsed = Date.now();
      offset = newOffset;
      opts.onEvents?.(events);
      for (const ev of events) {
        if (closed) break;
        const tSse = Date.now();
        const payload = opts.timing
          ? { ...ev, _timing: { tWatch, tParsed, tSse } }
          : ev;
        writer.event("event", payload);
        if (opts.timing) {
          const parsedTs = ev.ts ? Date.parse(ev.ts) : NaN;
          const tJsonl = Number.isFinite(parsedTs) ? parsedTs : tWatch;
          const uuid = ev.uuid ? ev.uuid.slice(0, 8) : "-";
          log(
            `[timing] sid=${tag} kind=${ev.kind} uuid=${uuid} ` +
              `jsonl→watch=${tWatch - tJsonl}ms ` +
              `watch→parse=${tParsed - tWatch}ms ` +
              `parse→sse=${tSse - tParsed}ms`,
          );
        }
      }
    } catch (err) {
      if (!closed) writer.event("error", { message: String(err) });
    } finally {
      inFlight = false;
    }
  };

  const watcher = watch(filePath, () => {
    if (pendingWatchTs === null) pendingWatchTs = Date.now();
    void drain();
  });

  if (shouldPrime) {
    pendingWatchTs = Date.now();
    void drain();
  }

  const heartbeat = startHeartbeat(
    writer,
    opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
  );

  return {
    close: () => {
      if (closed) return;
      closed = true;
      heartbeat.close();
      watcher.close();
    },
  };
}

function startHeartbeat(
  writer: SseWriter,
  ms: number,
): TranscriptStreamHandle {
  if (ms <= 0) return { close: () => {} };
  const timer = setInterval(() => writer.comment("ping"), ms);
  return { close: () => clearInterval(timer) };
}
