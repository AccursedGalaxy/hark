import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SseWriter, TranscriptStreamHandle } from "./transcriptStream.js";
import {
  openEmptyStream,
  openLazyTranscriptStream,
  openTranscriptStream,
} from "./transcriptStream.js";

interface CapturedEvent {
  name: string;
  data: unknown;
}

function makeWriter(): SseWriter & {
  events: CapturedEvent[];
  comments: string[];
} {
  const events: CapturedEvent[] = [];
  const comments: string[] = [];
  return {
    events,
    comments,
    event: (name, data) => events.push({ name, data }),
    comment: (text) => comments.push(text),
  };
}

// fs.watch is debounced by the platform. Poll until the writer has received
// the expected count of events or the deadline expires. Cheaper than a
// fixed sleep and far more reliable on a loaded CI box.
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 1000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function userLine(uuid: string, text: string, ts = "2026-05-25T00:00:00Z"): string {
  return (
    JSON.stringify({
      type: "user",
      uuid,
      timestamp: ts,
      message: { role: "user", content: text },
    }) + "\n"
  );
}

function assistantToolUseLine(uuid: string, toolUseId: string, toolName: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      uuid,
      timestamp: "2026-05-25T00:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }],
      },
    }) + "\n"
  );
}

function toolResultLine(uuid: string, toolUseId: string, output: string): string {
  return (
    JSON.stringify({
      type: "user",
      uuid,
      timestamp: "2026-05-25T00:00:00Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: output }],
      },
    }) + "\n"
  );
}

describe("openEmptyStream", () => {
  it("emits a single ready event with offset 0 and no events thereafter", () => {
    const w = makeWriter();
    const handle = openEmptyStream(w, { heartbeatMs: 0 });
    expect(w.events).toEqual([{ name: "ready", data: { offset: 0 } }]);
    handle.close();
  });

  it("emits heartbeats on the configured interval", async () => {
    const w = makeWriter();
    const handle = openEmptyStream(w, { heartbeatMs: 30 });
    await waitFor(() => w.comments.length >= 2, { timeoutMs: 500 });
    handle.close();
    const before = w.comments.length;
    // After close, the heartbeat must stop. Wait long enough to detect a
    // missed clearInterval.
    await new Promise((r) => setTimeout(r, 100));
    expect(w.comments.length).toBe(before);
  });
});

describe("openTranscriptStream", () => {
  let dir: string;
  let filePath: string;
  let handles: TranscriptStreamHandle[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-stream-"));
    filePath = path.join(dir, "session.jsonl");
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) h.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("ready event carries the file's initial byte offset", async () => {
    const initial = userLine("u1", "hello");
    await fs.writeFile(filePath, initial);
    const w = makeWriter();
    handles.push(
      await openTranscriptStream(filePath, w, { heartbeatMs: 0 }),
    );
    expect(w.events).toHaveLength(1);
    expect(w.events[0].name).toBe("ready");
    expect((w.events[0].data as { offset: number }).offset).toBe(initial.length);
  });

  it("emits parsed events after the file grows", async () => {
    await fs.writeFile(filePath, userLine("u1", "hello"));
    const w = makeWriter();
    handles.push(
      await openTranscriptStream(filePath, w, { heartbeatMs: 0 }),
    );
    await fs.appendFile(filePath, userLine("u2", "follow-up"));
    await waitFor(() => w.events.length >= 2);
    const ev = w.events[1];
    expect(ev.name).toBe("event");
    expect((ev.data as { kind: string; uuid: string }).kind).toBe("user");
    expect((ev.data as { kind: string; uuid: string }).uuid).toBe("u2");
  });

  it("primes ToolNameIndex from existing content so streamed tool_results carry toolName", async () => {
    // The tool_use is already in the file when the stream opens — its
    // name must be available to enrich the tool_result that arrives later.
    await fs.writeFile(
      filePath,
      assistantToolUseLine("a1", "toolu_xxx", "Bash"),
    );
    const w = makeWriter();
    handles.push(
      await openTranscriptStream(filePath, w, { heartbeatMs: 0 }),
    );
    await fs.appendFile(filePath, toolResultLine("r1", "toolu_xxx", "ok"));
    await waitFor(() => w.events.length >= 2);
    const ev = w.events[1].data as {
      kind: string;
      toolUseId: string;
      toolName?: string;
    };
    expect(ev.kind).toBe("tool_result");
    expect(ev.toolUseId).toBe("toolu_xxx");
    expect(ev.toolName).toBe("Bash");
  });

  it("invokes onEvents with the same batch the writer sees", async () => {
    await fs.writeFile(filePath, "");
    const batches: Array<{ kind: string; uuid: string }[]> = [];
    const w = makeWriter();
    handles.push(
      await openTranscriptStream(filePath, w, {
        heartbeatMs: 0,
        onEvents: (events) =>
          batches.push(
            events.map((e) => ({
              kind: e.kind,
              uuid: e.uuid,
            })),
          ),
      }),
    );
    await fs.appendFile(filePath, userLine("u1", "one") + userLine("u2", "two"));
    await waitFor(() => batches.length >= 1 && w.events.length >= 3);
    // All onEvents batches together should sum to two user events.
    const allBatched = batches.flat();
    expect(allBatched.map((e) => e.uuid)).toEqual(["u1", "u2"]);
  });

  it("close() stops the watch and heartbeat", async () => {
    await fs.writeFile(filePath, "");
    const w = makeWriter();
    const handle = await openTranscriptStream(filePath, w, { heartbeatMs: 0 });
    handle.close();
    handle.close(); // idempotent
    await fs.appendFile(filePath, userLine("u1", "after-close"));
    // A short wait: if close() failed to remove the watcher the drain
    // would still fire and push an event.
    await new Promise((r) => setTimeout(r, 100));
    // Only the ready event should be present.
    expect(w.events.map((e) => e.name)).toEqual(["ready"]);
  });

  it("openLazyTranscriptStream upgrades and streams events once the file appears", async () => {
    const w = makeWriter();
    const handle = openLazyTranscriptStream(
      async () => {
        try {
          await fs.access(filePath);
          return filePath;
        } catch {
          return null;
        }
      },
      w,
      { heartbeatMs: 0, pollMs: 20 },
    );
    handles.push(handle);

    // Ready fires synchronously with offset 0, before the file exists.
    expect(w.events).toEqual([{ name: "ready", data: { offset: 0 } }]);

    // Create the file empty. The lazy stream's next poll detects it and
    // upgrades to a watching stream — which emits a second `ready` event
    // (with the file's current offset = 0). That signals the upgrade so
    // we can append safely afterwards.
    await fs.writeFile(filePath, "");
    await waitFor(
      () => w.events.filter((e) => e.name === "ready").length >= 2,
      { timeoutMs: 2000 },
    );

    // Now append a line. The watching stream should pick it up.
    await fs.appendFile(filePath, userLine("u1", "hello"));
    await waitFor(
      () => w.events.some((e) => e.name === "event"),
      { timeoutMs: 2000 },
    );
    const evt = w.events.find((e) => e.name === "event")!;
    expect((evt.data as { kind: string; uuid: string }).uuid).toBe("u1");
  });

  it("openLazyTranscriptStream replays existing content when the file appears with bytes already in it", async () => {
    // Regression for the fresh-session bug: a brand-new session's JSONL is
    // often created with its first turn's lines already buffered (user
    // message + assistant init) in one write. Without priming, the watching
    // stream attaches at EOF and the first turn is silently dropped — the
    // user sees the assistant's reply but never their own prompt.
    const w = makeWriter();
    const handle = openLazyTranscriptStream(
      async () => {
        try {
          await fs.access(filePath);
          return filePath;
        } catch {
          return null;
        }
      },
      w,
      { heartbeatMs: 0, pollMs: 20 },
    );
    handles.push(handle);

    await fs.writeFile(
      filePath,
      userLine("u1", "first prompt") +
        assistantToolUseLine("a1", "tool1", "Bash"),
    );

    await waitFor(
      () => w.events.filter((e) => e.name === "event").length >= 2,
      { timeoutMs: 2000 },
    );
    const uuids = w.events
      .filter((e) => e.name === "event")
      .map((e) => (e.data as { uuid: string }).uuid);
    expect(uuids).toEqual(["u1", "a1"]);
  });

  it("openLazyTranscriptStream close() while polling stops the upgrade", async () => {
    const w = makeWriter();
    let attempts = 0;
    const handle = openLazyTranscriptStream(
      async () => {
        attempts += 1;
        return null;
      },
      w,
      { heartbeatMs: 0, pollMs: 20 },
    );
    handle.close();
    handle.close(); // idempotent
    const before = attempts;
    await new Promise((r) => setTimeout(r, 80));
    // No more polling should happen after close.
    expect(attempts).toBe(before);
    expect(w.events.map((e) => e.name)).toEqual(["ready"]);
  });

  it("timing mode tags events and emits log lines", async () => {
    await fs.writeFile(filePath, "");
    const w = makeWriter();
    const logged: string[] = [];
    handles.push(
      await openTranscriptStream(filePath, w, {
        heartbeatMs: 0,
        timing: true,
        log: (line) => logged.push(line),
        tag: "abcd1234",
      }),
    );
    await fs.appendFile(filePath, userLine("uuid0001", "hi"));
    await waitFor(() => w.events.length >= 2);
    const ev = w.events[1].data as { _timing?: { tWatch: number; tParsed: number; tSse: number } };
    expect(ev._timing).toBeDefined();
    expect(typeof ev._timing!.tWatch).toBe("number");
    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(logged[0]).toContain("sid=abcd1234");
    expect(logged[0]).toContain("kind=user");
  });
});
