import { describe, expect, it } from "vitest";
import {
  buildNewSessionArgs,
  buildNewWindowArgs,
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

