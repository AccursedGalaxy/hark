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
