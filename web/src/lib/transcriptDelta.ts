import { ToolNameIndex, type TranscriptEvent } from "./protocol";

// Pure helpers for reconciling a cached transcript with a `?after=` delta.

/**
 * The continuity marker to send alongside a byte cursor: the uuid of the
 * last uuid-bearing event (not all kinds carry one — e.g. synthesized rows).
 */
export function lastUuidOf(events: TranscriptEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const uuid = events[i].uuid;
    if (uuid) return uuid;
  }
  return null;
}

/**
 * Append delta events onto cached history. Two jobs beyond concat:
 *
 * - uuid dedupe — the cursor we sent was the *fetch-time* offset, so a tail
 *   that streamed in live during the previous visit is re-delivered by the
 *   delta and must not double up.
 * - tool-name enrichment — the server parses deltas without history, so a
 *   tool_result whose tool_use predates the cursor arrives unenriched
 *   (`toolName` missing, `meta` raw). The client owns the full history, so
 *   it resolves names exactly the way the server-side parse does.
 */
export function mergeDelta(
  history: TranscriptEvent[],
  delta: TranscriptEvent[],
): TranscriptEvent[] {
  if (delta.length === 0) return history;
  const index = new ToolNameIndex();
  const seen = new Set<string>();
  for (const ev of history) {
    if (ev.kind === "assistant") index.noteAssistant(ev.blocks);
    if (ev.uuid) seen.add(ev.uuid);
  }
  const out = [...history];
  for (const ev of delta) {
    if (ev.uuid && seen.has(ev.uuid)) continue;
    if (ev.kind === "assistant") {
      index.noteAssistant(ev.blocks);
      out.push(ev);
    } else if (ev.kind === "tool_result" && !ev.toolName) {
      out.push(index.enrich(ev));
    } else {
      out.push(ev);
    }
  }
  return out;
}
