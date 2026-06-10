import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmTranscriptContinuity } from "./transcript.js";

const userLine = (uuid: string, text: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    timestamp: "2026-06-10T00:00:00.000Z",
    message: { role: "user", content: text },
  });

// A row that is real JSONL but never becomes a client-visible event —
// the client's lastUuid can never point at it.
const aiTitleLine = () =>
  JSON.stringify({ type: "ai-title", uuid: "title-uuid", aiTitle: "T" });

describe("confirmTranscriptContinuity", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-cont-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function write(lines: string[]): Promise<{ p: string; size: number }> {
    const p = path.join(dir, "t.jsonl");
    await fs.writeFile(p, lines.join("\n") + "\n");
    return { p, size: (await fs.stat(p)).size };
  }

  it("confirms when the last event at the cursor matches", async () => {
    const { p, size } = await write([userLine("u1", "a"), userLine("u2", "b")]);
    expect(await confirmTranscriptContinuity(p, size, "u2")).toBe(true);
  });

  it("rejects a mismatched uuid (rewritten file)", async () => {
    const { p, size } = await write([userLine("u1", "a"), userLine("u9", "b")]);
    expect(await confirmTranscriptContinuity(p, size, "u2")).toBe(false);
  });

  it("skips non-event rows when walking back to the marker", async () => {
    const { p, size } = await write([
      userLine("u1", "a"),
      userLine("u2", "b"),
      aiTitleLine(),
    ]);
    // Client saw u2 last; the trailing ai-title row (with its own uuid
    // field) must not break the match.
    expect(await confirmTranscriptContinuity(p, size, "u2")).toBe(true);
  });

  it("confirms at a mid-file cursor", async () => {
    const head = [userLine("u1", "a"), userLine("u2", "b")];
    const headBytes = Buffer.byteLength(head.join("\n") + "\n");
    const { p } = await write([...head, userLine("u3", "c")]);
    expect(await confirmTranscriptContinuity(p, headBytes, "u2")).toBe(true);
    expect(await confirmTranscriptContinuity(p, headBytes, "u3")).toBe(false);
  });

  it("rejects offsets beyond EOF and at 0", async () => {
    const { p, size } = await write([userLine("u1", "a")]);
    expect(await confirmTranscriptContinuity(p, size + 100, "u1")).toBe(false);
    expect(await confirmTranscriptContinuity(p, 0, "u1")).toBe(false);
  });

  it("rejects when the file is missing", async () => {
    expect(
      await confirmTranscriptContinuity(path.join(dir, "nope.jsonl"), 10, "u1"),
    ).toBe(false);
  });

  it("falls back to parentUuid references when the tail is all bookkeeping rows", async () => {
    // Real transcripts often end with dozens of non-event rows (system
    // rows, progress records) that can push the last event line out of the
    // read window entirely. Descendant rows referencing the client's last
    // event via parentUuid still prove continuity.
    const systemRow = (parentUuid: string) =>
      JSON.stringify({
        type: "system",
        subtype: "x",
        parentUuid,
        uuid: "sys-uuid",
        content: "y".repeat(2000),
      });
    // ~70KB of trailing bookkeeping > the 64KB window.
    const tail = Array.from({ length: 36 }, () => systemRow("u1"));
    const { p, size } = await write([userLine("u1", "a"), ...tail]);
    expect(await confirmTranscriptContinuity(p, size, "u1")).toBe(true);
    expect(await confirmTranscriptContinuity(p, size, "other")).toBe(false);
  });

  it("handles a window that opens mid-record", async () => {
    // Make the first line huge so the 4KB window starts inside it; the
    // truncated head fragment must be skipped, not crash the parse.
    const big = userLine("u1", "x".repeat(8000));
    const { p, size } = await write([big, userLine("u2", "b")]);
    expect(await confirmTranscriptContinuity(p, size, "u2")).toBe(true);
  });
});
