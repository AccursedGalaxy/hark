import compression from "compression";
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeSession,
  defaultDeps as closeSessionDeps,
  sessionFilePathForPid,
} from "./lib/closeSession.js";
import { PromptState, type HookBroadcast } from "./lib/promptState.js";
import { resolveTmuxPaneForPid } from "./lib/pane.js";
import { parseMultipart } from "./lib/parseMultipart.js";
import {
  listPendingSessions,
  parseSyntheticSessionId,
} from "./lib/pendingSessions.js";
import {
  mergeSuggestions,
  readRecentDirs,
  recordSpawnedDir,
} from "./lib/recentDirs.js";
import { sendInput, sendKey } from "./lib/sendKeys.js";
import { discoverCommands } from "./lib/slashCommands.js";
import { spawnClaudeSession } from "./lib/spawnSession.js";
import { applyManagedBlock } from "./lib/claudemdBlock.js";
import { captureToBoard } from "./lib/projectCapture.js";
import {
  CLAUDE_MD_FILENAME,
  PLAN_FILENAME,
} from "./lib/projectConstants.js";
import {
  bootstrapPlanIfMissing,
  planExists,
  planMtime,
  readPlan,
} from "./lib/projectPlan.js";
import {
  resolveProjectFromCwd,
  type ResolveDeps,
} from "./lib/projectResolution.js";
import {
  formatLocation,
  type PaneLocation,
} from "./lib/tmuxLocations.js";
import type { ProjectInfo } from "./shared/protocol.js";
import { SessionIndex, type SessionFile } from "./lib/sessionIndex.js";
import { TranscriptCache } from "./lib/transcriptCache.js";
import {
  confirmTranscriptContinuity,
  readFromOffset,
  type TranscriptEvent,
} from "./lib/transcript.js";
import {
  openEmptyStream,
  openLazyTranscriptStream,
  openTranscriptStream,
  type SseWriter,
} from "./lib/transcriptStream.js";
import { storeUpload } from "./lib/uploads.js";
import {
  buildAuthCookie,
  constantTimeEquals,
  evaluateRequest,
  isAuthenticated,
  loadOrCreateToken,
} from "./lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 3000;

// Diagnostic instrumentation. When HARK_TIMING=1, attach per-stage timestamps
// to each SSE event so the client can log end-to-end latency. Off by default.
const TIMING = process.env.HARK_TIMING === "1";

const sessionsDir = path.join(os.homedir(), ".claude", "sessions");
const projectsDir = path.join(os.homedir(), ".claude", "projects");

// Where uploaded files (photos, attachments, long-text-as-files) live.
// Per-session subdirs keep things tidy and let us garbage-collect later.
const uploadsRoot =
  process.env.HARK_UPLOAD_DIR ||
  path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "hark",
    "uploads",
  );

// Caps on what we'll accept per request. 50 MB per file is plenty for a
// high-res phone photo; 200 MB total leaves headroom for a small batch.
const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Watcher-backed caches over the session dir, transcript locations, titles
// and tmux panes — the per-request directory scans + tmux shell-outs these
// replace were the dominant cost of every `/api/sessions` poll.
const sessionIndex = new SessionIndex({ sessionsDir, projectsDir });
sessionIndex.start();

// Single parsed copy of each transcript, shared by the transcript GET, the
// stream's ToolNameIndex priming, and the PromptState history replay (which
// used to be three full reads of the same multi-MB file per session open).
const transcriptCache = new TranscriptCache();

async function listLiveSessions(): Promise<SessionFile[]> {
  return sessionIndex.listSessions();
}

async function findSession(sessionId: string): Promise<SessionFile | null> {
  return sessionIndex.findSession(sessionId);
}

// Resolve a session id (registered UUID or synthetic `pending-<pid>`) to the
// tmux pane we should drive. Centralized so /send, /upload, /close all
// transparently support pending sessions.
interface ResolvedPane {
  pane: { socket: string; paneId: string };
  pid: number;
  sessionId: string;
  isPending: boolean;
}
async function resolveSessionPane(id: string): Promise<ResolvedPane | null> {
  const pendingPid = parseSyntheticSessionId(id);
  if (pendingPid !== null) {
    if (!isAlive(pendingPid)) return null;
    const pane = await resolveTmuxPaneForPid(pendingPid);
    if (!pane) return null;
    return { pane, pid: pendingPid, sessionId: id, isPending: true };
  }
  const session = await findSession(id);
  if (!session) return null;
  const pane = await resolveTmuxPaneForPid(session.pid);
  if (!pane) return null;
  return {
    pane,
    pid: session.pid,
    sessionId: session.sessionId,
    isPending: false,
  };
}

// Project resolution is per-cwd and effectively immutable for the lifetime
// of the server (sessions don't change directories; if a user moves a repo
// they'll restart hark). Cache aggressively so we don't shell out to `git
// rev-parse` on every poll for every session. The cache value is a
// "shallow" ProjectInfo with projectKey + name only — planExists/planMtime
// are looked up fresh per request via projectPlan, which is cheap (a stat).
type ShallowProject = Pick<ProjectInfo, "key" | "root" | "name">;
const projectCache = new Map<string, ShallowProject | null>();
let projectDeps: ResolveDeps | undefined;

async function resolveProjectCached(
  cwd: string,
): Promise<ShallowProject | null> {
  if (projectCache.has(cwd)) return projectCache.get(cwd)!;
  const resolved = await resolveProjectFromCwd(cwd, projectDeps);
  const shallow: ShallowProject | null = resolved
    ? { key: resolved.key, root: resolved.root, name: resolved.name }
    : null;
  projectCache.set(cwd, shallow);
  return shallow;
}

// Look up a project the server already knows about. A "known" project is
// one that's been resolved as the project of an active session's cwd —
// we never trust client-supplied project keys (paths) blind, since the
// project endpoints would otherwise write to any absolute path on disk.
function findKnownProject(key: string): ShallowProject | null {
  for (const v of projectCache.values()) {
    if (v && v.key === key) return v;
  }
  return null;
}

async function projectInfoForKey(
  key: string,
): Promise<ProjectInfo | null> {
  const shallow = findKnownProject(key);
  if (!shallow) return null;
  const [exists, mtime] = await Promise.all([
    planExists(shallow.root),
    planMtime(shallow.root),
  ]);
  return {
    ...shallow,
    planExists: exists,
    planMtime: mtime,
  };
}

// gzip/brotli responses. The big win is transcripts (a 2.3MB JSON body is
// ~150–250KB on the wire), but session lists and static assets benefit too.
// SSE endpoints are excluded: compression buffers output, which would hold
// events back indefinitely.
app.use(
  compression({
    threshold: 1024,
    filter: (req, res) => {
      if (req.path === "/api/events" || req.path.endsWith("/stream")) {
        return false;
      }
      return compression.filter(req, res);
    },
  }),
);

app.use(express.json({ limit: "1mb" }));

// ---- Auth boundary --------------------------------------------------------
//
// hark listens on 0.0.0.0 and can type into live Claude Code sessions, so an
// unauthenticated /api is remote code execution for anyone on the tailnet or
// LAN. Everything under /api sits behind this middleware; the static shell
// stays open so the SPA can load and show its login screen (all data lives
// behind /api). See lib/auth.ts for the token/cookie scheme.
//
// `HARK_AUTH_TOKEN` overrides the on-disk token for tests/dev; otherwise the
// token lives at ~/.config/hark/token (generated on first boot). We log the
// path, never the token.
const envToken = process.env.HARK_AUTH_TOKEN;
let authToken: string;
if (envToken) {
  authToken = envToken;
} else {
  const loaded = await loadOrCreateToken();
  authToken = loaded.token;
  console.log(
    `Auth token ${loaded.created ? "generated" : "loaded"}: ${loaded.filePath}`,
  );
}

// requireAuth: runs before every route below (including both SSE endpoints —
// EventSource sends same-origin cookies automatically, so they need nothing
// beyond ordering). Loopback peers are exempt: local Claude Code hooks POST
// /api/hook with no credentials, and the CLI/dev tooling curls localhost.
// The decision itself lives in lib/auth.ts as a pure function; this just
// feeds it the request. Note we trust only the socket peer address — never
// spoofable headers like X-Forwarded-For.
app.use((req, res, next) => {
  const verdict = evaluateRequest(
    {
      remoteAddress: req.socket.remoteAddress,
      path: req.path,
      method: req.method,
      cookieHeader: req.headers.cookie,
      authHeader: req.headers.authorization,
    },
    authToken,
  );
  if (verdict === "deny") {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

// Browser login: exchange the token (typed once per device) for the
// long-lived hark_auth cookie. Constant-time check — see lib/auth.ts.
app.post("/api/auth/login", (req, res) => {
  const supplied = (req.body ?? {}) as { token?: unknown };
  if (
    typeof supplied.token !== "string" ||
    !constantTimeEquals(supplied.token, authToken)
  ) {
    res.status(401).json({ error: "invalid token" });
    return;
  }
  res.setHeader("Set-Cookie", buildAuthCookie(authToken));
  res.json({ ok: true });
});

// Auth probe for the client's AuthGate: same logic as the middleware but
// always answers 200 with a boolean, so an unauthenticated page load can
// decide to show the login card without console-noisy 401s. Loopback counts
// as authenticated (it was never asked to log in).
app.get("/api/auth/status", (req, res) => {
  res.json({
    authenticated: isAuthenticated(
      {
        remoteAddress: req.socket.remoteAddress,
        cookieHeader: req.headers.cookie,
        authHeader: req.headers.authorization,
      },
      authToken,
    ),
  });
});

const promptState = new PromptState();
type HookSubscriber = (ev: HookBroadcast) => void;
const hookSubscribers = new Set<HookSubscriber>();

function broadcastHook(ev: HookBroadcast): void {
  for (const fn of hookSubscribers) {
    try {
      fn(ev);
    } catch {
      /* skip broken subscriber */
    }
  }
  // Attention changes alter the session list (needsAttention, lastEvent,
  // pending prompts) — fold them into the debounced SSE list push so the
  // sidebar updates without waiting for the client's fallback poll.
  scheduleSessionsPush();
}

// Build the full augmented session list (the `/api/sessions` body). Shared
// by the GET handler and the SSE `sessions` push.
async function buildSessionList(): Promise<unknown[]> {
  const [sessions, pending, paneLocations] = await Promise.all([
    listLiveSessions(),
    listPendingSessions(),
    sessionIndex.paneLocations(),
  ]);
  const attention = promptState.snapshot();
  const registeredPids = new Set(sessions.map((s) => s.pid));

  const augmented = await Promise.all(
    sessions.map(async (s) => {
      const att = attention[s.sessionId];
      const [pane, transcriptPath, project] = await Promise.all([
        sessionIndex.paneFor(s.pid),
        sessionIndex.transcriptPathFor(s.sessionId),
        resolveProjectCached(s.cwd),
      ]);
      const loc: PaneLocation | undefined =
        pane ? paneLocations.get(pane.paneId) : undefined;
      // Claude Code writes an `ai-title` row into the transcript as it
      // refines a name for the session. Surfacing it as `name` lets the
      // sidebar label become meaningful instead of just the cwd basename.
      // SessionFile.name (if Claude Code ever writes one) wins.
      const aiTitle = transcriptPath
        ? await sessionIndex.titleFor(transcriptPath)
        : null;
      return {
        ...s,
        name: s.name ?? aiTitle ?? undefined,
        hasTmuxPane: pane !== null,
        tmuxLocation: loc ? formatLocation(loc) : null,
        tmuxWindowName: loc?.windowName ?? null,
        needsAttention: att?.needsAttention ?? false,
        // Severity tier of the attention flag (blocking > error > idle) so
        // clients can pick ambient signal strength instead of one red dot.
        attentionKind: att?.attentionKind ?? null,
        lastEvent: att?.lastEvent,
        lastEventAt: att?.lastEventAt,
        lastEventMessage: att?.message,
        notificationType: att?.notificationType,
        pendingPermission: att?.pendingPermission,
        // `pending` (discriminated union) is broadcast over SSE for live
        // updates; include the current value here too so a fresh GET picks
        // up an in-flight prompt without waiting for the next hook.
        pending: att?.pending,
        waitingFor: s.waitingFor,
        projectKey: project?.key ?? null,
      };
    }),
  );

  // Pending rows: claude processes waiting on Claude's trust dialog (or
  // otherwise pre-init). Driving `1\r` from the rail lets the user clear
  // the gate without having to switch to tmux.
  const pendingRows = await Promise.all(
    pending
      .filter((p) => !registeredPids.has(p.pid))
      .map(async (p) => {
        const loc = paneLocations.get(p.paneId);
        const now = Date.now();
        const project = await resolveProjectCached(p.cwd);
        return {
          pid: p.pid,
          sessionId: p.sessionId,
          cwd: p.cwd,
          startedAt: now,
          updatedAt: now,
          version: "",
          kind: "pending" as const,
          status: "idle" as const,
          hasTmuxPane: true,
          tmuxLocation: loc ? formatLocation(loc) : null,
          tmuxWindowName: loc?.windowName ?? null,
          needsAttention: true,
          // The trust dialog blocks the whole session until the user
          // confirms — same "stuck on a decision" severity as a pending
          // permission, even though it never flows through PromptState.
          attentionKind: "blocking" as const,
          lastEvent: "Pending",
          lastEventAt: now,
          lastEventMessage: "Waiting for trust confirmation",
          projectKey: project?.key ?? null,
        };
      }),
  );

  return [...augmented, ...pendingRows];
}

app.get("/api/sessions", async (_req, res) => {
  res.json({ sessions: await buildSessionList() });
});

// Debounced "sessions changed" push over the /api/events SSE channel.
// Triggers: session-dir watch fires (spawn/close/status flips) and attention
// broadcasts. Identical consecutive lists are suppressed so hook bursts
// don't spam every subscriber with byte-identical frames.
const SESSIONS_PUSH_DEBOUNCE_MS = 250;
type SessionListSubscriber = (sessions: unknown[]) => void;
const sessionListSubscribers = new Set<SessionListSubscriber>();
let sessionsPushTimer: NodeJS.Timeout | null = null;
let lastPushedSessionsJson = "";

function scheduleSessionsPush(): void {
  if (sessionsPushTimer) return;
  sessionsPushTimer = setTimeout(() => {
    sessionsPushTimer = null;
    if (sessionListSubscribers.size === 0) return;
    void buildSessionList()
      .then((sessions) => {
        const json = JSON.stringify(sessions);
        if (json === lastPushedSessionsJson) return;
        lastPushedSessionsJson = json;
        for (const fn of sessionListSubscribers) {
          try {
            fn(sessions);
          } catch {
            /* skip broken subscriber */
          }
        }
      })
      .catch(() => {});
  }, SESSIONS_PUSH_DEBOUNCE_MS);
}

sessionIndex.onChange(scheduleSessionsPush);

app.post("/api/hook", (req, res) => {
  // Legacy decision hooks (the removed orchestration harness registered
  // synchronous PreToolUse/UserPromptSubmit curls whose stdout Claude Code
  // reads back as a decision). Machines that haven't rerun install-hooks may
  // still post them — answer `{}` (no opinion, fail open) and keep them out of
  // promptState, which doesn't know these events.
  const evName = (req.body?.hook_event_name ?? "") as string;
  if (evName === "PreToolUse" || evName === "UserPromptSubmit") {
    res.json({});
    return;
  }
  try {
    const ev = promptState.record(req.body);
    broadcastHook(ev);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  writeEvent(res, "snapshot", promptState.snapshot());

  const sub: HookSubscriber = (ev) => writeEvent(res, "hook", ev);
  hookSubscribers.add(sub);

  const sessionsSub: SessionListSubscriber = (sessions) =>
    writeEvent(res, "sessions", { sessions });
  sessionListSubscribers.add(sessionsSub);

  // One list frame right after the attention snapshot so a fresh client
  // (or a mobile tab returning from suspension, which reopens the stream)
  // renders the current sidebar without waiting for a poll.
  let open = true;
  void buildSessionList()
    .then((sessions) => {
      if (open) writeEvent(res, "sessions", { sessions });
    })
    .catch(() => {});

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    open = false;
    clearInterval(heartbeat);
    hookSubscribers.delete(sub);
    sessionListSubscribers.delete(sessionsSub);
    res.end();
  });
});

app.get("/api/sessions/:id/transcript", async (req, res) => {
  // Pending sessions don't have a transcript yet — return an empty one so
  // the UI shows the composer (where the user can type `1` to clear the
  // trust gate) instead of a 404 error.
  if (parseSyntheticSessionId(req.params.id) !== null) {
    res.json({ events: [], offset: 0 });
    return;
  }
  const filePath = await sessionIndex.transcriptPathFor(req.params.id);
  let stat: { size: number; mtimeMs: number } | null = null;
  if (filePath) {
    try {
      stat = await fs.stat(filePath);
    } catch {
      // Cached path went stale (transcript deleted) — forget it and fall
      // through to the no-transcript handling below.
      sessionIndex.invalidateTranscriptPath(req.params.id);
    }
  }
  if (!filePath || !stat) {
    // The session itself exists but hasn't written any events yet (fresh
    // claude that just cleared its trust gate, or a session that hasn't
    // produced output). Return an empty transcript so the UI shows a
    // friendly "start typing" state instead of "transcript: 404".
    if (await findSession(req.params.id)) {
      res.json({ events: [], offset: 0 });
      return;
    }
    res.status(404).json({ error: "transcript not found" });
    return;
  }
  // Delta read: `?after=<offset>&lastUuid=<uuid>` returns only events past
  // the client's byte cursor (it holds the rest in its local cache). The
  // lastUuid continuity check catches rewritten files; any mismatch falls
  // back to `{reset: true}` plus the full payload so the client replaces
  // its cache instead of appending garbage.
  const afterRaw =
    typeof req.query.after === "string" ? Number(req.query.after) : NaN;
  if (Number.isFinite(afterRaw) && afterRaw >= 0) {
    const after = Math.floor(afterRaw);
    const lastUuid =
      typeof req.query.lastUuid === "string" && req.query.lastUuid
        ? req.query.lastUuid
        : null;
    const continuous =
      after <= stat.size &&
      (lastUuid === null ||
        (await confirmTranscriptContinuity(filePath, after, lastUuid)));
    if (!continuous) {
      const { events, offset } = await transcriptCache.read(filePath);
      res.json({ reset: true, events, offset });
      return;
    }
    // No ToolNameIndex here: tool_results whose tool_use predates the
    // cursor are enriched client-side against the client's cached history.
    const { events, offset } = await readFromOffset(filePath, after);
    res.json({ events, offset });
    return;
  }
  // Conditional GET: the ETag is derived from the stat alone, so an
  // unchanged transcript revisit is a 304 with zero file reads. no-cache
  // (= revalidate every time) keeps browsers honest while still letting
  // them reuse the cached body on a match.
  const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("ETag", etag);
  const ifNoneMatch = req.headers["if-none-match"];
  if (typeof ifNoneMatch === "string" && ifNoneMatch.includes(etag)) {
    res.status(304).end();
    return;
  }
  const { events, offset } = await transcriptCache.read(filePath);
  res.json({ events, offset });
});

app.get("/api/sessions/:id/stream", async (req, res) => {
  const sessionId = req.params.id;
  const isPending = parseSyntheticSessionId(sessionId) !== null;

  // Resolve the transcript file (real session). Pending sessions get
  // ready+heartbeat only. Brand-new registered sessions whose JSONL
  // hasn't been written yet get a lazy stream that polls for the file
  // and upgrades to a watching stream the moment it appears — otherwise
  // the first turn lands in the JSONL but never reaches the client.
  let filePath: string | null = null;
  if (!isPending) {
    filePath = await sessionIndex.transcriptPathFor(sessionId);
    if (!filePath && !(await findSession(sessionId))) {
      res.status(404).json({ error: "transcript not found" });
      return;
    }
  }

  // Resume cursor from the client (the offset returned by its transcript
  // fetch, or its last streamed position). Events between that byte and EOF
  // are re-delivered on open — closing the fetch→stream race window — and
  // the client dedupes by uuid. Offsets beyond EOF (file rewritten) are
  // clamped to 0 inside openTranscriptStream.
  const offsetParam =
    typeof req.query.offset === "string" ? Number(req.query.offset) : NaN;
  const initialOffset =
    Number.isFinite(offsetParam) && offsetParam >= 0
      ? Math.floor(offsetParam)
      : undefined;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const writer: SseWriter = {
    comment: (text) => res.write(`: ${text}\n\n`),
    event: (name, data) =>
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`),
  };

  const streamOpts = {
    timing: TIMING,
    tag: sessionId.slice(0, 8),
    onEvents: (events: TranscriptEvent[]) => {
      const broadcast = promptState.noteTranscriptEvents(sessionId, events);
      if (broadcast) broadcastHook(broadcast);
    },
  };

  let handle;
  if (filePath) {
    // Replay the historical transcript through PromptState before opening
    // the watcher. `openTranscriptStream` only fires onEvents for content
    // written after `offset`, so without this pass an AskUserQuestion /
    // ExitPlanMode tool_use already on disk would never get promoted into
    // pending state and the web form would stay invisible. The cache makes
    // this replay (and the ToolNameIndex the stream needs) free when the
    // transcript GET just parsed the same file.
    let toolNames;
    try {
      const cached = await transcriptCache.read(filePath);
      toolNames = cached.toolNames;
      const broadcast = promptState.noteTranscriptEvents(
        sessionId,
        cached.events,
      );
      if (broadcast) broadcastHook(broadcast);
    } catch {
      /* transient read failure — stream will catch up live anyway */
    }
    handle = await openTranscriptStream(filePath, writer, {
      ...streamOpts,
      toolNames,
      initialOffset,
    });
  } else if (isPending) {
    handle = openEmptyStream(writer);
  } else {
    // Invalidate before each poll probe: the index negative-caches misses
    // for ~2s, which would make this 500ms poll loop see a stale null and
    // delay a brand-new session's first turn.
    handle = openLazyTranscriptStream(
      () => {
        sessionIndex.invalidateTranscriptPath(sessionId);
        return sessionIndex.transcriptPathFor(sessionId);
      },
      writer,
      streamOpts,
    );
  }

  req.on("close", () => {
    handle.close();
    res.end();
  });
});

function writeEvent(
  res: express.Response,
  name: string,
  data: unknown,
): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post("/api/sessions/:id/send", async (req, res) => {
  const resolved = await resolveSessionPane(req.params.id);
  if (!resolved) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  const { pane } = resolved;

  const body = req.body as {
    text?: string;
    key?: string;
    submit?: boolean;
    // Absolute paths to upload artifacts. Each is sent as a literal
    // `@<path> ` keystroke run so Claude Code's TUI picks them up as
    // attachment chips (it scans for `@` per-keystroke, not in pastes).
    attachments?: string[];
  };

  try {
    if (typeof body.text === "string" || Array.isArray(body.attachments)) {
      // Whole payload (attachments → text → Enter) goes through one atomic,
      // pane-locked, copy-mode-safe send so concurrent clients can't interleave.
      await sendInput(pane.socket, pane.paneId, {
        attachments: body.attachments,
        text: body.text,
        submit: body.submit,
      });
    } else if (typeof body.key === "string") {
      await sendKey(pane.socket, pane.paneId, body.key);
    } else {
      res.status(400).json({ error: "expected text, key, or attachments" });
      return;
    }
    const broadcast = promptState.noteSendKeys(resolved.sessionId);
    if (broadcast) broadcastHook(broadcast);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/sessions/:id/upload", async (req, res) => {
  const resolved = await resolveSessionPane(req.params.id);
  if (!resolved) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  try {
    const parsed = await parseMultipart(req, {
      maxFileBytes: MAX_UPLOAD_FILE_BYTES,
      maxTotalBytes: MAX_UPLOAD_TOTAL_BYTES,
      maxFiles: MAX_UPLOAD_FILES,
    });
    if (parsed.files.length === 0) {
      res.status(400).json({ error: "no files in upload" });
      return;
    }
    const stored = await Promise.all(
      parsed.files.map((f) =>
        storeUpload({
          cacheRoot: uploadsRoot,
          sessionId: resolved.sessionId,
          originalName: f.filename,
          mime: f.mime,
          data: f.data,
        }),
      ),
    );
    res.json({ files: stored });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.post("/api/sessions/:id/attention/clear", (req, res) => {
  // Soft dismiss: drop the red-dot signal but keep any pending prompt so the
  // form stays on screen. Viewing != answering.
  const next = promptState.dismissAttention(req.params.id);
  if (next) broadcastHook({ sessionId: req.params.id, ...next });
  res.json({ ok: true });
});

app.post("/api/sessions/:id/close", async (req, res) => {
  const resolved = await resolveSessionPane(req.params.id);
  if (!resolved) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  try {
    // Pending sessions have no `.json` file yet, so pass null and skip the
    // unlink — closeSession handles either case.
    const result = await closeSession(
      resolved.pid,
      resolved.isPending ? null : sessionFilePathForPid(resolved.pid),
      closeSessionDeps,
    );
    const next = promptState.clear(resolved.sessionId);
    if (next) broadcastHook({ sessionId: resolved.sessionId, ...next });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/commands", async (req, res) => {
  const cwd = typeof req.query.cwd === "string" ? req.query.cwd : undefined;
  try {
    const commands = await discoverCommands({ projectCwd: cwd });
    res.json({ commands });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/spawn/recent", async (_req, res) => {
  try {
    const liveCwds = (await listLiveSessions()).map((s) => s.cwd);
    const recent = await readRecentDirs();
    res.json({ dirs: mergeSuggestions(liveCwds, recent) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/sessions/new", async (req, res) => {
  const body = (req.body ?? {}) as { cwd?: string; command?: string };
  const raw = typeof body.cwd === "string" && body.cwd ? body.cwd : "~";
  const cwd = expandHome(raw);
  // Reject paths that don't resolve to an existing directory — better error
  // than letting tmux fail with an obscure message.
  try {
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: `not a directory: ${cwd}` });
      return;
    }
  } catch {
    res.status(400).json({ error: `cwd does not exist: ${cwd}` });
    return;
  }
  try {
    const result = await spawnClaudeSession({
      cwd,
      command: body.command,
    });
    // Persist the user's spelling (raw) rather than the expanded absolute
    // path — if they typed ~/foo, that's what they'll want to see next time.
    void recordSpawnedDir(raw).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ---- Project endpoints --------------------------------------------------
//
// A "project" is the git repo containing one or more sessions' cwds (see
// projectResolution.ts). Keys are absolute repo paths, URL-encoded on the
// wire. We only expose projects the server has actually resolved from a
// live session — clients never get to write into arbitrary paths.

app.get("/api/projects", async (_req, res) => {
  try {
    // Resolve every live session's cwd into the cache, then collect the
    // distinct projects from it. This also covers pending sessions so a
    // project still shows up if its only session is mid-trust-prompt.
    const [sessions, pending] = await Promise.all([
      listLiveSessions(),
      listPendingSessions(),
    ]);
    await Promise.all([
      ...sessions.map((s) => resolveProjectCached(s.cwd)),
      ...pending.map((p) => resolveProjectCached(p.cwd)),
    ]);
    const seen = new Set<string>();
    const out: ProjectInfo[] = [];
    for (const v of projectCache.values()) {
      if (!v || seen.has(v.key)) continue;
      seen.add(v.key);
      const [exists, mtime] = await Promise.all([
        planExists(v.root),
        planMtime(v.root),
      ]);
      out.push({ ...v, planExists: exists, planMtime: mtime });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ projects: out });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/projects/:key/plan", async (req, res) => {
  const project = findKnownProject(req.params.key);
  if (!project) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  try {
    if (!(await planExists(project.root))) {
      res.json({ exists: false });
      return;
    }
    const { content, mtimeMs } = await readPlan(project.root);
    res.json({ exists: true, content, mtimeMs });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/projects/:key/capture", async (req, res) => {
  const project = findKnownProject(req.params.key);
  if (!project) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  const body = (req.body ?? {}) as { text?: unknown };
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    // Captures now land as `inbox` tasks on the project board (the keyed
    // replacement for PLAN.md's old Inbox append).
    const { taskId } = await captureToBoard(project.root, body.text);
    const info = await projectInfoForKey(project.key);
    res.json({ ok: true, taskId, project: info });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/projects/:key/install", async (req, res) => {
  const project = findKnownProject(req.params.key);
  if (!project) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  try {
    const created = await bootstrapPlanIfMissing(project.root, project.name);
    const claudemdPath = path.join(project.root, CLAUDE_MD_FILENAME);
    const claudemd = await applyManagedBlock(claudemdPath);
    res.json({
      ok: true,
      plan: {
        path: path.join(project.root, PLAN_FILENAME),
        created,
      },
      claudemd: { path: claudemdPath, ...claudemd },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Periodic safety net for the fs.watch-based resolver above: while a
// client has an SSE transcript stream open we get watch fires, but mobile
// suspends backgrounded SSE connections and missed events aren't replayed.
// This loop is independent of any client — it bounds the "stale Approve/
// Deny" window to the tick interval.
const PERMISSION_RESOLVE_TICK_MS = 1500;

setInterval(() => {
  void promptState
    .resolveStaleFromTranscripts((p) => fs.stat(p))
    .then((broadcasts) => {
      for (const b of broadcasts) broadcastHook(b);
    });
}, PERMISSION_RESOLVE_TICK_MS).unref?.();

app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

export type { TranscriptEvent };
