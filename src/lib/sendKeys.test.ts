import { describe, it, expect } from "vitest";
import {
  buildCancelModeArgs,
  buildKeyArgs,
  buildPaneModeArgs,
  buildPasteArgs,
  isFatalStderr,
  withPaneLock,
} from "./sendKeys.js";

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

describe("buildPaneModeArgs", () => {
  it("probes #{pane_in_mode} via display-message", () => {
    expect(buildPaneModeArgs("/tmp/sock", "%4")).toEqual([
      "-S",
      "/tmp/sock",
      "display-message",
      "-p",
      "-t",
      "%4",
      "-F",
      "#{pane_in_mode}",
    ]);
  });
});

describe("buildCancelModeArgs", () => {
  it("sends the copy-mode cancel keybind to the pane", () => {
    expect(buildCancelModeArgs("/tmp/sock", "%4")).toEqual([
      "-S",
      "/tmp/sock",
      "send-keys",
      "-t",
      "%4",
      "-X",
      "cancel",
    ]);
  });
});

describe("isFatalStderr", () => {
  it("treats a missing pane as fatal (no point retrying)", () => {
    expect(isFatalStderr("can't find pane: %99")).toBe(true);
    expect(isFatalStderr("can't find session: claude")).toBe(true);
    expect(isFatalStderr("no such window")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isFatalStderr("Can't Find Pane %1")).toBe(true);
  });

  it("treats transient/unknown errors as retryable", () => {
    expect(isFatalStderr("resource temporarily unavailable")).toBe(false);
    expect(isFatalStderr("")).toBe(false);
  });
});

describe("withPaneLock", () => {
  it("serializes work on the same pane (no interleaving)", async () => {
    const order: string[] = [];
    const slow = (tag: string, delay: number) =>
      withPaneLock("/sock", "%1", async () => {
        order.push(`${tag}:start`);
        await new Promise((r) => setTimeout(r, delay));
        order.push(`${tag}:end`);
      });

    // Kick both off "simultaneously"; B should not start until A finishes.
    await Promise.all([slow("A", 30), slow("B", 1)]);

    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("runs different panes concurrently", async () => {
    const order: string[] = [];
    const work = (sock: string, pane: string, tag: string, delay: number) =>
      withPaneLock(sock, pane, async () => {
        order.push(`${tag}:start`);
        await new Promise((r) => setTimeout(r, delay));
        order.push(`${tag}:end`);
      });

    await Promise.all([
      work("/sock", "%1", "A", 30),
      work("/sock", "%2", "B", 1),
    ]);

    // Distinct panes don't block each other, so the fast one finishes first.
    expect(order.indexOf("B:end")).toBeLessThan(order.indexOf("A:end"));
  });

  it("releases the lock even when the task throws", async () => {
    await expect(
      withPaneLock("/sock", "%1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A subsequent acquire must still succeed (lock wasn't left held).
    const ran = await withPaneLock("/sock", "%1", async () => "ok");
    expect(ran).toBe("ok");
  });
});
