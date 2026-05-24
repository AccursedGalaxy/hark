import type {
  HookBroadcast,
  RawSession,
  SendBody,
  TranscriptEvent,
} from "./protocol";

// Thin REST + SSE client that mirrors the Express endpoints in src/server.ts.
// All paths are relative; in dev Vite proxies /api → :3000, in prod the same
// Express server serves the built assets so origin is identical.

export async function fetchSessions(): Promise<RawSession[]> {
  const r = await fetch("/api/sessions");
  if (!r.ok) throw new Error(`sessions: ${r.status}`);
  const data = (await r.json()) as { sessions: RawSession[] };
  return data.sessions;
}

export async function fetchTranscript(
  sessionId: string,
): Promise<{ events: TranscriptEvent[] }> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/transcript`);
  if (!r.ok) throw new Error(`transcript: ${r.status}`);
  return (await r.json()) as { events: TranscriptEvent[] };
}

export async function sendToSession(
  sessionId: string,
  body: SendBody,
): Promise<void> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `send failed (${r.status})`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
}

export async function clearAttention(sessionId: string): Promise<void> {
  await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/attention/clear`,
    { method: "POST" },
  ).catch(() => {});
}

// ---- SSE wrappers. EventSource auto-reconnects on its own; we only need
// to manage subscription lifecycle.

export interface HookStreamHandlers {
  onSnapshot: (snap: Record<string, HookBroadcast>) => void;
  onHook: (ev: HookBroadcast) => void;
  onOpen?: () => void;
  onError?: () => void;
}

export function openHookStream(handlers: HookStreamHandlers): () => void {
  const es = new EventSource("/api/events");
  es.addEventListener("snapshot", (e: MessageEvent) => {
    try {
      const snap = JSON.parse(e.data) as Record<string, HookBroadcast>;
      handlers.onSnapshot(snap);
    } catch {
      /* ignore parse errors */
    }
  });
  es.addEventListener("hook", (e: MessageEvent) => {
    try {
      handlers.onHook(JSON.parse(e.data) as HookBroadcast);
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("open", () => handlers.onOpen?.());
  es.addEventListener("error", () => handlers.onError?.());
  return () => es.close();
}

export interface TranscriptStreamHandlers {
  onEvent: (ev: TranscriptEvent) => void;
  onReady?: () => void;
  onError?: () => void;
}

export function openTranscriptStream(
  sessionId: string,
  handlers: TranscriptStreamHandlers,
): () => void {
  const es = new EventSource(
    `/api/sessions/${encodeURIComponent(sessionId)}/stream`,
  );
  es.addEventListener("ready", () => handlers.onReady?.());
  es.addEventListener("event", (e: MessageEvent) => {
    try {
      handlers.onEvent(JSON.parse(e.data) as TranscriptEvent);
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("error", () => handlers.onError?.());
  return () => es.close();
}
