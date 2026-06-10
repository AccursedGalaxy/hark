import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "./protocol";
import { lastUuidOf, mergeDelta } from "./transcriptDelta";

const user = (uuid: string, text = "hi"): TranscriptEvent => ({
  kind: "user",
  uuid,
  ts: "2026-06-10T00:00:00.000Z",
  text,
});

const assistantToolUse = (
  uuid: string,
  toolUseId: string,
  name: string,
): TranscriptEvent => ({
  kind: "assistant",
  uuid,
  ts: "2026-06-10T00:00:01.000Z",
  blocks: [{ type: "tool_use", id: toolUseId, name, input: {} }],
});

const toolResult = (
  uuid: string,
  toolUseId: string,
  meta?: unknown,
): TranscriptEvent => ({
  kind: "tool_result",
  uuid,
  ts: "2026-06-10T00:00:02.000Z",
  toolUseId,
  output: "ok",
  isError: false,
  ...(meta !== undefined ? { meta: { kind: "raw", data: meta } } : {}),
});

describe("lastUuidOf", () => {
  it("returns the last uuid-bearing event", () => {
    const events = [user("u1"), { ...user(""), uuid: "" } as TranscriptEvent];
    expect(lastUuidOf(events)).toBe("u1");
  });

  it("returns null for empty / uuid-less histories", () => {
    expect(lastUuidOf([])).toBeNull();
  });
});

describe("mergeDelta", () => {
  it("appends new events", () => {
    const merged = mergeDelta([user("u1")], [user("u2")]);
    expect(merged.map((e) => e.uuid)).toEqual(["u1", "u2"]);
  });

  it("dedupes re-delivered events by uuid", () => {
    const merged = mergeDelta([user("u1"), user("u2")], [user("u2"), user("u3")]);
    expect(merged.map((e) => e.uuid)).toEqual(["u1", "u2", "u3"]);
  });

  it("enriches tool_results whose tool_use is in cached history", () => {
    const history = [assistantToolUse("a1", "t1", "Read")];
    const delta = [
      toolResult("r1", "t1", {
        file: { filePath: "/x.ts", numLines: 5, totalLines: 5, startLine: 1 },
      }),
    ];
    const merged = mergeDelta(history, delta);
    const result = merged[1];
    expect(result.kind).toBe("tool_result");
    if (result.kind === "tool_result") {
      expect(result.toolName).toBe("Read");
      expect(result.meta?.kind).toBe("read");
    }
  });

  it("enriches tool_results whose tool_use arrives in the same delta", () => {
    const delta = [
      assistantToolUse("a1", "t9", "Bash"),
      toolResult("r9", "t9", { stderr: "", interrupted: false }),
    ];
    const merged = mergeDelta([user("u1")], delta);
    const result = merged[2];
    if (result.kind === "tool_result") {
      expect(result.toolName).toBe("Bash");
      expect(result.meta?.kind).toBe("bash");
    } else {
      throw new Error("expected tool_result");
    }
  });

  it("leaves already-enriched results untouched and returns history as-is for empty deltas", () => {
    const history = [user("u1")];
    expect(mergeDelta(history, [])).toBe(history);
  });
});
