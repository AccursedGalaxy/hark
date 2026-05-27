// Token accounting, cost estimation, and context-window math.
//
// Pure helpers — no React, no I/O. The ContextRail aggregates per-turn
// `usage` blocks off the assistant events and feeds them through these
// functions to derive the headline numbers shown on the rail.
//
// Pricing tables are best-effort and may drift from Anthropic's posted
// rates; treat the cost figure as an estimate, not an invoice. We err on
// the side of slight over-counting (e.g. assuming the larger family rate
// when a model id is ambiguous) so the displayed number isn't optimistic.

import type { MessageUsage, TranscriptEvent } from "./protocol";

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

export interface SessionUsageTotals {
  // Sums across every assistant turn.
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  webSearches: number;
  webFetches: number;
  // The most recent assistant turn's view of context size — used by the
  // rail's progress bar. Sums input + cache_creation + cache_read (the
  // tokens Anthropic actually loaded into the model on that call).
  // Output is excluded: it's generated, not held.
  currentContextTokens: number;
  // Cumulative cost across all turns, USD. Always non-negative.
  costUsd: number;
  // Cache-hit ratio across the session: read / (read + create). 1.0 means
  // every input token was a hit; 0.0 means everything was rewritten.
  cacheHitRatio: number;
  // Last-seen model id. Sessions can switch (rare), so this is "current".
  model: string | undefined;
  // Last assistant turn timestamp (ms epoch), for "last activity Xs ago".
  lastAssistantAt: number | undefined;
  // Did the most recent turn cap at max_output_tokens?
  lastStopReason: string | undefined;
  // API errors recorded across the session (rate limit, server error, ...).
  apiErrors: number;
  // Total retries summed (Claude Code marks each retry attempt).
  retries: number;
}

export function aggregateUsage(events: TranscriptEvent[]): SessionUsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let webSearches = 0;
  let webFetches = 0;
  let currentContextTokens = 0;
  let model: string | undefined;
  let lastAssistantAt: number | undefined;
  let lastStopReason: string | undefined;
  let apiErrors = 0;
  let retries = 0;
  let costUsd = 0;

  for (const ev of events) {
    if (ev.kind !== "assistant") continue;
    if (ev.isApiError) apiErrors++;
    if (ev.retryAttempt) retries++;
    if (ev.model) model = ev.model;
    if (ev.stopReason) lastStopReason = ev.stopReason;
    const ts = Date.parse(ev.ts);
    if (Number.isFinite(ts) && ts > 0) lastAssistantAt = ts;
    if (!ev.usage) continue;
    const u = ev.usage;
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    cacheCreationTokens += u.cacheCreationInputTokens;
    cacheReadTokens += u.cacheReadInputTokens;
    webSearches += u.webSearchRequests;
    webFetches += u.webFetchRequests;
    costUsd += costOfUsage(u, pricingForModel(ev.model));
    // The latest non-zero usage row wins for the context-size readout. A
    // zero-token row (synthetic / error) shouldn't reset the meter to 0.
    const turnContext =
      u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
    if (turnContext > 0) currentContextTokens = turnContext;
  }

  const cacheBase = cacheReadTokens + cacheCreationTokens;
  const cacheHitRatio = cacheBase > 0 ? cacheReadTokens / cacheBase : 0;

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    webSearches,
    webFetches,
    currentContextTokens,
    costUsd,
    cacheHitRatio,
    model,
    lastAssistantAt,
    lastStopReason,
    apiErrors,
    retries,
  };
}

// Compact "47.2k" / "1.2M" / "523" rendering for the rail. Always at most
// one decimal place; never falls below 1k unless the number actually is.
export function humanTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    return (k < 10 ? k.toFixed(1) : Math.round(k).toString()) + "k";
  }
  const m = n / 1_000_000;
  return (m < 10 ? m.toFixed(1) : Math.round(m).toString()) + "M";
}

// $X.XX always — never scientific notation. Sub-cent runs show "$0.00"
// rather than "$0" so the user can see the meter is doing something.
export function humanCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return "$0.01";
  if (usd < 100) return "$" + usd.toFixed(2);
  if (usd < 1_000) return "$" + Math.round(usd).toString();
  return "$" + (usd / 1_000).toFixed(1) + "k";
}

// Hh Mm / Mm Ss / Xs depending on magnitude. Used for both "session
// duration" and "last activity ago".
export function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// Strip the Anthropic prefix so "claude-opus-4-7" renders as "opus 4.7".
// Falls back to the raw string if the shape doesn't match.
export function shortModel(model: string | undefined): string {
  if (!model) return "—";
  const m = model.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (!m) return model;
  return `${m[1]} ${m[2]}.${m[3]}`;
}
