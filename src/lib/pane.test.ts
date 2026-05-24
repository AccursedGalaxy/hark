import { describe, it, expect } from "vitest";
import { parseEnviron } from "./pane.js";

describe("parseEnviron", () => {
  it("returns paneId and socket when both TMUX_PANE and TMUX are set", () => {
    const environ =
      "PATH=/usr/bin\0TMUX_PANE=%1\0TMUX=/tmp/tmux-1000/default,2699185,1\0HOME=/home/aki\0";
    expect(parseEnviron(environ)).toEqual({
      paneId: "%1",
      socket: "/tmp/tmux-1000/default",
    });
  });

  it("returns null when TMUX_PANE is absent", () => {
    const environ = "PATH=/usr/bin\0HOME=/home/aki\0";
    expect(parseEnviron(environ)).toBeNull();
  });

  it("returns null when TMUX is absent but TMUX_PANE is present", () => {
    const environ = "TMUX_PANE=%1\0PATH=/usr/bin\0";
    expect(parseEnviron(environ)).toBeNull();
  });

  it("returns null for an empty environ", () => {
    expect(parseEnviron("")).toBeNull();
  });

  it("tolerates a trailing NUL separator", () => {
    const environ = "TMUX_PANE=%2\0TMUX=/tmp/sock,1,0\0";
    expect(parseEnviron(environ)).toEqual({
      paneId: "%2",
      socket: "/tmp/sock",
    });
  });

  it("ignores entries without an equals sign", () => {
    const environ = "bogus\0TMUX_PANE=%3\0TMUX=/tmp/sock,1,0\0";
    expect(parseEnviron(environ)).toEqual({
      paneId: "%3",
      socket: "/tmp/sock",
    });
  });

  it("handles values containing '=' correctly", () => {
    const environ = "FOO=a=b=c\0TMUX_PANE=%4\0TMUX=/tmp/sock,1,0\0";
    expect(parseEnviron(environ)).toEqual({
      paneId: "%4",
      socket: "/tmp/sock",
    });
  });
});
