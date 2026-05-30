// Small formatting helpers shared by components.

export function basename(p: string): string {
  if (!p) return p;
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

// Friendly label for a session — name override, then cwd basename, then a short id.
export function sessionLabel(s: {
  name?: string;
  cwd?: string;
  sessionId: string;
}): string {
  if (s.name) return s.name;
  if (s.cwd) return basename(s.cwd);
  return s.sessionId.slice(0, 8);
}

// Replace common home prefixes with `~` for compact display.
export function tildeify(p: string): string {
  if (!p) return p;
  const m = p.match(/^\/(?:home|Users)\/[^/]+/);
  return m ? "~" + p.slice(m[0].length) : p;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

// Conservative line/char limits for inline tool output; user expands the rest.
export const TR_LINE_LIMIT = 24;
export const TR_CHAR_LIMIT = 2000;

// Format a live thinking-time counter (whole seconds) for the status chip.
// Keeps short runs terse and big ones legible:
//   <60s     → "42s"
//   <1h      → "1m 23s"
//   ≥1h      → "1h 02m"   (seconds drop off; minutes zero-padded)
export function formatThinkingDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
