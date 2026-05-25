import { describe, expect, it, vi } from "vitest";
import { closeSession, type CloseSessionDeps } from "./closeSession.js";

function makeDeps(overrides: Partial<CloseSessionDeps> = {}): {
  deps: CloseSessionDeps;
  kill: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  const kill = vi.fn();
  const remove = vi.fn().mockResolvedValue(undefined);
  const deps: CloseSessionDeps = {
    kill,
    isAlive: () => false,
    delay: async () => {},
    removeFile: remove,
    ...overrides,
  };
  return { deps, kill, remove };
}

describe("closeSession", () => {
  it("sends SIGTERM when the process is alive", async () => {
    const { deps, kill } = makeDeps({ isAlive: () => false });
    // First isAlive call → true (signal), second → false (no escalation)
    let calls = 0;
    deps.isAlive = () => calls++ === 0;

    const result = await closeSession(123, null, deps);

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(123, "SIGTERM");
    expect(result.signaled).toBe(true);
    expect(result.escalated).toBe(false);
  });

  it("escalates to SIGKILL if process is still alive after the grace period", async () => {
    const { deps, kill } = makeDeps({ isAlive: () => true });
    const result = await closeSession(456, null, deps, 0);

    expect(kill).toHaveBeenNthCalledWith(1, 456, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, 456, "SIGKILL");
    expect(result.signaled).toBe(true);
    expect(result.escalated).toBe(true);
  });

  it("does not signal when the process is already gone", async () => {
    const { deps, kill } = makeDeps({ isAlive: () => false });
    const result = await closeSession(789, null, deps);

    expect(kill).not.toHaveBeenCalled();
    expect(result.signaled).toBe(false);
    expect(result.escalated).toBe(false);
  });

  it("removes the session file when a path is provided", async () => {
    const { deps, remove } = makeDeps();
    const result = await closeSession(1, "/tmp/sessions/1.json", deps);

    expect(remove).toHaveBeenCalledWith("/tmp/sessions/1.json");
    expect(result.fileRemoved).toBe(true);
  });

  it("treats missing session file as success", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const { deps } = makeDeps({ removeFile: remove });
    const result = await closeSession(1, "/tmp/missing.json", deps);

    expect(remove).toHaveBeenCalled();
    expect(result.fileRemoved).toBe(false);
  });

  it("swallows EPERM from kill so closing a dead-but-flagged-alive pid still cleans up", async () => {
    const kill = vi.fn(() => {
      throw new Error("ESRCH");
    });
    const { deps, remove } = makeDeps({
      kill,
      isAlive: () => true,
      removeFile: vi.fn().mockResolvedValue(undefined),
    });
    const result = await closeSession(99, "/tmp/99.json", deps, 0);

    expect(result.signaled).toBe(false);
    expect(result.escalated).toBe(false);
    expect(result.fileRemoved).toBe(true);
  });
});
