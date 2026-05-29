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
  type PendingSession,
} from "./lib/pendingSessions.js";
import {
  mergeSuggestions,
  readRecentDirs,
  recordSpawnedDir,
} from "./lib/recentDirs.js";
import { sendInput, sendKey } from "./lib/sendKeys.js";
import { discoverCommands } from "./lib/slashCommands.js";
import { dedupeBySessionId } from "./lib/sessionList.js";
import { spawnClaudeSession } from "./lib/spawnSession.js";
import { OrchStore } from "./lib/orch/store.js";
import { Orchestrator } from "./lib/orch/orchestrator.js";
import { AutonomyController } from "./lib/orch/controller.js";
import {
  correlateAgentSessions,
  type LiveSessionRef,
} from "./lib/orch/correlation.js";
import { addWorktree, removeWorktree } from "./lib/orch/worktree.js";
import { AGENT_ROLES } from "./lib/orch/roles.js";
import type { AgentRole, OrchAgent } from "./shared/protocol.js";
import { applyManagedBlock } from "./lib/claudemdBlock.js";
import { appendCapture } from "./lib/projectCapture.js";
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
  listPaneLocations,
  type PaneLocation,
} from "./lib/tmuxLocations.js";
import type { ProjectInfo } from "./shared/protocol.js";
import {
  readSessionTitle,
  readTranscriptFile,
  type TranscriptEvent,
} from "./lib/transcript.js";
import {
  openEmptyStream,
  openLazyTranscriptStream,
  openTranscriptStream,
  type SseWriter,
} from "./lib/transcriptStream.js";
import { storeUpload } from "./lib/uploads.js";

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

type SessionFile = {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  version: string;
  kind: "interactive" | "bg" | string;
  // Newer Claude Code emits "waiting" when the TUI is blocked on a prompt
  // (permission, AskUserQuestion, ExitPlanMode, trust dialog). Older versions
  // only set "busy" / "idle". Keep the union open with `string` so unknown
  // values flow through rather than getting silently dropped.
  status?: "busy" | "idle" | "waiting" | string;
  // Free-text hint that accompanies status="waiting" (e.g. "permission
  // prompt", "ask user question"). Surfaced for header chips.
  waitingFor?: string;
  name?: string;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function listLiveSessions(): Promise<SessionFile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }
  const out: SessionFile[] = [];
  await Promise.all(
    entries
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => {
        try {
          const raw = await fs.readFile(path.join(sessionsDir, f), "utf8");
          const data = JSON.parse(raw) as SessionFile;
          if (isAlive(data.pid)) out.push(data);
        } catch {
          /* skip */
        }
      }),
  );
  // Collapse PIDs that share a sessionId — `claude --resume` leaves the old
  // PID alive briefly, and both write a sessions/<pid>.json. The newest one
  // is the live TUI; the older is a zombie that would just confuse the UI
  // and (worse) be a stale send-keys target.
  const deduped = dedupeBySessionId(out);
  deduped.sort((a, b) => b.updatedAt - a.updatedAt);
  return deduped;
}

async function findSession(sessionId: string): Promise<SessionFile | null> {
  const all = await listLiveSessions();
  return all.find((s) => s.sessionId === sessionId) ?? null;
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

async function findTranscriptPath(sessionId: string): Promise<string | null> {
  let projects: string[];
  try {
    projects = await fs.readdir(projectsDir);
  } catch {
    return null;
  }
  for (const p of projects) {
    const candidate = path.join(projectsDir, p, `${sessionId}.jsonl`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

app.use(express.json({ limit: "1mb" }));

const promptState = new PromptState();

// Orchestration runtime. State persists under ~/.hark (OrchStore); the
// orchestrator wires it to real git-worktree isolation and the existing tmux
// spawn path so each agent is a normal Claude Code session in its own branch.
const orchStore = new OrchStore();
const orchestrator = new Orchestrator({
  store: orchStore,
  addWorktree,
  removeWorktree,
  spawnSession: ({ cwd, command }) => spawnClaudeSession({ cwd, command }),
});

// Active autonomy (auto-delivering briefings + self-review nudges to live
// sessions) types real keystrokes on the user's behalf, so it's opt-in via
// HARK_ORCH_AUTONOMY=1. With it off, orchestrations still spawn agents and the
// dashboard still tracks them; the user drives each agent manually (the
// unchanged tmux-send model) and can deliver a briefing on demand.
const ORCH_AUTONOMY = process.env.HARK_ORCH_AUTONOMY === "1";

// Resolve the tmux pane for an orchestration agent and deliver text through
// the hardened send path. Prefers the registered session id; falls back to the
// spawn-time pid before the session has registered.
async function sendToAgent(agent: OrchAgent, text: string): Promise<void> {
  let pane: { socket: string; paneId: string } | null = null;
  if (agent.sessionId) {
    const resolved = await resolveSessionPane(agent.sessionId);
    pane = resolved?.pane ?? null;
  }
  if (!pane && agent.pid != null && isAlive(agent.pid)) {
    pane = await resolveTmuxPaneForPid(agent.pid);
  }
  if (!pane) throw new Error("agent session has no live tmux pane");
  await sendInput(pane.socket, pane.paneId, { text, submit: true });
}

const orchController = new AutonomyController({
  store: orchStore,
  orchestrator,
  readTranscript: async (sessionId) => {
    const filePath = await findTranscriptPath(sessionId);
    if (!filePath) return [];
    try {
      const { events } = await readTranscriptFile(filePath);
      return events;
    } catch {
      return [];
    }
  },
  sendText: sendToAgent,
  sessionReady: async (agent) => {
    if (!agent.sessionId) return false;
    const live = await listLiveSessions();
    return live.some((s) => s.sessionId === agent.sessionId);
  },
});

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
}

app.get("/api/sessions", async (_req, res) => {
  const [sessions, pending, paneLocations] = await Promise.all([
    listLiveSessions(),
    listPendingSessions(),
    listPaneLocations(),
  ]);
  const attention = promptState.snapshot();
  const registeredPids = new Set(sessions.map((s) => s.pid));

  const augmented = await Promise.all(
    sessions.map(async (s) => {
      const att = attention[s.sessionId];
      const [pane, transcriptPath, project] = await Promise.all([
        resolveTmuxPaneForPid(s.pid),
        findTranscriptPath(s.sessionId),
        resolveProjectCached(s.cwd),
      ]);
      const loc: PaneLocation | undefined =
        pane ? paneLocations.get(pane.paneId) : undefined;
      // Claude Code writes an `ai-title` row into the transcript as it
      // refines a name for the session. Surfacing it as `name` lets the
      // sidebar label become meaningful instead of just the cwd basename.
      // SessionFile.name (if Claude Code ever writes one) wins.
      const aiTitle = transcriptPath
        ? await readSessionTitle(transcriptPath)
        : null;
      return {
        ...s,
        name: s.name ?? aiTitle ?? undefined,
        hasTmuxPane: pane !== null,
        tmuxLocation: loc ? formatLocation(loc) : null,
        tmuxWindowName: loc?.windowName ?? null,
        needsAttention: att?.needsAttention ?? false,
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
          lastEvent: "Pending",
          lastEventAt: now,
          lastEventMessage: "Waiting for trust confirmation",
          projectKey: project?.key ?? null,
        };
      }),
  );

  res.json({ sessions: [...augmented, ...pendingRows] });
});

app.post("/api/hook", (req, res) => {
  try {
    const ev = promptState.record(req.body);
    broadcastHook(ev);
    // Turn-boundary hooks for orchestration-owned sessions drive the autonomy
    // loop (marker scan → advance/nudge/block). Fire-and-forget so the hook
    // POST stays fast; gated behind the opt-in flag.
    const evName = (req.body?.hook_event_name ?? "") as string;
    const sid = (req.body?.session_id ?? "") as string;
    if (ORCH_AUTONOMY && sid && (evName === "Stop" || evName === "SubagentStop")) {
      void findAgentForSession(sid)
        .then((found) =>
          found
            ? orchController.onAgentSignal(found.orchId, found.agentId, {
                stopped: true,
              })
            : undefined,
        )
        .catch(() => {});
    }
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

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    hookSubscribers.delete(sub);
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
  const filePath = await findTranscriptPath(req.params.id);
  if (!filePath) {
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
  const { events, offset } = await readTranscriptFile(filePath);
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
    filePath = await findTranscriptPath(sessionId);
    if (!filePath && !(await findSession(sessionId))) {
      res.status(404).json({ error: "transcript not found" });
      return;
    }
  }

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
    // pending state and the web form would stay invisible.
    try {
      const { events: historical } = await readTranscriptFile(filePath);
      const broadcast = promptState.noteTranscriptEvents(
        sessionId,
        historical,
      );
      if (broadcast) broadcastHook(broadcast);
    } catch {
      /* transient read failure — stream will catch up live anyway */
    }
    handle = await openTranscriptStream(filePath, writer, streamOpts);
  } else if (isPending) {
    handle = openEmptyStream(writer);
  } else {
    handle = openLazyTranscriptStream(
      () => findTranscriptPath(sessionId),
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
    await appendCapture(project.root, project.name, body.text);
    const info = await projectInfoForKey(project.key);
    res.json({ ok: true, project: info });
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

// ---- Orchestration endpoints --------------------------------------------
//
// Create and inspect multi-agent orchestrations. Like the project endpoints,
// we only act on projects the server has already resolved from a live
// session's cwd — clients never get to point an orchestration (and its
// `git worktree add`) at an arbitrary path on disk.

app.get("/api/orchestrations", async (_req, res) => {
  try {
    res.json({ orchestrations: await orchStore.listOrchestrations() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/orchestrations/:id", async (req, res) => {
  try {
    const orchestration = await orchStore.getOrchestration(req.params.id);
    if (!orchestration) {
      res.status(404).json({ error: "orchestration not found" });
      return;
    }
    const events = await orchStore.readEvents(req.params.id);
    res.json({ orchestration, events });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/orchestrations", async (req, res) => {
  const body = (req.body ?? {}) as {
    name?: unknown;
    goal?: unknown;
    projectKey?: unknown;
    baseRef?: unknown;
    roles?: unknown;
  };
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (typeof body.goal !== "string" || body.goal.trim().length === 0) {
    res.status(400).json({ error: "goal is required" });
    return;
  }
  if (typeof body.projectKey !== "string") {
    res.status(400).json({ error: "projectKey is required" });
    return;
  }
  const project = findKnownProject(body.projectKey);
  if (!project) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  // Validate requested roles against the known set; default to the full team.
  const known = new Set<AgentRole>(AGENT_ROLES);
  const roles: AgentRole[] = Array.isArray(body.roles)
    ? body.roles.filter((r): r is AgentRole => known.has(r as AgentRole))
    : [...AGENT_ROLES];
  if (roles.length === 0) {
    res.status(400).json({ error: "no valid roles requested" });
    return;
  }
  try {
    const result = await orchestrator.createTeam({
      name: body.name,
      goal: body.goal,
      projectRoot: project.root,
      projectName: project.name,
      baseRef: typeof body.baseRef === "string" ? body.baseRef : undefined,
      roles,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/orchestrations/:id/teardown", async (req, res) => {
  try {
    const orchestration = await orchStore.getOrchestration(req.params.id);
    if (!orchestration) {
      res.status(404).json({ error: "orchestration not found" });
      return;
    }
    await orchestrator.teardownOrchestration(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// User-initiated briefing delivery — send an agent its role briefing through
// the tmux send path and mark it running. Always available (even with active
// autonomy off) so the human stays in control of when an agent starts.
app.post(
  "/api/orchestrations/:id/agents/:agentId/brief",
  async (req, res) => {
    const orch = await orchStore.getOrchestration(req.params.id);
    if (!orch) {
      res.status(404).json({ error: "orchestration not found" });
      return;
    }
    const agent = orch.agents.find((a) => a.id === req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    try {
      await sendToAgent(agent, orchestrator.briefingFor(orch, agent));
      await orchStore.updateAgent(orch.id, agent.id, (a) => {
        a.briefedAt = Date.now();
        if (a.lifecycle === "pending" || a.lifecycle === "spawning") {
          a.lifecycle = "running";
        }
      });
      await orchStore.appendEvent({
        ts: Date.now(),
        orchestrationId: orch.id,
        agentId: agent.id,
        kind: "checkpoint",
        message: `briefing delivered to ${agent.role} (manual)`,
        data: { kind: "briefing" },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// Map a live session id back to its orchestration agent (active only).
async function findAgentForSession(
  sessionId: string,
): Promise<{ orchId: string; agentId: string } | null> {
  for (const o of await orchStore.listOrchestrations()) {
    if (o.status !== "active") continue;
    const a = o.agents.find((x) => x.sessionId === sessionId);
    if (a) return { orchId: o.id, agentId: a.id };
  }
  return null;
}

// Reconcile orchestration state against the live-session view: backfill
// session ids for agents whose session has registered, keep metrics fresh,
// and (when active autonomy is on) deliver briefings to newly-ready agents.
async function reconcileOrchestrations(): Promise<void> {
  const active = (await orchStore.listOrchestrations()).filter(
    (o) => o.status === "active",
  );
  if (active.length === 0) return;

  const liveRefs: LiveSessionRef[] = (await listLiveSessions()).map((s) => ({
    sessionId: s.sessionId,
    pid: s.pid,
  }));
  // 1. Backfill registered sessions onto their agents.
  for (const link of correlateAgentSessions(active, liveRefs)) {
    await orchStore.updateAgent(link.orchId, link.agentId, (a) => {
      a.sessionId = link.sessionId;
    });
  }

  // 2. Per agent: refresh metrics always; let the controller drive briefing
  //    delivery for ready agents when autonomy is enabled.
  for (const o of active) {
    for (const agent of o.agents) {
      await orchController.refreshMetrics(o.id, agent.id);
      if (ORCH_AUTONOMY) {
        await orchController.onAgentSignal(o.id, agent.id, { stopped: false });
      }
    }
  }
}

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

// Orchestration reconcile loop: backfills session ids, refreshes agent
// metrics, and (when autonomy is enabled) delivers briefings to ready agents.
// No-ops cheaply when there are no active orchestrations.
const ORCH_RECONCILE_TICK_MS = 3000;
setInterval(() => {
  void reconcileOrchestrations().catch(() => {});
}, ORCH_RECONCILE_TICK_MS).unref?.();

app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

export type { TranscriptEvent };
