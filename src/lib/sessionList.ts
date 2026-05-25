// Helpers for collapsing the raw set of `~/.claude/sessions/<pid>.json`
// records into the list we expose over the API. Pure functions; the server
// supplies I/O.

export interface SessionRecord {
  pid: number;
  sessionId: string;
  startedAt: number;
  updatedAt: number;
}

// `claude --resume <id>` spawns a fresh PID that reuses the original's
// sessionId. Both processes live on (the old one still in the process
// table) and both write a `<pid>.json`, so a naive list double-counts
// every resumed session. We collapse on sessionId, keeping the most
// recently started PID — that's the one actually attached to the TUI
// and the one our send-keys must target.
export function dedupeBySessionId<T extends SessionRecord>(records: T[]): T[] {
  const winner = new Map<string, T>();
  for (const rec of records) {
    const prev = winner.get(rec.sessionId);
    if (!prev) {
      winner.set(rec.sessionId, rec);
      continue;
    }
    if (rec.startedAt > prev.startedAt) {
      winner.set(rec.sessionId, rec);
    } else if (
      rec.startedAt === prev.startedAt &&
      rec.updatedAt > prev.updatedAt
    ) {
      winner.set(rec.sessionId, rec);
    }
  }
  return [...winner.values()];
}
