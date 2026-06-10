import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AttentionInfo,
  Pending,
  PromptKind,
  RawSession,
  SendBody,
  SessionError,
  SessionState,
  SubagentInfo,
  TranscriptEvent,
  UploadedFile,
} from "../lib/protocol";
import { deriveState, parseSyntheticSessionId } from "../lib/protocol";
import {
  clearAttention as clearAttentionApi,
  closeSession as closeSessionApi,
  fetchSessions,
  fetchTranscript,
  fetchTranscriptDelta,
  openHookStream,
  openTranscriptStream,
  sendToSession,
  uploadFiles,
} from "../lib/transport";
import {
  loadTranscript,
  purgeTranscript,
  saveTranscript,
} from "../lib/transcriptCache";
import { lastUuidOf, mergeDelta } from "../lib/transcriptDelta";

// Fallback poll only — the server pushes `sessions` frames over the
// /api/events SSE stream whenever the list changes, so this just covers a
// wedged stream (and sessions dying without a file change, which the
// server's watcher can't see).
const POLL_MS = 30000;

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
  // isn't. Decided server-side by PromptState and broadcast as the
  // `promptKind` field on AttentionInfo.
  currentPromptKind: PromptKind;
  // Discriminated "Claude is waiting" state (per-tool permission, plan
  // acceptance, ask-user-question, elicitation, oauth). Drives the rich
  // PromptPanel surface.
  currentPending: Pending | null;
  // Last StopFailure on the current session, if any.
  currentLastError: SessionError | null;
  // Currently-running subagents on the current session.
  currentSubagents: SubagentInfo[];
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
        pending: att.pending ?? s.pending,
        lastError: att.lastError ?? s.lastError,
        subagents: att.subagents ?? s.subagents,
        cwd: att.cwd ?? s.cwd,
      }
    : s;
  return { ...merged, state: deriveState(merged) };
}

// Cold-open sidebar snapshot. Hydrating from localStorage paints the rail
// before the first fetch/SSE frame lands — stale rows reconcile within a
// round-trip.
const SESSIONS_SNAPSHOT_KEY = "hark:sessions";

function loadSessionsSnapshot(): RawSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_SNAPSHOT_KEY);
    const parsed = raw ? (JSON.parse(raw) as RawSession[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function useSessions(): SessionsApi {
  const [rawSessions, setRawSessions] = useState<RawSession[]>(
    loadSessionsSnapshot,
  );
  const [attention, setAttention] = useState<Record<string, AttentionInfo>>({});
  const [connected, setConnected] = useState(false);
  const [current, setCurrentState] = useState<string | null>(null);
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const sessionsRef = useRef<RawSession[]>([]);
  sessionsRef.current = rawSessions;

  // Persist the sidebar snapshot for the next cold open.
  useEffect(() => {
    try {
      localStorage.setItem(SESSIONS_SNAPSHOT_KEY, JSON.stringify(rawSessions));
    } catch {
      /* quota / private mode — snapshot is best-effort */
    }
  }, [rawSessions]);

  // Byte cursor + continuity marker the current transcript was reconciled
  // at; what cache saves are stamped with. Frozen at fetch time — streamed
  // tail events are saved with the older cursor, re-delivered by the next
  // delta, and deduped by uuid in mergeDelta.
  const cacheCursorRef = useRef<{
    sessionId: string;
    offset: number;
    lastUuid: string | null;
  } | null>(null);

  const refresh = useCallback(() => {
    fetchSessions()
      .then(setRawSessions)
      .catch(() => {
        /* ignore — UI shows banner via hook-stream connected flag */
      });
  }, []);

  // Initial fetch + slow fallback polling. Live updates arrive as
  // `sessions` SSE frames (handled in the hook-stream effect below).
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
              pending: v.pending,
              lastError: v.lastError,
              subagents: v.subagents,
              cwd: v.cwd,
              promptKind: v.promptKind ?? null,
            };
          }
          setAttention(next);
          setConnected(true);
        },
        onSessions: (list) => {
          setRawSessions(list);
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
              pending: ev.pending,
              lastError: ev.lastError,
              subagents: ev.subagents,
              cwd: ev.cwd,
              promptKind: ev.promptKind ?? null,
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
    return attention[current]?.promptKind ?? null;
  }, [current, attention]);

  const currentPending = useMemo<Pending | null>(() => {
    if (!current) return null;
    return attention[current]?.pending ?? null;
  }, [current, attention]);

  const currentLastError = useMemo<SessionError | null>(() => {
    if (!current) return null;
    return attention[current]?.lastError ?? null;
  }, [current, attention]);

  const currentSubagents = useMemo<SubagentInfo[]>(() => {
    if (!current) return [];
    return attention[current]?.subagents ?? [];
  }, [current, attention]);

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
    const pendingPid = parseSyntheticSessionId(current);
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

    // Local-first open: paint from the IndexedDB cache immediately, then
    // reconcile with the server (a small `?after=` delta when cached, the
    // full transcript otherwise), then attach the live stream at the
    // reconciled offset. The server re-delivers anything written between
    // the fetch and the stream attach, and uuid dedupe absorbs overlap, so
    // nothing can be lost in the gaps.
    let closeStream: (() => void) | null = null;
    // Synthetic pending-<pid> sessions have no transcript to cache.
    const synthetic = parseSyntheticSessionId(sessionId) !== null;

    const tStart = performance.now();
    void (async () => {
      const cached = synthetic ? null : await loadTranscript(sessionId);
      if (cancelled) return;
      if (cached && cached.events.length > 0) {
        setEvents(cached.events);
        setTranscriptLoading(false);
        // eslint-disable-next-line no-console
        console.log(
          `[timing] cache-paint sid=${sessionId.slice(0, 8)} ` +
            `events=${cached.events.length} ` +
            `paint=${(performance.now() - tStart).toFixed(0)}ms`,
        );
      }

      let merged: TranscriptEvent[];
      let offset: number;
      try {
        if (cached && cached.offset > 0) {
          const delta = await fetchTranscriptDelta(
            sessionId,
            cached.offset,
            cached.lastUuid,
          );
          if (cancelled) return;
          merged = delta.reset
            ? delta.events
            : mergeDelta(cached.events, delta.events);
          offset = delta.offset;
        } else {
          const full = await fetchTranscript(sessionId);
          if (cancelled) return;
          merged = full.events;
          offset = full.offset;
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const msg =
          err instanceof Error ? err.message : "Failed to load transcript";
        // Session gone → its cache entry is dead weight.
        if (msg.includes("404") && !synthetic) void purgeTranscript(sessionId);
        // If the cache already painted, keep showing it (offline reads work);
        // only a cold open surfaces the error state.
        if (!cached || cached.events.length === 0) {
          setTranscriptLoading(false);
          setTranscriptError(msg);
        }
        return;
      }

      const tFetched = performance.now();
      setEvents(merged);
      setTranscriptLoading(false);
      if (!synthetic) {
        cacheCursorRef.current = {
          sessionId,
          offset,
          lastUuid: lastUuidOf(merged),
        };
        if (merged.length > 0) {
          saveTranscript(sessionId, merged, offset, lastUuidOf(merged));
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `[timing] session-switch sid=${sessionId.slice(0, 8)} ` +
          `events=${merged.length} ` +
          `${cached ? "delta" : "full"}=${(tFetched - tStart).toFixed(0)}ms`,
      );

      closeStream = openTranscriptStream(
        sessionId,
        {
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
            setEvents((prev) =>
              prev.some((p) => p.uuid === ev.uuid) ? prev : [...prev, ev],
            );
            // External resolution: any new transcript event newer than the
            // pending state means the user already answered the prompt
            // somewhere else (e.g., typing 1 in the CLI). Clear the local
            // attention immediately instead of waiting for the server-side
            // broadcast — which fires from the same signal but takes a
            // round-trip. Server's PromptState.noteTranscriptEvents is the
            // authoritative resolver; this is just optimistic UI.
            const tsMs = Date.parse(ev.ts ?? "");
            if (!Number.isFinite(tsMs)) return;
            setAttention((prev) => {
              const cur = prev[sessionId];
              const requestedAt =
                cur?.pending?.requestedAt ??
                cur?.pendingPermission?.requestedAt;
              if (!cur || requestedAt === undefined || tsMs <= requestedAt)
                return prev;
              return {
                ...prev,
                [sessionId]: {
                  ...cur,
                  needsAttention: false,
                  pendingPermission: undefined,
                  pending: undefined,
                  promptKind: null,
                },
              };
            });
          },
        },
        offset,
      );
    })();

    return () => {
      cancelled = true;
      closeStream?.();
    };
  }, [current]);

  // Keep the cache fresh as the live stream appends events. saveTranscript
  // debounces internally (~1s), so per-event invocations are cheap.
  useEffect(() => {
    const cursor = cacheCursorRef.current;
    if (!cursor || cursor.sessionId !== current || events.length === 0) return;
    saveTranscript(cursor.sessionId, events, cursor.offset, cursor.lastUuid);
  }, [events, current]);

  const send = useCallback(
    async (body: SendBody) => {
      if (!current) return;
      setSendError(null);
      try {
        await sendToSession(current, body);
        // Optimistic clear: the server will broadcast the same state in a
        // moment via PromptState.noteSendKeys, but updating locally avoids
        // a visible flash of the now-stale prompt UI during the round-trip.
        setAttention((prev) => {
          const cur = prev[current];
          if (!cur) return prev;
          if (
            !cur.needsAttention &&
            !cur.pendingPermission &&
            !cur.pending &&
            !cur.lastError
          )
            return prev;
          return {
            ...prev,
            [current]: {
              ...cur,
              needsAttention: false,
              pendingPermission: undefined,
              pending: undefined,
              lastError: undefined,
              promptKind: null,
            },
          };
        });
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
      void purgeTranscript(id);
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
    currentPending,
    currentLastError,
    currentSubagents,
    clearAttention,
    closeSession,
    refresh,
  };
}
