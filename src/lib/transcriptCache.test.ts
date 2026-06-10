import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptCache, type TranscriptCacheDeps } from "./transcriptCache.js";

const assistantLine = (uuid: string, toolUseId: string) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: "2026-06-10T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "Read", input: {} }],
    },
  });

const toolResultLine = (uuid: string, toolUseId: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    timestamp: "2026-06-10T00:00:01.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
  });

const userLine = (uuid: string, text: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    timestamp: "2026-06-10T00:00:02.000Z",
    message: { role: "user", content: text },
  });

describe("TranscriptCache", () => {
  let dir: string;
  let reads: string[];
  let deps: TranscriptCacheDeps;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-tcache-"));
    reads = [];
    deps = {
      stat: (p) => fs.stat(p),
      readFile: (p) => {
        reads.push(p);
        return fs.readFile(p);
      },
    };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeTranscript(name: string, lines: string[]): Promise<string> {
    const p = path.join(dir, name);
    await fs.writeFile(p, lines.join("\n") + "\n");
    return p;
  }

  it("parses events and enriches tool_results via its own index", async () => {
    const p = await writeTranscript("a.jsonl", [
      assistantLine("a1", "t1"),
      toolResultLine("r1", "t1"),
    ]);
    const cache = new TranscriptCache(20, deps);
    const { events, offset, toolNames } = await cache.read(p);
    expect(events).toHaveLength(2);
    const result = events[1];
    expect(result.kind).toBe("tool_result");
    if (result.kind === "tool_result") {
      expect(result.toolName).toBe("Read");
    }
    expect(offset).toBe((await fs.stat(p)).size);
    expect(toolNames.resolve("t1")).toBe("Read");
  });

  it("serves repeat reads of an unchanged file from cache", async () => {
    const p = await writeTranscript("a.jsonl", [userLine("u1", "hi")]);
    const cache = new TranscriptCache(20, deps);
    const first = await cache.read(p);
    const second = await cache.read(p);
    expect(reads).toHaveLength(1);
    expect(second).toBe(first);
  });

  it("re-parses when the file grows", async () => {
    const p = await writeTranscript("a.jsonl", [userLine("u1", "hi")]);
    const cache = new TranscriptCache(20, deps);
    await cache.read(p);
    await fs.appendFile(p, userLine("u2", "more") + "\n");
    const { events, offset } = await cache.read(p);
    expect(reads).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(offset).toBe((await fs.stat(p)).size);
  });

  it("evicts least-recently-used entries past maxEntries", async () => {
    const a = await writeTranscript("a.jsonl", [userLine("a", "a")]);
    const b = await writeTranscript("b.jsonl", [userLine("b", "b")]);
    const c = await writeTranscript("c.jsonl", [userLine("c", "c")]);
    const cache = new TranscriptCache(2, deps);
    await cache.read(a);
    await cache.read(b);
    // Touch a so b is the LRU entry when c lands.
    await cache.read(a);
    await cache.read(c);
    reads = [];
    await cache.read(a); // still cached
    expect(reads).toHaveLength(0);
    await cache.read(b); // evicted → re-read
    expect(reads).toEqual([b]);
  });

  it("propagates missing-file errors", async () => {
    const cache = new TranscriptCache(20, deps);
    await expect(cache.read(path.join(dir, "nope.jsonl"))).rejects.toThrow();
  });
});
