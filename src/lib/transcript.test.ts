import { describe, it, expect } from "vitest";
import { parseLine, parseTranscript } from "./transcript.js";

const userString = JSON.stringify({
  type: "user",
  uuid: "u1",
  timestamp: "2026-05-24T21:28:50.235Z",
  message: { role: "user", content: "hello" },
});

const assistantText = JSON.stringify({
  type: "assistant",
  uuid: "a1",
  timestamp: "2026-05-24T21:28:55.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hi back" }],
  },
});

const assistantMixed = JSON.stringify({
  type: "assistant",
  uuid: "a2",
  timestamp: "2026-05-24T21:29:00.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "running ls" },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { cmd: "ls" } },
    ],
  },
});

const toolResult = JSON.stringify({
  type: "user",
  uuid: "tr1",
  timestamp: "2026-05-24T21:29:07.237Z",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "total 0",
        is_error: false,
      },
    ],
  },
});

const attachment = JSON.stringify({
  type: "attachment",
  uuid: "att1",
  attachment: { type: "deferred_tools_delta", addedNames: ["Foo"] },
});

const permissionMode = JSON.stringify({
  type: "permission-mode",
  permissionMode: "auto",
});

describe("parseLine", () => {
  it("parses a string-content user message", () => {
    expect(parseLine(userString)).toEqual({
      kind: "user",
      uuid: "u1",
      ts: "2026-05-24T21:28:50.235Z",
      text: "hello",
    });
  });

  it("parses an assistant text-only message", () => {
    expect(parseLine(assistantText)).toEqual({
      kind: "assistant",
      uuid: "a1",
      ts: "2026-05-24T21:28:55.000Z",
      blocks: [{ type: "text", text: "hi back" }],
    });
  });

  it("parses an assistant message with thinking + text + tool_use", () => {
    expect(parseLine(assistantMixed)).toEqual({
      kind: "assistant",
      uuid: "a2",
      ts: "2026-05-24T21:29:00.000Z",
      blocks: [
        { type: "thinking", text: "let me think" },
        { type: "text", text: "running ls" },
        {
          type: "tool_use",
          id: "tu_1",
          name: "Bash",
          input: { cmd: "ls" },
        },
      ],
    });
  });

  it("parses a tool_result wrapped in a user message", () => {
    expect(parseLine(toolResult)).toEqual({
      kind: "tool_result",
      uuid: "tr1",
      ts: "2026-05-24T21:29:07.237Z",
      toolUseId: "tu_1",
      output: "total 0",
      isError: false,
    });
  });

  it("returns null for attachment events", () => {
    expect(parseLine(attachment)).toBeNull();
  });

  it("returns null for meta events like permission-mode", () => {
    expect(parseLine(permissionMode)).toBeNull();
  });

  it("returns null for malformed JSON without throwing", () => {
    expect(parseLine("{not json")).toBeNull();
  });

  it("returns null for blank lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
  });
});

describe("parseTranscript", () => {
  it("parses multi-line input and skips nulls in order", () => {
    const blob = [
      permissionMode,
      userString,
      attachment,
      assistantText,
      "",
      toolResult,
    ].join("\n");
    const events = parseTranscript(blob);
    expect(events.map((e) => e.kind)).toEqual([
      "user",
      "assistant",
      "tool_result",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseTranscript("")).toEqual([]);
  });
});
