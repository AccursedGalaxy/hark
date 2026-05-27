import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  contextLimitForModel,
  costOfUsage,
  humanCost,
  humanDuration,
  humanTokens,
  pricingForModel,
  shortModel,
} from "./usage";
import type { MessageUsage, TranscriptEvent } from "./protocol";

function usage(over: Partial<MessageUsage> = {}): MessageUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    ...over,
  };
}

function assistant(
  ts: string,
  model: string | undefined,
  u: MessageUsage | undefined,
  extra: { stopReason?: string; isApiError?: boolean; retryAttempt?: number } = {},
): TranscriptEvent {
  return {
    kind: "assistant",
    uuid: ts,
    ts,
    blocks: [],
    ...(model ? { model } : {}),
    ...(u ? { usage: u } : {}),
    ...extra,
  };
}

describe("pricingForModel", () => {
  it("routes by family substring", () => {
    expect(pricingForModel("claude-opus-4-7").outputPer1M).toBe(75);
    expect(pricingForModel("claude-sonnet-4-6").outputPer1M).toBe(15);
    expect(pricingForModel("claude-haiku-4-5-20251001").outputPer1M).toBe(5);
  });

  it("falls back to the premium family on unknown / undefined", () => {
    expect(pricingForModel(undefined).outputPer1M).toBe(75);
    expect(pricingForModel("<synthetic>").outputPer1M).toBe(75);
  });
});

describe("contextLimitForModel", () => {
  it("defaults to 200k", () => {
    expect(contextLimitForModel("claude-opus-4-7")).toBe(200_000);
  });

  it("lifts to 1M when the [1m] tier suffix is present", () => {
    expect(contextLimitForModel("claude-opus-4-7[1m]")).toBe(1_000_000);
  });
});

describe("costOfUsage", () => {
  it("sums per-category rates over 1M tokens", () => {
    // 1M input @ $15 + 1M output @ $75 + 1M cache_read @ $1.5 +
    //   1M cache_create @ $18.75 = $110.25 for opus.
    const c = costOfUsage(
      usage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      }),
      pricingForModel("claude-opus-4-7"),
    );
    expect(c).toBeCloseTo(110.25, 5);
  });

  it("returns 0 for an all-zero usage block", () => {
    expect(costOfUsage(usage(), pricingForModel("claude-opus-4-7"))).toBe(0);
  });
});

describe("aggregateUsage", () => {
  it("sums tokens and dollars across turns and tracks the last context", () => {
    const events: TranscriptEvent[] = [
      assistant(
        "2026-05-25T17:00:00.000Z",
        "claude-sonnet-4-6",
        usage({
          inputTokens: 100,
          outputTokens: 200,
          cacheCreationInputTokens: 1000,
          cacheReadInputTokens: 0,
        }),
      ),
      assistant(
        "2026-05-25T17:01:00.000Z",
        "claude-sonnet-4-6",
        usage({
          inputTokens: 10,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 1100,
        }),
      ),
    ];
    const t = aggregateUsage(events);
    expect(t.inputTokens).toBe(110);
    expect(t.outputTokens).toBe(250);
    expect(t.cacheCreationTokens).toBe(1000);
    expect(t.cacheReadTokens).toBe(1100);
    // Second turn's view: 10 + 0 + 1100 = 1110.
    expect(t.currentContextTokens).toBe(1110);
    expect(t.model).toBe("claude-sonnet-4-6");
    // Cache hit ratio = 1100 / (1100 + 1000) ≈ 0.524
    expect(t.cacheHitRatio).toBeCloseTo(0.5238, 3);
    expect(t.costUsd).toBeGreaterThan(0);
  });

  it("ignores zero-token rows for currentContextTokens", () => {
    const events: TranscriptEvent[] = [
      assistant(
        "2026-05-25T17:00:00.000Z",
        "claude-opus-4-7",
        usage({ inputTokens: 5, cacheReadInputTokens: 50_000 }),
      ),
      // Synthetic error row with all-zero usage must not blank the meter.
      assistant("2026-05-25T17:01:00.000Z", "<synthetic>", usage()),
    ];
    expect(aggregateUsage(events).currentContextTokens).toBe(50_005);
  });

  it("counts API errors and retries", () => {
    const events: TranscriptEvent[] = [
      assistant("2026-05-25T17:00:00.000Z", "claude-opus-4-7", undefined, {
        isApiError: true,
      }),
      assistant("2026-05-25T17:00:05.000Z", "claude-opus-4-7", undefined, {
        retryAttempt: 1,
      }),
      assistant("2026-05-25T17:00:10.000Z", "claude-opus-4-7", undefined, {
        retryAttempt: 2,
      }),
    ];
    const t = aggregateUsage(events);
    expect(t.apiErrors).toBe(1);
    expect(t.retries).toBe(2);
  });

  it("returns an all-zero baseline on an empty stream", () => {
    const t = aggregateUsage([]);
    expect(t.inputTokens).toBe(0);
    expect(t.cacheHitRatio).toBe(0);
    expect(t.model).toBeUndefined();
    expect(t.costUsd).toBe(0);
  });
});

describe("humanTokens", () => {
  it("renders raw counts under 1k", () => {
    expect(humanTokens(0)).toBe("0");
    expect(humanTokens(523)).toBe("523");
  });

  it("collapses thousands and millions", () => {
    expect(humanTokens(1_200)).toBe("1.2k");
    expect(humanTokens(47_213)).toBe("47k");
    expect(humanTokens(1_200_000)).toBe("1.2M");
  });

  it("guards against negative / NaN inputs", () => {
    expect(humanTokens(-5)).toBe("0");
    expect(humanTokens(Number.NaN)).toBe("0");
  });
});

describe("humanCost", () => {
  it("always shows two decimals in the sub-$100 range", () => {
    expect(humanCost(0.23)).toBe("$0.23");
    expect(humanCost(12.4)).toBe("$12.40");
  });

  it("floors sub-cent runs to $0.01 so the meter never reads zero mid-run", () => {
    expect(humanCost(0.0001)).toBe("$0.01");
  });

  it("returns $0.00 for a fresh / zero session", () => {
    expect(humanCost(0)).toBe("$0.00");
  });
});

describe("humanDuration", () => {
  it("uses seconds, then m+s, then h+m, then d+h", () => {
    expect(humanDuration(12_000)).toBe("12s");
    expect(humanDuration(125_000)).toBe("2m 5s");
    expect(humanDuration(3_900_000)).toBe("1h 5m");
    expect(humanDuration(90_000_000)).toBe("1d 1h");
  });

  it("renders em-dash for invalid input", () => {
    expect(humanDuration(Number.NaN)).toBe("—");
  });
});

describe("shortModel", () => {
  it("collapses canonical ids to family + version", () => {
    expect(shortModel("claude-opus-4-7")).toBe("opus 4.7");
    expect(shortModel("claude-sonnet-4-6")).toBe("sonnet 4.6");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
  });

  it("passes unrecognised ids through", () => {
    expect(shortModel("<synthetic>")).toBe("<synthetic>");
    expect(shortModel(undefined)).toBe("—");
  });
});
