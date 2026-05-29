// Model pricing + cost estimation — the single source of truth shared by the
// web bundle (the ContextRail's cost line) and the server (the metrics DB's
// per-tick `cost_usd`). Both sides import from here so the price table never
// forks into two divergent copies.
//
// Web reaches this file via web/src/lib/usage.ts, which re-exports it (same
// pattern as web/src/lib/protocol.ts → src/shared/protocol.ts). The server
// imports it directly (src/lib/orch/*).
//
// Pure: no React, no I/O. Pricing tables are best-effort and may drift from
// Anthropic's posted rates; treat the cost figure as an estimate, not an
// invoice. We err on the side of slight over-counting (assuming the larger
// family rate when a model id is ambiguous) so the number isn't optimistic.

import type { MessageUsage } from "./protocol.js";

// USD per 1M tokens, by token category. Cache reads are the cheap path —
// roughly 10% of the base input rate; cache creation costs ~25% more than
// the base input rate because it includes the write. Numbers as of the
// Claude 4.x release line; bumped to family rate on unknown variants.
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheCreatePer1M: number;
  // Default context window. Some models expose a 1M-context tier behind a
  // suffix (e.g. "[1m]") — `contextLimitForModel` handles that override.
  contextLimit: number;
}

const OPUS: ModelPricing = {
  inputPer1M: 15,
  outputPer1M: 75,
  cacheReadPer1M: 1.5,
  cacheCreatePer1M: 18.75,
  contextLimit: 200_000,
};

const SONNET: ModelPricing = {
  inputPer1M: 3,
  outputPer1M: 15,
  cacheReadPer1M: 0.3,
  cacheCreatePer1M: 3.75,
  contextLimit: 200_000,
};

const HAIKU: ModelPricing = {
  inputPer1M: 1,
  outputPer1M: 5,
  cacheReadPer1M: 0.1,
  cacheCreatePer1M: 1.25,
  contextLimit: 200_000,
};

// Family rate for anything we can't identify — pessimistic (Opus) so the
// cost line never silently undercounts a session running on a premium tier.
const UNKNOWN: ModelPricing = OPUS;

export function pricingForModel(model: string | undefined): ModelPricing {
  if (!model) return UNKNOWN;
  const m = model.toLowerCase();
  if (m.includes("opus")) return OPUS;
  if (m.includes("sonnet")) return SONNET;
  if (m.includes("haiku")) return HAIKU;
  return UNKNOWN;
}

// Some Claude Code builds tag the 1M-context tier in the model string
// (e.g. "claude-opus-4-7[1m]"). Detect and lift the default 200k → 1M.
export function contextLimitForModel(model: string | undefined): number {
  const base = pricingForModel(model).contextLimit;
  if (!model) return base;
  return /\[1m\]/i.test(model) ? 1_000_000 : base;
}

// USD cost for one assistant turn. Each token category has its own rate;
// cache reads dominate session-long sessions because nearly every turn
// replays the prior context as a cache hit.
export function costOfUsage(
  usage: MessageUsage,
  pricing: ModelPricing,
): number {
  const M = 1_000_000;
  return (
    (usage.inputTokens * pricing.inputPer1M +
      usage.outputTokens * pricing.outputPer1M +
      usage.cacheReadInputTokens * pricing.cacheReadPer1M +
      usage.cacheCreationInputTokens * pricing.cacheCreatePer1M) /
    M
  );
}

// Aggregate-token cost convenience for callers that hold summed token totals
// (e.g. a metrics-DB tick sample) rather than per-turn `usage` blocks. The
// field names mirror AgentMetrics, not MessageUsage, so the server's
// transcript-derived totals can be priced directly.
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function costForTokens(
  tokens: TokenCounts,
  model: string | undefined,
): number {
  const p = pricingForModel(model);
  const M = 1_000_000;
  return (
    (tokens.inputTokens * p.inputPer1M +
      tokens.outputTokens * p.outputPer1M +
      tokens.cacheReadTokens * p.cacheReadPer1M +
      tokens.cacheCreationTokens * p.cacheCreatePer1M) /
    M
  );
}
