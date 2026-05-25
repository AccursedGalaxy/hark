import { describe, expect, it } from "vitest";
import {
  buildNewSessionArgs,
  buildNewWindowArgs,
  parseSessionRows,
  pickSpawnTarget,
} from "./spawnSession.js";

describe("buildNewWindowArgs", () => {
  it("targets an existing tmux server and starts claude in cwd", () => {
    const args = buildNewWindowArgs({
      sessionName: "claude",
      cwd: "/home/aki/Projects/hark",
      command: "claude",
    });
    expect(args).toEqual([
      "new-window",
      "-d",
      "-t",
      "claude",
      "-c",
      "/home/aki/Projects/hark",
      "claude",
    ]);
  });

  it("supports multi-word commands as a single argv element", () => {
    const args = buildNewWindowArgs({
      sessionName: "claude",
      cwd: "/tmp",
      command: "claude --resume",
    });
    expect(args[args.length - 1]).toBe("claude --resume");
  });
});

describe("parseSessionRows", () => {
  it("parses tmux list-sessions output into typed rows", () => {
    const out = "0 1779666702 Work\n0 1779666556 claude\n1 1779711149 dev\n";
    expect(parseSessionRows(out)).toEqual([
      { name: "Work", attached: 0, activity: 1779666702 },
      { name: "claude", attached: 0, activity: 1779666556 },
      { name: "dev", attached: 1, activity: 1779711149 },
    ]);
  });

  it("ignores blank lines and malformed rows", () => {
    const out = "\n0 0\nbogus\n1 123 alpha\n";
    expect(parseSessionRows(out)).toEqual([
      { name: "alpha", attached: 1, activity: 123 },
    ]);
  });

  it("returns an empty array when tmux has no sessions", () => {
    expect(parseSessionRows("")).toEqual([]);
  });
});

describe("pickSpawnTarget", () => {
  it("prefers attached sessions over detached ones", () => {
    const rows = [
      { name: "Work", attached: 0, activity: 1779666702 },
      { name: "dev", attached: 1, activity: 1779711149 },
      { name: "claude", attached: 0, activity: 1779800000 },
    ];
    expect(pickSpawnTarget(rows)?.name).toBe("dev");
  });

  it("breaks attached ties by most recent activity", () => {
    const rows = [
      { name: "old", attached: 1, activity: 100 },
      { name: "new", attached: 1, activity: 200 },
    ];
    expect(pickSpawnTarget(rows)?.name).toBe("new");
  });

  it("falls back to the most recently active unattached session", () => {
    const rows = [
      { name: "older", attached: 0, activity: 1 },
      { name: "newer", attached: 0, activity: 2 },
    ];
    expect(pickSpawnTarget(rows)?.name).toBe("newer");
  });

  it("returns null when there are no rows", () => {
    expect(pickSpawnTarget([])).toBeNull();
  });
});

describe("buildNewSessionArgs", () => {
  it("starts a detached named session in cwd running claude", () => {
    const args = buildNewSessionArgs({
      sessionName: "claude",
      cwd: "/home/aki",
      command: "claude",
    });
    expect(args).toEqual([
      "new-session",
      "-d",
      "-s",
      "claude",
      "-c",
      "/home/aki",
      "claude",
    ]);
  });
});

