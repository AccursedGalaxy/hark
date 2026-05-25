import { describe, expect, it } from "vitest";
import {
  buildLoginShellCommand,
  buildNewSessionArgs,
  buildNewWindowArgs,
  parsePanePid,
  parseSessionRows,
  pickSpawnTarget,
} from "./spawnSession.js";

describe("buildNewWindowArgs", () => {
  it("targets an existing tmux server and starts claude in cwd, printing pane pid", () => {
    const args = buildNewWindowArgs({
      sessionName: "claude",
      cwd: "/home/aki/Projects/hark",
      command: "claude",
    });
    expect(args).toEqual([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_pid}",
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

describe("parsePanePid", () => {
  it("parses a single trailing-newline pid line", () => {
    expect(parsePanePid("12345\n")).toBe(12345);
  });

  it("ignores leading blank lines and trims whitespace", () => {
    expect(parsePanePid("\n  6789  \n")).toBe(6789);
  });

  it("returns null on empty or malformed output", () => {
    expect(parsePanePid("")).toBeNull();
    expect(parsePanePid("\n\n")).toBeNull();
    expect(parsePanePid("not-a-number\n")).toBeNull();
    expect(parsePanePid("0\n")).toBeNull();
    expect(parsePanePid("-5\n")).toBeNull();
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

describe("buildLoginShellCommand", () => {
  it("wraps the command in a login-shell invocation so PATH from .zshrc/.bash_profile is loaded", () => {
    expect(buildLoginShellCommand("claude", "/usr/bin/zsh")).toBe(
      "exec /usr/bin/zsh -ilc 'exec claude'",
    );
  });

  it("preserves flags on the inner command", () => {
    expect(
      buildLoginShellCommand("claude --resume abc123", "/bin/bash"),
    ).toBe("exec /bin/bash -ilc 'exec claude --resume abc123'");
  });

  it("safely escapes single quotes in the inner command", () => {
    expect(buildLoginShellCommand("echo 'hi'", "/bin/sh")).toBe(
      "exec /bin/sh -ilc 'exec echo '\\''hi'\\'''",
    );
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
  it("starts a detached named session in cwd running claude, printing pane pid", () => {
    const args = buildNewSessionArgs({
      sessionName: "claude",
      cwd: "/home/aki",
      command: "claude",
    });
    expect(args).toEqual([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_pid}",
      "-s",
      "claude",
      "-c",
      "/home/aki",
      "claude",
    ]);
  });
});

