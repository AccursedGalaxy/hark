import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "./orch/boardStore.js";
import { captureToBoard, type CaptureDeps } from "./projectCapture.js";

// Each test points the capture at a throwaway board file under a temp dir so we
// never touch the real per-project board.
function depsFor(dbPath: string): CaptureDeps {
  return { openBoard: () => new BoardStore(dbPath) };
}

describe("captureToBoard", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-capture-"));
    dbPath = path.join(dir, "board.db");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates a board task in the inbox status", async () => {
    const { taskId } = await captureToBoard(dir, "first capture", depsFor(dbPath));
    const store = new BoardStore(dbPath);
    try {
      const task = store.getTask(taskId);
      expect(task?.title).toBe("first capture");
      expect(task?.status).toBe("inbox");
    } finally {
      store.close();
    }
  });

  it("trims surrounding whitespace from the captured text", async () => {
    const { taskId } = await captureToBoard(dir, "  hello world  \n", depsFor(dbPath));
    const store = new BoardStore(dbPath);
    try {
      expect(store.getTask(taskId)?.title).toBe("hello world");
    } finally {
      store.close();
    }
  });

  it("stamps created_at (the capture timestamp)", async () => {
    const before = Date.now();
    const { taskId } = await captureToBoard(dir, "stamped", depsFor(dbPath));
    const store = new BoardStore(dbPath);
    try {
      const at = store.getTask(taskId)?.createdAt;
      expect(at).toBeGreaterThanOrEqual(before);
    } finally {
      store.close();
    }
  });

  it("is additive — each capture is its own task", async () => {
    await captureToBoard(dir, "alpha", depsFor(dbPath));
    await captureToBoard(dir, "beta", depsFor(dbPath));
    const store = new BoardStore(dbPath);
    try {
      const titles = store.listTasks({ status: "inbox" }).map((t) => t.title);
      expect(titles).toContain("alpha");
      expect(titles).toContain("beta");
      expect(titles).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("rejects empty text", async () => {
    await expect(captureToBoard(dir, "   ", depsFor(dbPath))).rejects.toThrow();
  });
});
