import { describe, expect, it } from "vitest";
import { dedupeBySessionId } from "./sessionList.js";

const rec = (
  pid: number,
  sessionId: string,
  startedAt: number,
  updatedAt = startedAt,
) => ({ pid, sessionId, startedAt, updatedAt });

describe("dedupeBySessionId", () => {
  it("passes distinct sessionIds through unchanged", () => {
    const input = [rec(1, "a", 100), rec(2, "b", 200)];
    expect(dedupeBySessionId(input)).toHaveLength(2);
  });

  it("keeps the newer-started PID when sessionId is shared", () => {
    const older = rec(100, "shared", 1000);
    const newer = rec(200, "shared", 2000);
    const result = dedupeBySessionId([older, newer]);
    expect(result).toEqual([newer]);
  });

  it("is independent of input order", () => {
    const older = rec(100, "shared", 1000);
    const newer = rec(200, "shared", 2000);
    expect(dedupeBySessionId([newer, older])).toEqual([newer]);
  });

  it("falls back to updatedAt when startedAt ties", () => {
    const a = rec(100, "shared", 1000, 1500);
    const b = rec(200, "shared", 1000, 1700);
    expect(dedupeBySessionId([a, b])).toEqual([b]);
  });

  it("returns an empty array for empty input", () => {
    expect(dedupeBySessionId([])).toEqual([]);
  });
});
