import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  extractToolMeta,
  indexToolResults,
  parseLine,
  parseTranscript,
  parseUsage,
  readSessionTitle,
  ToolNameIndex,
} from "./transcript.js";

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
  toolUseResult: {
    stdout: "total 0",
    stderr: "",
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  },
});

const attachment = JSON.stringify({
  type: "attachment",
  uuid: "att1",
  attachment: { type: "deferred_tools_delta", addedNames: ["Foo"] },
});

// Real shape Claude Code writes when the user queues a prompt by typing
// into the composer while the model is still working. There is NO matching
// `type:"user"` row — this attachment is the only carrier of the text, so
// it must surface as a user bubble or the message vanishes from the UI.
const queuedCommand = JSON.stringify({
  parentUuid: "9f47032d-356a-4ac4-b83e-af526db8cbf5",
  isSidechain: false,
  attachment: {
    type: "queued_command",
    prompt: "steer: stop after the next file",
    commandMode: "prompt",
  },
  type: "attachment",
  uuid: "qc1",
  timestamp: "2026-05-25T16:21:17.805Z",
  sessionId: "79e59c7a",
});

const stopHookFeedback = JSON.stringify({
  type: "user",
  uuid: "sys1",
  timestamp: "2026-05-24T22:15:42.657Z",
  isMeta: true,
  message: { role: "user", content: "Stop hook feedback:\nDOC-PIPELINE CHECK" },
});

const systemReminderOnly = JSON.stringify({
  type: "user",
  uuid: "sys2",
  timestamp: "2026-05-24T22:20:00.000Z",
  message: {
    role: "user",
    content: "<system-reminder>cache invalidated</system-reminder>",
  },
});

const permissionMode = JSON.stringify({
  type: "permission-mode",
  permissionMode: "auto",
});

// Real shape Claude Code writes when the user pastes/attaches an image
// along with typed text. The message is *not* `isMeta` — it's the genuine
// user prompt that the parser must surface.
const userTextPlusImage = JSON.stringify({
  type: "user",
  uuid: "u-img",
  timestamp: "2026-05-25T12:11:11.000Z",
  message: {
    role: "user",
    content: [
      { type: "text", text: "I'd like to close sessions. [Image #1]" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "..." },
      },
    ],
  },
});

// What Claude Code writes when an image attachment is recorded as
// bookkeeping (isMeta=true, synthesised placeholder text). Not the user's
// real message — should NOT render as a user bubble.
const imageBookkeeping = JSON.stringify({
  type: "user",
  uuid: "u-imgbk",
  timestamp: "2026-05-25T12:11:11.000Z",
  isMeta: true,
  message: {
    role: "user",
    content: [
      {
        type: "text",
        text: "[Image: source: /home/aki/.claude/image-cache/x/1.png]",
      },
    ],
  },
});

// User message with no text — only an image. Real prompts where the user
// just drops a screenshot with no caption.
const userImageOnly = JSON.stringify({
  type: "user",
  uuid: "u-imgonly",
  timestamp: "2026-05-25T12:11:11.000Z",
  message: {
    role: "user",
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "..." },
      },
    ],
  },
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
    // Without enrichment the parser can't know the tool name yet, so meta
    // comes back as `raw` carrying the original toolUseResult blob.
    expect(parseLine(toolResult)).toEqual({
      kind: "tool_result",
      uuid: "tr1",
      ts: "2026-05-24T21:29:07.237Z",
      toolUseId: "tu_1",
      output: "total 0",
      isError: false,
      meta: {
        kind: "raw",
        data: {
          stdout: "total 0",
          stderr: "",
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
      },
    });
  });

  it("parses a tool_result without a toolUseResult sibling (no meta)", () => {
    const noMeta = JSON.stringify({
      type: "user",
      uuid: "tr-bare",
      timestamp: "t",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_2",
            content: "x",
            is_error: false,
          },
        ],
      },
    });
    const ev = parseLine(noMeta);
    expect(ev?.kind).toBe("tool_result");
    expect((ev as { meta?: unknown }).meta).toBeUndefined();
  });

  it("returns null for bookkeeping attachment events (deferred_tools_delta)", () => {
    expect(parseLine(attachment)).toBeNull();
  });

  it("renders a queued_command attachment as a user event", () => {
    // Bug repro: when the user types into the composer while the model is
    // busy, Claude Code writes only this attachment row — no `type:"user"`
    // record ever follows. Without this branch the queued message vanishes
    // from the transcript even after the model processes it.
    const ev = parseLine(queuedCommand);
    expect(ev).toEqual({
      kind: "user",
      uuid: "qc1",
      ts: "2026-05-25T16:21:17.805Z",
      text: "steer: stop after the next file",
    });
  });

  it("returns null for queued_command without a prompt string", () => {
    const bad = JSON.stringify({
      type: "attachment",
      uuid: "qc-bad",
      attachment: { type: "queued_command" },
    });
    expect(parseLine(bad)).toBeNull();
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

  it("flags isMeta user entries as system events", () => {
    expect(parseLine(stopHookFeedback)).toEqual({
      kind: "system",
      uuid: "sys1",
      ts: "2026-05-24T22:15:42.657Z",
      text: "Stop hook feedback:\nDOC-PIPELINE CHECK",
    });
  });

  it("flags pure <system-reminder> user content as system events and strips wrapper", () => {
    expect(parseLine(systemReminderOnly)).toEqual({
      kind: "system",
      uuid: "sys2",
      ts: "2026-05-24T22:20:00.000Z",
      text: "cache invalidated",
    });
  });

  // ---- User messages with array content (image attachments) ----
  // Real bug: my earlier parser only handled the array case as a tool_result
  // probe. Anything else returned null and the user's message vanished.

  it("parses a user message with text + image content as a user event", () => {
    const ev = parseLine(userTextPlusImage);
    expect(ev?.kind).toBe("user");
    if (ev?.kind !== "user") throw new Error("expected user");
    expect(ev.uuid).toBe("u-img");
    // The text is preserved; the image presence is noted at the end so the
    // reader knows an attachment was sent without us inlining base64 bytes.
    expect(ev.text).toBe("I'd like to close sessions. [Image #1]\n[image attached]");
  });

  it("parses an image-only user message as a user event", () => {
    const ev = parseLine(userImageOnly);
    expect(ev?.kind).toBe("user");
    if (ev?.kind !== "user") throw new Error("expected user");
    expect(ev.text).toBe("[image attached]");
  });

  it("classifies isMeta image-bookkeeping rows as system events, not user", () => {
    const ev = parseLine(imageBookkeeping);
    expect(ev?.kind).toBe("system");
    if (ev?.kind !== "system") throw new Error("expected system");
    // The synthesised placeholder is bookkeeping; we still preserve it as
    // the system row text so debugging users can see what was recorded.
    expect(ev.text).toContain("[Image: source:");
  });

  it("still parses a tool_result list as a tool_result event (unchanged)", () => {
    const ev = parseLine(toolResult);
    expect(ev?.kind).toBe("tool_result");
  });

  it("returns null for a user message with an empty content array", () => {
    const empty = JSON.stringify({
      type: "user",
      uuid: "u-empty",
      timestamp: "t",
      message: { role: "user", content: [] },
    });
    expect(parseLine(empty)).toBeNull();
  });

  // ---- Slash-commands and local-command stdout ----
  // Claude Code wraps slash commands like `/clear` in XML tags inside the
  // content string. Rendered naively they read as `<command-name>/clear</…>`
  // garbage. We want a clean `/clear` (or `/skill args`) user message.

  it("renders a bare slash-command as a clean user event", () => {
    const slash = JSON.stringify({
      type: "user",
      uuid: "sl1",
      timestamp: "t",
      message: {
        role: "user",
        content:
          "<command-name>/clear</command-name>\n            " +
          "<command-message>clear</command-message>\n            " +
          "<command-args></command-args>",
      },
    });
    expect(parseLine(slash)).toEqual({
      kind: "user",
      uuid: "sl1",
      ts: "t",
      text: "/clear",
    });
  });

  it("preserves args for a slash-command with content", () => {
    const slash = JSON.stringify({
      type: "user",
      uuid: "sl2",
      timestamp: "t",
      message: {
        role: "user",
        content:
          "<command-message>frontend-design:frontend-design</command-message>\n" +
          "<command-name>/frontend-design:frontend-design</command-name>\n" +
          "<command-args>now please design a modern frontend</command-args>",
      },
    });
    expect(parseLine(slash)).toEqual({
      kind: "user",
      uuid: "sl2",
      ts: "t",
      text: "/frontend-design:frontend-design now please design a modern frontend",
    });
  });

  it("surfaces local-command stdout as a system event", () => {
    const lc = JSON.stringify({
      type: "user",
      uuid: "lc1",
      timestamp: "t",
      message: {
        role: "user",
        content: "<local-command-stdout>(no content)</local-command-stdout>",
      },
    });
    const ev = parseLine(lc);
    expect(ev?.kind).toBe("system");
    if (ev?.kind !== "system") throw new Error("expected system");
    // The "(no content)" sentinel is meaningless to the reader; strip it
    // so the row reads as plain command output (or empty).
    expect(ev.text).toBe("");
  });

  it("keeps real local-command stdout content in the system event", () => {
    const lc = JSON.stringify({
      type: "user",
      uuid: "lc2",
      timestamp: "t",
      message: {
        role: "user",
        content:
          "<local-command-stdout>build succeeded in 1.2s</local-command-stdout>",
      },
    });
    const ev = parseLine(lc);
    expect(ev?.kind).toBe("system");
    if (ev?.kind !== "system") throw new Error("expected system");
    expect(ev.text).toBe("build succeeded in 1.2s");
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

  it("surfaces a queued_command attachment alongside regular user/assistant events", () => {
    const blob = [userString, assistantText, queuedCommand].join("\n");
    const events = parseTranscript(blob);
    expect(events.map((e) => e.kind)).toEqual(["user", "assistant", "user"]);
    const queued = events[2];
    if (queued.kind !== "user") throw new Error("expected user");
    expect(queued.text).toBe("steer: stop after the next file");
  });

  it("returns an empty array for empty input", () => {
    expect(parseTranscript("")).toEqual([]);
  });

  it("resolves toolName and typed meta when a tool_use precedes its result", () => {
    const blob = [assistantMixed, toolResult].join("\n");
    const events = parseTranscript(blob);
    const tr = events.find((e) => e.kind === "tool_result");
    expect(tr).toBeDefined();
    if (tr?.kind !== "tool_result") throw new Error("expected tool_result");
    expect(tr.toolName).toBe("Bash");
    expect(tr.meta).toEqual({
      kind: "bash",
      stderr: "",
      interrupted: false,
    });
  });

  it("leaves toolName undefined when no matching tool_use is in the stream", () => {
    // tool_result without a prior assistant tool_use block — happens when
    // the SSE consumer started watching mid-conversation.
    const events = parseTranscript(toolResult);
    const tr = events[0];
    if (tr?.kind !== "tool_result") throw new Error("expected tool_result");
    expect(tr.toolName).toBeUndefined();
    expect(tr.meta?.kind).toBe("raw");
  });
});

describe("extractToolMeta", () => {
  it("extracts Read shape", () => {
    expect(
      extractToolMeta("Read", {
        type: "text",
        file: {
          filePath: "/x/y.ts",
          content: "...",
          numLines: 12,
          startLine: 1,
          totalLines: 50,
        },
      }),
    ).toEqual({
      kind: "read",
      filePath: "/x/y.ts",
      numLines: 12,
      startLine: 1,
      totalLines: 50,
    });
  });

  it("falls back to raw when Read shape is malformed", () => {
    expect(extractToolMeta("Read", { type: "text" })).toEqual({
      kind: "raw",
      data: { type: "text" },
    });
  });

  it("extracts Bash shape and preserves backgroundTaskId when present", () => {
    expect(
      extractToolMeta("Bash", {
        stdout: "out",
        stderr: "err",
        interrupted: true,
        isImage: false,
        noOutputExpected: false,
        backgroundTaskId: "b1",
      }),
    ).toEqual({
      kind: "bash",
      stderr: "err",
      interrupted: true,
      backgroundTaskId: "b1",
    });
  });

  it("extracts Edit shape with structuredPatch passthrough", () => {
    const patch = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 }];
    expect(
      extractToolMeta("Edit", {
        filePath: "/a.ts",
        oldString: "x",
        newString: "y",
        replaceAll: true,
        userModified: false,
        structuredPatch: patch,
        originalFile: "long original blob",
      }),
    ).toEqual({
      kind: "edit",
      filePath: "/a.ts",
      replaceAll: true,
      userModified: false,
      structuredPatch: patch,
    });
  });

  it("extracts Write shape and defaults type to 'update' when absent", () => {
    expect(
      extractToolMeta("Write", {
        filePath: "/b.ts",
        content: "...",
        originalFile: null,
        userModified: false,
      }),
    ).toEqual({
      kind: "write",
      filePath: "/b.ts",
      type: "update",
      userModified: false,
      structuredPatch: undefined,
    });
  });

  it("extracts Glob shape", () => {
    expect(
      extractToolMeta("Glob", {
        filenames: ["a", "b"],
        numFiles: 2,
        durationMs: 3,
        truncated: false,
      }),
    ).toEqual({
      kind: "glob",
      numFiles: 2,
      truncated: false,
      durationMs: 3,
      filenames: ["a", "b"],
    });
  });

  it("extracts WebFetch shape", () => {
    expect(
      extractToolMeta("WebFetch", {
        url: "https://x",
        code: 200,
        codeText: "OK",
        bytes: 1234,
        durationMs: 50,
        result: "body",
      }),
    ).toEqual({
      kind: "webfetch",
      url: "https://x",
      code: 200,
      codeText: "OK",
      bytes: 1234,
      durationMs: 50,
    });
  });

  it("extracts WebSearch shape with derived resultCount", () => {
    expect(
      extractToolMeta("WebSearch", {
        query: "q",
        searchCount: 1,
        durationSeconds: 2,
        results: [{}, {}, {}],
      }),
    ).toEqual({
      kind: "websearch",
      query: "q",
      searchCount: 1,
      durationSeconds: 2,
      resultCount: 3,
    });
  });

  it("returns raw for known string-shaped error blobs", () => {
    expect(extractToolMeta("Read", "Error: File does not exist.")).toEqual({
      kind: "raw",
      data: "Error: File does not exist.",
    });
    expect(extractToolMeta("Bash", "Cancelled: ...")).toEqual({
      kind: "raw",
      data: "Cancelled: ...",
    });
  });

  it("returns raw for unknown tools (MCP, Agent, Task*, Skill, etc.)", () => {
    expect(
      extractToolMeta("Agent", {
        agentId: "x",
        status: "completed",
        prompt: "...",
      }),
    ).toEqual({
      kind: "raw",
      data: { agentId: "x", status: "completed", prompt: "..." },
    });
    expect(
      extractToolMeta("mcp__claude_ai_Gmail__list_labels", "{...}"),
    ).toEqual({ kind: "raw", data: "{...}" });
    expect(extractToolMeta(undefined, { anything: 1 })).toEqual({
      kind: "raw",
      data: { anything: 1 },
    });
  });
});

describe("ToolNameIndex", () => {
  it("resolves names from prior assistant blocks", () => {
    const ix = new ToolNameIndex();
    ix.noteAssistant([
      { type: "tool_use", id: "x", name: "Read", input: {} },
      { type: "text", text: "noise" },
    ]);
    expect(ix.resolve("x")).toBe("Read");
    expect(ix.resolve("missing")).toBeUndefined();
  });

  it("re-extracts meta from raw when enriching with a now-known name", () => {
    const ix = new ToolNameIndex();
    ix.noteAssistant([
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
    ]);
    const enriched = ix.enrich({
      kind: "tool_result",
      uuid: "u",
      ts: "t",
      toolUseId: "tu_1",
      output: "ok",
      isError: false,
      meta: {
        kind: "raw",
        data: {
          stdout: "ok",
          stderr: "",
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
      },
    });
    expect(enriched.toolName).toBe("Bash");
    expect(enriched.meta).toEqual({
      kind: "bash",
      stderr: "",
      interrupted: false,
    });
  });

  it("leaves the event untouched when the id is unknown", () => {
    const ix = new ToolNameIndex();
    const ev = {
      kind: "tool_result" as const,
      uuid: "u",
      ts: "t",
      toolUseId: "orphan",
      output: "x",
      isError: false,
      meta: { kind: "raw" as const, data: { something: 1 } },
    };
    expect(ix.enrich(ev)).toEqual(ev);
  });

  it("does not re-extract when meta is already typed", () => {
    // Defends against a hypothetical downstream consumer that has already
    // resolved meta to a typed kind — re-enrichment shouldn't clobber it.
    const ix = new ToolNameIndex();
    ix.noteAssistant([
      { type: "tool_use", id: "tu_1", name: "Read", input: {} },
    ]);
    const enriched = ix.enrich({
      kind: "tool_result",
      uuid: "u",
      ts: "t",
      toolUseId: "tu_1",
      output: "x",
      isError: false,
      meta: {
        kind: "read",
        filePath: "/x",
        numLines: 1,
        totalLines: 1,
        startLine: 1,
      },
    });
    expect(enriched.meta).toEqual({
      kind: "read",
      filePath: "/x",
      numLines: 1,
      totalLines: 1,
      startLine: 1,
    });
  });
});

describe("readSessionTitle", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-title-"));
    filePath = path.join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns the latest aiTitle when refined multiple times", async () => {
    const lines = [
      JSON.stringify({ type: "ai-title", aiTitle: "first", sessionId: "s" }),
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "final", sessionId: "s" }),
    ].join("\n");
    await fs.writeFile(filePath, lines);
    expect(await readSessionTitle(filePath)).toBe("final");
  });

  it("returns null when no ai-title row exists", async () => {
    await fs.writeFile(filePath, JSON.stringify({ type: "user" }));
    expect(await readSessionTitle(filePath)).toBeNull();
  });

  it("returns null when the file is missing", async () => {
    expect(await readSessionTitle(path.join(dir, "absent.jsonl"))).toBeNull();
  });

  it("survives a truncated head line inside the tail window", async () => {
    // Pad the file so the tail-read window starts mid-line; the partial
    // first line in the buffer must be skipped, not crash parsing.
    const pad = "x".repeat(40_000);
    const lines = [
      JSON.stringify({ type: "user", message: { content: pad } }),
      JSON.stringify({ type: "ai-title", aiTitle: "kept", sessionId: "s" }),
    ].join("\n");
    await fs.writeFile(filePath, lines);
    expect(await readSessionTitle(filePath)).toBe("kept");
  });
});

describe("indexToolResults", () => {
  it("builds a lookup keyed by toolUseId", () => {
    const events = parseTranscript([assistantMixed, toolResult].join("\n"));
    const map = indexToolResults(events);
    expect(map.size).toBe(1);
    expect(map.get("tu_1")?.toolName).toBe("Bash");
  });

  it("returns an empty map when there are no tool_results", () => {
    expect(indexToolResults(parseTranscript(assistantText))).toEqual(new Map());
  });
});

describe("parseUsage", () => {
  it("maps the Anthropic usage shape to our typed view", () => {
    const raw = {
      input_tokens: 12,
      output_tokens: 480,
      cache_creation_input_tokens: 23_874,
      cache_read_input_tokens: 1_000_000,
      server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
    };
    expect(parseUsage(raw)).toEqual({
      inputTokens: 12,
      outputTokens: 480,
      cacheCreationInputTokens: 23_874,
      cacheReadInputTokens: 1_000_000,
      webSearchRequests: 2,
      webFetchRequests: 1,
    });
  });

  it("defaults missing fields to 0 so totals never NaN", () => {
    expect(parseUsage({ input_tokens: 10 })).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
    });
  });

  it("returns undefined for non-object input (synthesised rows)", () => {
    expect(parseUsage(undefined)).toBeUndefined();
    expect(parseUsage(null)).toBeUndefined();
    expect(parseUsage("")).toBeUndefined();
  });
});

describe("assistant usage/model/stopReason on parseLine", () => {
  const assistantWithUsage = JSON.stringify({
    type: "assistant",
    uuid: "au1",
    timestamp: "2026-05-25T17:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      stop_reason: "tool_use",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 6,
        output_tokens: 393,
        cache_creation_input_tokens: 23_874,
        cache_read_input_tokens: 59_792_790,
      },
    },
  });

  it("attaches model, stop_reason and parsed usage", () => {
    const ev = parseLine(assistantWithUsage);
    expect(ev?.kind).toBe("assistant");
    if (ev?.kind !== "assistant") return;
    expect(ev.model).toBe("claude-opus-4-7");
    expect(ev.stopReason).toBe("tool_use");
    expect(ev.usage?.outputTokens).toBe(393);
    expect(ev.usage?.cacheReadInputTokens).toBe(59_792_790);
  });

  it("flags API error rows and carries retryAttempt", () => {
    const errRow = JSON.stringify({
      type: "assistant",
      uuid: "ae1",
      timestamp: "2026-05-25T17:00:00.000Z",
      isApiErrorMessage: true,
      retryAttempt: 2,
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    });
    const ev = parseLine(errRow);
    if (ev?.kind !== "assistant") throw new Error("expected assistant");
    expect(ev.isApiError).toBe(true);
    expect(ev.retryAttempt).toBe(2);
  });

  it("omits usage on synthesised rows that never reached the API", () => {
    const synth = JSON.stringify({
      type: "assistant",
      uuid: "as1",
      timestamp: "2026-05-25T17:00:00.000Z",
      message: { role: "assistant", model: "<synthetic>", content: [] },
    });
    const ev = parseLine(synth);
    if (ev?.kind !== "assistant") throw new Error("expected assistant");
    expect(ev.usage).toBeUndefined();
    expect(ev.model).toBe("<synthetic>");
  });
});
