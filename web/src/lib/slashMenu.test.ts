import { describe, expect, it } from "vitest";
import type { SlashCommand } from "./protocol";
import {
  clampHighlight,
  computeSlashMenuView,
  insertSlashCommand,
  resolveSlashKey,
} from "./slashMenu";

function cmd(
  name: string,
  argumentHint = "",
  source: SlashCommand["source"] = "project",
  kind: SlashCommand["kind"] = "command",
): SlashCommand {
  return { name, argumentHint, source, kind, description: "" };
}

const CMDS: SlashCommand[] = [
  cmd("ship"),
  cmd("shore"),
  cmd("deploy"),
  cmd("relationship"),
];

describe("clampHighlight", () => {
  it("returns 0 when the list is empty", () => {
    expect(clampHighlight(5, 0)).toBe(0);
    expect(clampHighlight(-3, 0)).toBe(0);
  });

  it("returns the current value when in range", () => {
    expect(clampHighlight(2, 4)).toBe(2);
    expect(clampHighlight(0, 4)).toBe(0);
    expect(clampHighlight(3, 4)).toBe(3);
  });

  it("clamps to the last valid index when out of range", () => {
    expect(clampHighlight(10, 4)).toBe(3);
    expect(clampHighlight(4, 4)).toBe(3);
  });

  it("clamps negatives to 0", () => {
    expect(clampHighlight(-1, 4)).toBe(0);
  });
});

describe("computeSlashMenuView", () => {
  it("returns trigger=null when the line does not start with /", () => {
    const v = computeSlashMenuView("hello", 5, CMDS);
    expect(v.trigger).toBe(null);
    expect(v.filtered).toEqual([]);
  });

  it("returns trigger + all commands for bare /", () => {
    const v = computeSlashMenuView("/", 1, CMDS);
    expect(v.trigger).toMatchObject({ slashStart: 0, queryEnd: 1, query: "" });
    expect(v.filtered).toEqual(CMDS);
  });

  it("filters by query, prefix-first then substring", () => {
    const v = computeSlashMenuView("/sh", 3, CMDS);
    expect(v.trigger?.query).toBe("sh");
    expect(v.filtered.map((c) => c.name)).toEqual([
      "ship",
      "shore",
      "relationship",
    ]);
  });

  it("returns empty filtered when query matches nothing", () => {
    const v = computeSlashMenuView("/zzz", 4, CMDS);
    expect(v.trigger?.query).toBe("zzz");
    expect(v.filtered).toEqual([]);
  });

  it("returns trigger=null and empty filtered when whitespace follows /", () => {
    const v = computeSlashMenuView("/ship arg", 9, CMDS);
    expect(v.trigger).toBe(null);
    expect(v.filtered).toEqual([]);
  });
});

describe("insertSlashCommand", () => {
  it("replaces the trigger with /name and a trailing space when argumentHint exists", () => {
    const trigger = { slashStart: 0, queryEnd: 3, query: "sh" };
    const result = insertSlashCommand("/sh", trigger, cmd("ship", "<msg>"));
    expect(result.nextText).toBe("/ship ");
    expect(result.nextCaret).toBe("/ship ".length);
  });

  it("omits trailing space when no argumentHint", () => {
    const trigger = { slashStart: 0, queryEnd: 3, query: "sh" };
    const result = insertSlashCommand("/sh", trigger, cmd("ship"));
    expect(result.nextText).toBe("/ship");
    expect(result.nextCaret).toBe("/ship".length);
  });

  it("preserves text on either side of the trigger", () => {
    const text = "hello\n/sh end";
    const trigger = { slashStart: 6, queryEnd: 9, query: "sh" };
    const result = insertSlashCommand(text, trigger, cmd("ship"));
    expect(result.nextText).toBe("hello\n/ship end");
    expect(result.nextCaret).toBe("hello\n/ship".length);
  });
});

describe("resolveSlashKey", () => {
  const trigger = { slashStart: 0, queryEnd: 3, query: "sh" };
  const filtered = [cmd("ship"), cmd("shore")];

  it("returns none for unrelated keys", () => {
    expect(
      resolveSlashKey(
        { key: "a", shiftKey: false },
        "/sh",
        trigger,
        filtered,
        0,
      ),
    ).toEqual({ kind: "none" });
  });

  it("ArrowDown advances highlight wrapping", () => {
    expect(
      resolveSlashKey(
        { key: "ArrowDown", shiftKey: false },
        "/sh",
        trigger,
        filtered,
        0,
      ),
    ).toEqual({ kind: "highlight", next: 1 });
    expect(
      resolveSlashKey(
        { key: "ArrowDown", shiftKey: false },
        "/sh",
        trigger,
        filtered,
        1,
      ),
    ).toEqual({ kind: "highlight", next: 0 });
  });

  it("ArrowUp moves highlight back with wrap", () => {
    expect(
      resolveSlashKey(
        { key: "ArrowUp", shiftKey: false },
        "/sh",
        trigger,
        filtered,
        0,
      ),
    ).toEqual({ kind: "highlight", next: 1 });
    expect(
      resolveSlashKey(
        { key: "ArrowUp", shiftKey: false },
        "/sh",
        trigger,
        filtered,
        1,
      ),
    ).toEqual({ kind: "highlight", next: 0 });
  });

  it("Tab picks the highlighted command", () => {
    const action = resolveSlashKey(
      { key: "Tab", shiftKey: false },
      "/sh",
      trigger,
      filtered,
      1,
    );
    expect(action.kind).toBe("pick");
    if (action.kind === "pick") {
      expect(action.cmd.name).toBe("shore");
      expect(action.nextText).toBe("/shore");
    }
  });

  it("Enter (no shift) picks the highlighted command", () => {
    const action = resolveSlashKey(
      { key: "Enter", shiftKey: false },
      "/sh",
      trigger,
      filtered,
      0,
    );
    expect(action.kind).toBe("pick");
    if (action.kind === "pick") expect(action.cmd.name).toBe("ship");
  });

  it("Shift+Enter is not consumed (lets caller insert a newline)", () => {
    expect(
      resolveSlashKey(
        { key: "Enter", shiftKey: true },
        "/sh",
        trigger,
        filtered,
        0,
      ),
    ).toEqual({ kind: "none" });
  });

  it("Escape strips the leading slash and resets caret", () => {
    const action = resolveSlashKey(
      { key: "Escape", shiftKey: false },
      "/sh",
      trigger,
      filtered,
      0,
    );
    expect(action.kind).toBe("escape");
    if (action.kind === "escape") {
      expect(action.nextText).toBe("sh");
      expect(action.nextCaret).toBe(0);
    }
  });

  it("returns none when filtered is empty (caller handles e.g. Enter to send /zzz)", () => {
    expect(
      resolveSlashKey(
        { key: "Enter", shiftKey: false },
        "/zzz",
        { slashStart: 0, queryEnd: 4, query: "zzz" },
        [],
        0,
      ),
    ).toEqual({ kind: "none" });
    expect(
      resolveSlashKey(
        { key: "ArrowDown", shiftKey: false },
        "/zzz",
        { slashStart: 0, queryEnd: 4, query: "zzz" },
        [],
        0,
      ),
    ).toEqual({ kind: "none" });
  });
});
