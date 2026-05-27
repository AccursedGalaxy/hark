import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_FILENAME } from "./projectConstants.js";
import {
  appendCapture,
  buildCaptureLine,
  formatCaptureTimestamp,
} from "./projectCapture.js";

describe("formatCaptureTimestamp", () => {
  it("pads months and minutes with leading zeros", () => {
    expect(formatCaptureTimestamp(new Date(2026, 0, 5, 9, 7))).toBe(
      "2026-01-05 09:07",
    );
  });

  it("uses 24-hour clock", () => {
    expect(formatCaptureTimestamp(new Date(2026, 11, 31, 23, 59))).toBe(
      "2026-12-31 23:59",
    );
  });
});

describe("buildCaptureLine", () => {
  it("has the right shape", () => {
    const line = buildCaptureLine("composer paste", new Date(2026, 4, 27, 14, 32));
    expect(line).toBe("- [2026-05-27 14:32] composer paste");
  });

  it("trims surrounding whitespace from text", () => {
    const line = buildCaptureLine("  hello world  \n", new Date(2026, 4, 27, 14, 32));
    expect(line).toBe("- [2026-05-27 14:32] hello world");
  });
});

describe("appendCapture", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-capture-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("bootstraps PLAN.md when missing", async () => {
    await appendCapture(dir, "demo", "first");
    const content = await fs.readFile(path.join(dir, PLAN_FILENAME), "utf8");
    expect(content.startsWith("# demo — PLAN")).toBe(true);
  });

  it("appends one line at EOF", async () => {
    const fixed = new Date(2026, 4, 27, 14, 32);
    await appendCapture(dir, "demo", "first capture", { now: () => fixed });
    const content = await fs.readFile(path.join(dir, PLAN_FILENAME), "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toBe("- [2026-05-27 14:32] first capture");
  });

  it("is additive — does not rewrite the file", async () => {
    const fixed = new Date(2026, 4, 27, 14, 32);
    await appendCapture(dir, "demo", "alpha", { now: () => fixed });
    await appendCapture(dir, "demo", "beta", { now: () => fixed });
    const content = await fs.readFile(path.join(dir, PLAN_FILENAME), "utf8");
    expect(content).toContain("- [2026-05-27 14:32] alpha");
    expect(content).toContain("- [2026-05-27 14:32] beta");
  });

  it("rejects empty text", async () => {
    await expect(appendCapture(dir, "demo", "   ")).rejects.toThrow();
  });

  it("interleaves concurrent writes cleanly", async () => {
    // Bootstrap first so both concurrent writers race only on the append.
    await appendCapture(dir, "demo", "seed", {
      now: () => new Date(2026, 4, 27, 14, 0),
    });
    const fixed = new Date(2026, 4, 27, 14, 32);
    await Promise.all([
      appendCapture(dir, "demo", "a", { now: () => fixed }),
      appendCapture(dir, "demo", "b", { now: () => fixed }),
    ]);
    const content = await fs.readFile(path.join(dir, PLAN_FILENAME), "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    const lastTwo = lines.slice(-2).sort();
    expect(lastTwo).toEqual([
      "- [2026-05-27 14:32] a",
      "- [2026-05-27 14:32] b",
    ]);
    // No partial/overlapping bytes — every capture line must match the shape.
    const captureLines = lines.filter((l) => l.startsWith("- [2026-"));
    for (const l of captureLines) {
      expect(l).toMatch(/^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \S/);
    }
  });

  it("uses the injected now()", async () => {
    const fixed = new Date(2026, 4, 27, 14, 32);
    await appendCapture(dir, "demo", "stamped", { now: () => fixed });
    const content = await fs.readFile(path.join(dir, PLAN_FILENAME), "utf8");
    expect(content).toContain("[2026-05-27 14:32]");
  });
});
