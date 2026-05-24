import { describe, it, expect } from "vitest";
import { buildKeyArgs, buildPasteArgs } from "./sendKeys.js";

describe("buildKeyArgs", () => {
  it("builds send-keys argv for a named key", () => {
    expect(buildKeyArgs("/tmp/sock", "%1", "Enter")).toEqual([
      "-S",
      "/tmp/sock",
      "send-keys",
      "-t",
      "%1",
      "Enter",
    ]);
  });

  it("supports Escape as a key name", () => {
    expect(buildKeyArgs("/tmp/sock", "%2", "Escape")).toEqual([
      "-S",
      "/tmp/sock",
      "send-keys",
      "-t",
      "%2",
      "Escape",
    ]);
  });

  it("supports a single literal character (e.g. '1' for approve)", () => {
    expect(buildKeyArgs("/tmp/sock", "%3", "1")).toEqual([
      "-S",
      "/tmp/sock",
      "send-keys",
      "-t",
      "%3",
      "1",
    ]);
  });
});

describe("buildPasteArgs", () => {
  it("returns paired load-buffer and paste-buffer argv lists", () => {
    const { loadBuffer, pasteBuffer } = buildPasteArgs(
      "/tmp/sock",
      "%1",
      "buf-xyz",
    );
    expect(loadBuffer).toEqual([
      "-S",
      "/tmp/sock",
      "load-buffer",
      "-b",
      "buf-xyz",
      "-",
    ]);
    expect(pasteBuffer).toEqual([
      "-S",
      "/tmp/sock",
      "paste-buffer",
      "-b",
      "buf-xyz",
      "-t",
      "%1",
      "-p",
      "-d",
    ]);
  });
});
