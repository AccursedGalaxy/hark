import { describe, expect, it } from "vitest";
import { formatThinkingDuration } from "./format";

describe("formatThinkingDuration", () => {
  it("shows bare seconds below a minute", () => {
    expect(formatThinkingDuration(0)).toBe("0s");
    expect(formatThinkingDuration(42)).toBe("42s");
    expect(formatThinkingDuration(59)).toBe("59s");
  });

  it("switches to m+s at and above 60s", () => {
    expect(formatThinkingDuration(60)).toBe("1m 0s");
    expect(formatThinkingDuration(61)).toBe("1m 1s");
    expect(formatThinkingDuration(83)).toBe("1m 23s");
    expect(formatThinkingDuration(3599)).toBe("59m 59s");
  });

  it("switches to h+m (zero-padded minutes) at and above 3600s", () => {
    expect(formatThinkingDuration(3600)).toBe("1h 00m");
    expect(formatThinkingDuration(3720)).toBe("1h 02m");
    expect(formatThinkingDuration(7380)).toBe("2h 03m");
  });

  it("clamps non-finite or negative input to 0s", () => {
    expect(formatThinkingDuration(-5)).toBe("0s");
    expect(formatThinkingDuration(Number.NaN)).toBe("0s");
    expect(formatThinkingDuration(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});
