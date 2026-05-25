import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AttentionInfo,
  PendingPermission,
  PromptKind,
  RawSession,
  SendBody,
  SessionState,
  TranscriptEvent,
  UploadedFile,
} from "../lib/protocol";
import { derivePromptKind, deriveState } from "../lib/protocol";
import {
  clearAttention as clearAttentionApi,
  closeSession as closeSessionApi,
  fetchSessions,
  fetchTranscript,
  openHookStream,
  openTranscriptStream,
  sendToSession,
  uploadFiles,
} from "../lib/transport";

const POLL_MS = 3000;

// Mirror of `parseSyntheticSessionId` from src/lib/pendingSessions.ts.
// Duplicated rather than imported so the web bundle stays decoupled from
// the server package.
function parsePendingPid(id: string): number | null {
  if (!id.startsWith("pending-")) return null;
  const pid = Number(id.slice("pending-".length));
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

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
  upload: (
    files: File[],
    onProgress?: (loaded: number, total: number) => void,
  ) => Promise<UploadedFile[]>;
  // What Claude Code is waiting for on the current session, or null if it
  // isn't. Derived from the Notification hook's notification_type field;
  // see derivePromptKind in protocol.ts.
  currentPromptKind: PromptKind;
  // Tool detail for the pending permission on the current session, if any
  // (from the PermissionRequest hook). Drives the rich permission card.
  currentPendingPermission: PendingPermission | null;
  clearAttention: (id: string) => void;
  closeSession: (id: string) => Promise<void>;
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
        notificationType: att.notificationType ?? s.notificationType,
        pendingPermission: att.pendingPermission ?? s.pendingPermission,
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

  // Subscribe to the hook-attention SSE stream. Also used as our liveness
  // signal. We re-open the stream on every visibility return to force a
  // fresh snapshot: mobile browsers suspend backgrounded SSE connections
  // and missed events aren't replayed, so a long-suspended tab can be
  // sitting on stale state (e.g., a permission the user already resolved
  // on desktop). Reconnecting yields a clean snapshot from the server.
  useEffect(() => {
    let close: (() => void) | null = null;
    const open = () => {
      close?.();
      close = openHookStream({
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
              notificationType: v.notificationType,
              pendingPermission: v.pendingPermission,
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
              notificationType: ev.notificationType,
              pendingPermission: ev.pendingPermission,
            },
          }));
        },
      });
    };
    open();

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // Snapshot reopen for SSE liveness; refresh() so the polled session
      // list also catches up (it carries pendingPermission and status).
      open();
      refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      close?.();
    };
  }, [refresh]);

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

  const currentPromptKind = useMemo<PromptKind>(() => {
    if (!current) return null;
    return derivePromptKind(attention[current], resolvedAt[current] ?? 0);
  }, [current, attention, resolvedAt]);

  const currentPendingPermission = useMemo<PendingPermission | null>(() => {
    if (!current) return null;
    const att = attention[current];
    const pp = att?.pendingPermission;
    if (!pp) return null;
    if (pp.requestedAt <= (resolvedAt[current] ?? 0)) return null;
    return pp;
  }, [current, attention, resolvedAt]);

  const setCurrent = useCallback((id: string | null) => {
    setCurrentState(id);
  }, []);

  // Pending → real handoff. The rail shows a "pending-<pid>" row for a
  // freshly-spawned Claude process before it has registered a UUID; the
  // user can click it and start typing right away (send-keys works on the
  // pane). The moment Claude finishes booting, the pending row vanishes
  // and a real session with the same pid appears — without this effect,
  // `current` would dangle on the synthetic id and the UI would lose the
  // session until the user manually reopens it from the rail.
  useEffect(() => {
    if (!current) return;
    const pendingPid = parsePendingPid(current);
    if (pendingPid === null) return;
    const real = rawSessions.find(
      (s) => s.pid === pendingPid && !s.sessionId.startsWith("pending-"),
    );
    if (real) setCurrentState(real.sessionId);
  }, [current, rawSessions]);

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

    const tStart = performance.now();
    fetchTranscript(sessionId)
      .then(({ events: initial }) => {
        if (cancelled) return;
        const tFetched = performance.now();
        setEvents(initial);
        setTranscriptLoading(false);
        // eslint-disable-next-line no-console
        console.log(
          `[timing] session-switch sid=${sessionId.slice(0, 8)} ` +
            `events=${initial.length} fetch=${(tFetched - tStart).toFixed(0)}ms`,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTranscriptLoading(false);
        setTranscriptError(
          err instanceof Error ? err.message : "Failed to load transcript",
        );
      });

    const close = openTranscriptStream(sessionId, {
      onReady: () => {
        if (cancelled) return;
        const tReady = performance.now();
        // eslint-disable-next-line no-console
        console.log(
          `[timing] stream-ready sid=${sessionId.slice(0, 8)} ` +
            `open=${(tReady - tStart).toFixed(0)}ms`,
        );
      },
      onEvent: (ev) => {
        if (cancelled) return;
        setEvents((prev) => [...prev, ev]);
        // External resolution: any new transcript event newer than the
        // pending permission means the user already answered the prompt
        // somewhere else (e.g., typing 1 in the CLI). Bumping resolvedAt
        // hides Approve/Deny immediately instead of waiting for the
        // server-side broadcast — which fires from the same signal but
        // takes a round-trip.
        const tsMs = Date.parse(ev.ts ?? "");
        if (Number.isFinite(tsMs)) {
          setResolvedAt((prev) => {
            const cur = prev[sessionId] ?? 0;
            return tsMs > cur ? { ...prev, [sessionId]: tsMs } : prev;
          });
        }
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

  const upload = useCallback(
    async (
      files: File[],
      onProgress?: (loaded: number, total: number) => void,
    ): Promise<UploadedFile[]> => {
      if (!current) throw new Error("no session selected");
      if (files.length === 0) return [];
      const { files: uploaded } = await uploadFiles(current, files, onProgress);
      return uploaded;
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

  const closeSession = useCallback(
    async (id: string): Promise<void> => {
      // Optimistically drop from the rail so the click feels immediate; we'll
      // re-sync on the next poll either way.
      setRawSessions((prev) => prev.filter((s) => s.sessionId !== id));
      setAttention((prev) => {
        if (!(id in prev)) return prev;
        const { [id]: _omit, ...rest } = prev;
        return rest;
      });
      setCurrentState((cur) => (cur === id ? null : cur));
      try {
        await closeSessionApi(id);
      } finally {
        // Catches the case where the kill failed and the session is still
        // alive on the next poll: it'll reappear and the user can retry.
        refresh();
      }
    },
    [refresh],
  );

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
    upload,
    currentPromptKind,
    currentPendingPermission,
    clearAttention,
    closeSession,
    refresh,
  };
}
