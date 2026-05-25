import { describe, expect, it } from "vitest";
import {
  parseSyntheticSessionId,
  syntheticSessionId,
} from "./pendingSessions.js";

describe("syntheticSessionId / parseSyntheticSessionId", () => {
  it("round-trips a pid through the synthetic id", () => {
    const id = syntheticSessionId(12345);
    expect(id).toBe("pending-12345");
    expect(parseSyntheticSessionId(id)).toBe(12345);
  });

  it("returns null for non-pending ids", () => {
    expect(parseSyntheticSessionId("abcdef-1234")).toBeNull();
    expect(parseSyntheticSessionId("pending-")).toBeNull();
    expect(parseSyntheticSessionId("pending-abc")).toBeNull();
    expect(parseSyntheticSessionId("pending--5")).toBeNull();
  });
});
