import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AttentionInfo,
  RawSession,
  SendBody,
  SessionState,
  TranscriptEvent,
} from "../lib/protocol";
import { deriveState } from "../lib/protocol";
import {
  clearAttention as clearAttentionApi,
  fetchSessions,
  fetchTranscript,
  openHookStream,
  openTranscriptStream,
  sendToSession,
} from "../lib/transport";

const POLL_MS = 3000;

export interface SessionView extends RawSession {
  state: SessionState;
}

export interface SessionsApi {
  connected: boolean;
  sessions: SessionView[];
  attentionCount: number;
  current: string | null;
  currentSession: SessionView | null;
  setCurrent: (id: string | null) => void;
  events: TranscriptEvent[];
  transcriptLoading: boolean;
  transcriptError: string | null;
  send: (body: SendBody) => Promise<void>;
  sendError: string | null;
  // True when the current session has an unresolved Claude Code Notification
  // hook (permission prompt or idle waiting). Cleared when the user sends.
  currentRequestingInput: boolean;
  clearAttention: (id: string) => void;
  refresh: () => void;
}

// Sort sessions: attention-needing first, then busy, then by recent update.
function sortSessions(list: SessionView[]): SessionView[] {
  return [...list].sort((a, b) => {
    const rank = (s: SessionView) =>
      s.needsAttention ? 0 : s.status === "busy" ? 1 : 2;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const ta = a.lastEventAt ?? 0;
      const tb = b.lastEventAt ?? 0;
      if (ta !== tb) return tb - ta;
    }
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
}

function applyAttention(
  s: RawSession,
  att: AttentionInfo | undefined,
): SessionView {
  const merged: RawSession = att
    ? {
        ...s,
        needsAttention: att.needsAttention,
        lastEvent: att.lastEvent ?? s.lastEvent,
        lastEventAt: att.lastEventAt ?? s.lastEventAt,
        lastEventMessage: att.message ?? s.lastEventMessage,
      }
    : s;
  return { ...merged, state: deriveState(merged) };
}

export function useSessions(): SessionsApi {
  const [rawSessions, setRawSessions] = useState<RawSession[]>([]);
  const [attention, setAttention] = useState<Record<string, AttentionInfo>>({});
  const [connected, setConnected] = useState(false);
  const [current, setCurrentState] = useState<string | null>(null);
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // Per-session timestamp marking when the user resolved the latest pending
  // Notification (by sending text or keys). A Notification is considered live
  // when lastEventAt > resolvedAt[sessionId].
  const [resolvedAt, setResolvedAt] = useState<Record<string, number>>({});

  const sessionsRef = useRef<RawSession[]>([]);
  sessionsRef.current = rawSessions;

  const refresh = useCallback(() => {
    fetchSessions()
      .then(setRawSessions)
      .catch(() => {
        /* ignore — UI shows banner via hook-stream connected flag */
      });
  }, []);

  // Initial fetch + lightweight polling for new/dead sessions.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Subscribe to the hook-attention SSE stream. Also used as our liveness signal.
  useEffect(() => {
    const close = openHookStream({
      onOpen: () => setConnected(true),
      onError: () => setConnected(false),
      onSnapshot: (snap) => {
        const next: Record<string, AttentionInfo> = {};
        for (const [sid, v] of Object.entries(snap)) {
          next[sid] = {
            needsAttention: !!v.needsAttention,
            lastEvent: v.lastEvent,
            lastEventAt: v.lastEventAt,
            message: v.message,
          };
        }
        setAttention(next);
        setConnected(true);
      },
      onHook: (ev) => {
        setAttention((prev) => ({
          ...prev,
          [ev.sessionId]: {
            needsAttention: !!ev.needsAttention,
            lastEvent: ev.lastEvent,
            lastEventAt: ev.lastEventAt,
            message: ev.message,
          },
        }));
      },
    });
    return close;
  }, []);

  const sessions = useMemo(() => {
    const merged = rawSessions.map((s) => applyAttention(s, attention[s.sessionId]));
    return sortSessions(merged);
  }, [rawSessions, attention]);

  const attentionCount = useMemo(
    () => sessions.filter((s) => s.needsAttention).length,
    [sessions],
  );

  const currentSession = useMemo(
    () => sessions.find((s) => s.sessionId === current) ?? null,
    [sessions, current],
  );

  const currentRequestingInput = useMemo(() => {
    if (!current) return false;
    const att = attention[current];
    if (!att || att.lastEvent !== "Notification") return false;
    const last = att.lastEventAt ?? 0;
    const resolved = resolvedAt[current] ?? 0;
    return last > resolved;
  }, [current, attention, resolvedAt]);

  const setCurrent = useCallback((id: string | null) => {
    setCurrentState(id);
  }, []);

  // Auto-clear attention on the session the user is viewing (matches old UX).
  useEffect(() => {
    if (!current) return;
    const att = attention[current];
    if (!att?.needsAttention) return;
    if (document.hidden) return;
    setAttention((prev) => ({
      ...prev,
      [current]: { ...att, needsAttention: false },
    }));
    void clearAttentionApi(current);
  }, [current, attention]);

  // Load transcript + open live stream whenever the selected session changes.
  useEffect(() => {
    if (!current) {
      setEvents([]);
      setTranscriptError(null);
      return;
    }
    const sessionId = current;
    let cancelled = false;
    setTranscriptLoading(true);
    setTranscriptError(null);
    setEvents([]);

    fetchTranscript(sessionId)
      .then(({ events: initial }) => {
        if (cancelled) return;
        setEvents(initial);
        setTranscriptLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTranscriptLoading(false);
        setTranscriptError(
          err instanceof Error ? err.message : "Failed to load transcript",
        );
      });

    const close = openTranscriptStream(sessionId, {
      onEvent: (ev) => {
        if (cancelled) return;
        setEvents((prev) => [...prev, ev]);
      },
    });

    return () => {
      cancelled = true;
      close();
    };
  }, [current]);

  const send = useCallback(
    async (body: SendBody) => {
      if (!current) return;
      setSendError(null);
      try {
        await sendToSession(current, body);
        setResolvedAt((prev) => ({ ...prev, [current]: Date.now() }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "send failed";
        setSendError(msg);
        // surface briefly; clear after a moment so the UI doesn't stay loud
        setTimeout(() => setSendError(null), 3000);
        throw err;
      }
    },
    [current],
  );

  const clearAttention = useCallback((id: string) => {
    setAttention((prev) => {
      const cur = prev[id];
      if (!cur?.needsAttention) return prev;
      return { ...prev, [id]: { ...cur, needsAttention: false } };
    });
    void clearAttentionApi(id);
  }, []);

  return {
    connected,
    sessions,
    attentionCount,
    current,
    currentSession,
    setCurrent,
    events,
    transcriptLoading,
    transcriptError,
    send,
    sendError,
    currentRequestingInput,
    clearAttention,
    refresh,
  };
}
