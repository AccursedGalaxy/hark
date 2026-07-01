import type {
  HookBroadcast,
  ProjectInfo,
  RawSession,
  SendBody,
  SlashCommand,
  TranscriptEvent,
  UploadResponse,
} from "./protocol";

// Thin REST + SSE client that mirrors the Express endpoints in src/server.ts.
// All paths are relative; in dev Vite proxies /api → :3000, in prod the same
// Express server serves the built assets so origin is identical.

// Fired on window whenever any API call comes back 401 — AuthGate listens
// and flips to the login screen (e.g. the token was rotated mid-session).
export const AUTH_REQUIRED_EVENT = "hark:auth-required";

function notifyAuthRequired(): void {
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
}

// fetch + the auth boundary: the hark_auth cookie flows automatically (same
// origin), so the only job here is turning a 401 into the auth-required
// event before throwing. Every REST call site below goes through this.
async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(url, init);
  if (r.status === 401) {
    notifyAuthRequired();
    throw new Error("unauthorized (401)");
  }
  return r;
}

export async function fetchSessions(): Promise<RawSession[]> {
  const r = await apiFetch("/api/sessions");
  if (!r.ok) throw new Error(`sessions: ${r.status}`);
  const data = (await r.json()) as { sessions: RawSession[] };
  return data.sessions;
}

export async function fetchTranscript(
  sessionId: string,
): Promise<{ events: TranscriptEvent[]; offset: number }> {
  const r = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/transcript`);
  if (!r.ok) throw new Error(`transcript: ${r.status}`);
  const data = (await r.json()) as {
    events: TranscriptEvent[];
    offset?: number;
  };
  // `offset` is the byte cursor the live stream should resume from. Older
  // servers omit it — fall back to tail-only streaming (offset undefined
  // would produce ?offset=NaN, so normalize here).
  return { events: data.events, offset: data.offset ?? 0 };
}

export interface TranscriptDeltaResponse {
  events: TranscriptEvent[];
  offset: number;
  // True when the server detected a rewritten/truncated transcript (the
  // lastUuid continuity check failed) — `events` is then the full payload
  // and must replace, not extend, the local cache.
  reset: boolean;
}

export async function fetchTranscriptDelta(
  sessionId: string,
  after: number,
  lastUuid: string | null,
): Promise<TranscriptDeltaResponse> {
  const params = new URLSearchParams({ after: String(after) });
  if (lastUuid) params.set("lastUuid", lastUuid);
  const r = await apiFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/transcript?${params.toString()}`,
  );
  if (!r.ok) throw new Error(`transcript: ${r.status}`);
  const data = (await r.json()) as {
    events?: TranscriptEvent[];
    offset?: number;
    reset?: boolean;
  };
  return {
    events: data.events ?? [],
    offset: data.offset ?? 0,
    reset: data.reset === true,
  };
}

export async function sendToSession(
  sessionId: string,
  body: SendBody,
): Promise<void> {
  const r = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
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

export async function uploadFiles(
  sessionId: string,
  files: File[],
  onProgress?: (loaded: number, total: number) => void,
): Promise<UploadResponse> {
  // XMLHttpRequest gives us progress events; fetch's body stream-progress
  // API isn't universally supported on iOS Safari yet.
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/upload`;
  const form = new FormData();
  for (const f of files) form.append("file", f, f.name);
  return await new Promise<UploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress(ev.loaded, ev.total);
    };
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResponse);
        } catch (e) {
          reject(e);
        }
      } else if (xhr.status === 401) {
        // Same 401 handling as apiFetch — the upload path is XHR-based (for
        // progress events) so it can't share the wrapper directly.
        notifyAuthRequired();
        reject(new Error("unauthorized (401)"));
      } else {
        let msg = `upload failed (${xhr.status})`;
        try {
          const j = JSON.parse(xhr.responseText) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          /* keep default */
        }
        reject(new Error(msg));
      }
    };
    xhr.send(form);
  });
}

export async function clearAttention(sessionId: string): Promise<void> {
  await apiFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/attention/clear`,
    { method: "POST" },
  ).catch(() => {});
}

export async function closeSession(sessionId: string): Promise<void> {
  const r = await apiFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/close`,
    { method: "POST" },
  );
  if (!r.ok) {
    let msg = `close failed (${r.status})`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
}

export interface SpawnResponse {
  ok: true;
  sessionName: string;
  createdSession: boolean;
  // PID of the new pane's process. The client uses this to auto-focus the
  // matching pending session row as soon as it appears in the rail.
  pid: number | null;
}

export async function fetchSlashCommands(cwd: string): Promise<SlashCommand[]> {
  // Best-effort fetchers: callers treat "no data" and "failed" the same, so
  // swallow the apiFetch throw too (the 401 event has already fired by then).
  let r: Response;
  try {
    r = await apiFetch(`/api/commands?cwd=${encodeURIComponent(cwd)}`);
  } catch {
    return [];
  }
  if (!r.ok) return [];
  const data = (await r.json()) as { commands?: SlashCommand[] };
  return Array.isArray(data.commands) ? data.commands : [];
}

export async function fetchRecentSpawnDirs(): Promise<string[]> {
  let r: Response;
  try {
    r = await apiFetch("/api/spawn/recent");
  } catch {
    return [];
  }
  if (!r.ok) return [];
  const data = (await r.json()) as { dirs?: string[] };
  return Array.isArray(data.dirs) ? data.dirs : [];
}

// ---- Projects ------------------------------------------------------------

export async function fetchProjects(): Promise<ProjectInfo[]> {
  const r = await apiFetch("/api/projects");
  if (!r.ok) throw new Error(`projects: ${r.status}`);
  const data = (await r.json()) as { projects: ProjectInfo[] };
  return data.projects;
}

export type PlanResponse =
  | { exists: true; content: string; mtimeMs: number }
  | { exists: false };

export async function fetchProjectPlan(
  projectKey: string,
): Promise<PlanResponse> {
  const r = await apiFetch(
    `/api/projects/${encodeURIComponent(projectKey)}/plan`,
  );
  if (!r.ok) throw new Error(`plan: ${r.status}`);
  return (await r.json()) as PlanResponse;
}

export async function captureToProject(
  projectKey: string,
  text: string,
): Promise<ProjectInfo | null> {
  const r = await apiFetch(
    `/api/projects/${encodeURIComponent(projectKey)}/capture`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  if (!r.ok) {
    let msg = `capture failed (${r.status})`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
  const data = (await r.json()) as { ok: true; project: ProjectInfo | null };
  return data.project;
}

export interface InstallResponse {
  ok: true;
  plan: { path: string; created: boolean };
  claudemd: {
    path: string;
    created: boolean;
    replaced: boolean;
    unchanged: boolean;
    appended: boolean;
  };
}

export async function installProject(
  projectKey: string,
): Promise<InstallResponse> {
  const r = await apiFetch(
    `/api/projects/${encodeURIComponent(projectKey)}/install`,
    { method: "POST" },
  );
  if (!r.ok) throw new Error(`install: ${r.status}`);
  return (await r.json()) as InstallResponse;
}

export async function spawnSession(cwd: string): Promise<SpawnResponse> {
  const r = await apiFetch("/api/sessions/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  if (!r.ok) {
    let msg = `spawn failed (${r.status})`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
  return (await r.json()) as SpawnResponse;
}

// ---- SSE wrappers. EventSource auto-reconnects on its own; we only need
// to manage subscription lifecycle.

export interface HookStreamHandlers {
  onSnapshot: (snap: Record<string, HookBroadcast>) => void;
  onHook: (ev: HookBroadcast) => void;
  // Full session list pushed by the server (on connect, then whenever the
  // session dir or attention state changes). Replaces fast polling.
  onSessions?: (sessions: RawSession[]) => void;
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
  es.addEventListener("sessions", (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { sessions?: RawSession[] };
      if (Array.isArray(data.sessions)) handlers.onSessions?.(data.sessions);
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

// Diagnostic timestamps attached by the server when HARK_TIMING=1. Used only
// to log latency breakdowns in the browser console; not part of the protocol.
interface ServerTiming {
  tWatch: number;
  tParsed: number;
  tSse: number;
}

function logEventTiming(ev: TranscriptEvent, t: ServerTiming): void {
  const tReceive = Date.now();
  const parsed = ev.ts ? new Date(ev.ts).getTime() : NaN;
  const tJsonl = Number.isFinite(parsed) ? parsed : t.tWatch;
  const uuid = ev.uuid ? ev.uuid.slice(0, 8) : "-";
  // eslint-disable-next-line no-console
  console.log(
    `[timing] kind=${ev.kind} uuid=${uuid} ` +
      `jsonl→watch=${t.tWatch - tJsonl}ms ` +
      `watch→parse=${t.tParsed - t.tWatch}ms ` +
      `parse→sse=${t.tSse - t.tParsed}ms ` +
      `sse→recv=${tReceive - t.tSse}ms ` +
      `total=${tReceive - tJsonl}ms`,
  );
}

export function openTranscriptStream(
  sessionId: string,
  handlers: TranscriptStreamHandlers,
  // Byte offset to resume from (the `offset` returned by fetchTranscript).
  // The server re-delivers everything from here to EOF on open, closing the
  // fetch→stream race window; duplicates are deduped client-side by uuid.
  // EventSource auto-reconnects reuse the same offset, so events missed
  // during a mobile suspension are also re-delivered.
  offset?: number,
): () => void {
  const qs =
    offset !== undefined && Number.isFinite(offset)
      ? `?offset=${Math.max(0, Math.floor(offset))}`
      : "";
  const es = new EventSource(
    `/api/sessions/${encodeURIComponent(sessionId)}/stream${qs}`,
  );
  es.addEventListener("ready", () => handlers.onReady?.());
  es.addEventListener("event", (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as TranscriptEvent & {
        _timing?: ServerTiming;
      };
      if (data._timing) logEventTiming(data, data._timing);
      handlers.onEvent(data);
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("error", () => handlers.onError?.());
  return () => es.close();
}
