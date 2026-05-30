import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_FILENAME } from "./projectConstants.js";
import {
  bootstrapPlanIfMissing,
  planExists,
  planMtime,
  readPlan,
} from "./projectPlan.js";

describe("projectPlan", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-plan-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("planExists returns false when no file is present", async () => {
    expect(await planExists(dir)).toBe(false);
  });

  it("planExists returns true after bootstrap", async () => {
    await bootstrapPlanIfMissing(dir, "demo");
    expect(await planExists(dir)).toBe(true);
  });

  it("bootstrap returns true when it actually writes the skeleton", async () => {
    expect(await bootstrapPlanIfMissing(dir, "demo")).toBe(true);
  });

  it("bootstrap returns false when the file already exists", async () => {
    await bootstrapPlanIfMissing(dir, "demo");
    expect(await bootstrapPlanIfMissing(dir, "demo")).toBe(false);
  });

  it("bootstrap substitutes the project name into the heading", async () => {
    await bootstrapPlanIfMissing(dir, "demo");
    const { content } = await readPlan(dir);
    expect(content.startsWith("# demo — PLAN")).toBe(true);
  });

  it("bootstrap writes the two narrative section headers in order", async () => {
    await bootstrapPlanIfMissing(dir, "demo");
    const { content } = await readPlan(dir);
    const northStar = content.indexOf("## North Star");
    const now = content.indexOf("## Now");
    expect(northStar).toBeGreaterThanOrEqual(0);
    expect(now).toBeGreaterThan(northStar);
  });

  it("bootstrap no longer writes task-tracking sections (they live on the board)", async () => {
    await bootstrapPlanIfMissing(dir, "demo");
    const { content } = await readPlan(dir);
    expect(content).not.toContain("## Next");
    expect(content).not.toContain("## Shipped");
    expect(content).not.toContain("## Inbox");
  });

  it("bootstrap is non-destructive when PLAN.md already has user content", async () => {
    const custom = "# my own plan\n\nhand-written\n";
    await fs.writeFile(path.join(dir, PLAN_FILENAME), custom, "utf8");
    const wrote = await bootstrapPlanIfMissing(dir, "demo");
    expect(wrote).toBe(false);
    const after = await fs.readFile(path.join(dir, PLAN_FILENAME), "utf8");
    expect(after).toBe(custom);
  });

  it("planMtime returns null when missing and a finite number after bootstrap", async () => {
    expect(await planMtime(dir)).toBe(null);
    await bootstrapPlanIfMissing(dir, "demo");
    const m = await planMtime(dir);
    expect(typeof m).toBe("number");
    expect(Number.isFinite(m)).toBe(true);
  });

  it("readPlan returns content and mtime after bootstrap", async () => {
    await bootstrapPlanIfMissing(dir, "demo");
    const result = await readPlan(dir);
    expect(result.content.length).toBeGreaterThan(0);
    expect(typeof result.mtimeMs).toBe("number");
    expect(Number.isFinite(result.mtimeMs)).toBe(true);
  });
});
