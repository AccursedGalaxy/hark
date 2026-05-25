import { describe, expect, it } from "vitest";
import { filterCommands, parseSlashTrigger } from "./slashTrigger";

describe("parseSlashTrigger", () => {
  it("detects a slash at the very start with caret right after it", () => {
    expect(parseSlashTrigger("/", 1)).toEqual({
      slashStart: 0,
      queryEnd: 1,
      query: "",
    });
  });

  it("captures the typed query up to the caret", () => {
    expect(parseSlashTrigger("/shi", 4)).toEqual({
      slashStart: 0,
      queryEnd: 4,
      query: "shi",
    });
  });

  it("returns null when the line does not start with a slash", () => {
    expect(parseSlashTrigger("hello /ship", 11)).toBeNull();
  });

  it("returns null when whitespace separates the slash from the caret", () => {
    expect(parseSlashTrigger("/ship arg", 9)).toBeNull();
  });

  it("works on the current line of a multi-line buffer", () => {
    const text = "first line\n/he";
    expect(parseSlashTrigger(text, text.length)).toEqual({
      slashStart: 11,
      queryEnd: 14,
      query: "he",
    });
  });

  it("returns null when caret is before the slash", () => {
    expect(parseSlashTrigger("/ship", 0)).toBeNull();
  });
});

describe("filterCommands", () => {
  const cmds = [
    { name: "ship" },
    { name: "shore" },
    { name: "deploy" },
    { name: "relationship" },
  ];

  it("returns everything when query is empty", () => {
    expect(filterCommands(cmds, "")).toEqual(cmds);
  });

  it("matches case-insensitively", () => {
    expect(filterCommands(cmds, "SHI").map((c) => c.name)).toEqual([
      "ship",
      "relationship",
    ]);
  });

  it("ranks prefix matches ahead of substring matches", () => {
    expect(filterCommands(cmds, "sh").map((c) => c.name)).toEqual([
      "ship",
      "shore",
      "relationship",
    ]);
  });

  it("excludes commands with no match", () => {
    expect(filterCommands(cmds, "zzz")).toEqual([]);
  });
});
