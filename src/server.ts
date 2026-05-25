import express from "express";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeSession,
  defaultDeps as closeSessionDeps,
  sessionFilePathForPid,
} from "./lib/closeSession.js";
import { HookState, type HookBroadcast } from "./lib/hookState.js";
import { resolveTmuxPaneForPid } from "./lib/pane.js";
import { parseMultipart } from "./lib/parseMultipart.js";
import { sendKey, sendLiteral, sendText } from "./lib/sendKeys.js";
import { dedupeBySessionId } from "./lib/sessionList.js";
import { spawnClaudeSession } from "./lib/spawnSession.js";
import {
  formatLocation,
  listPaneLocations,
  type PaneLocation,
} from "./lib/tmuxLocations.js";
import {
  parseLine,
  readFromOffset,
  readTranscriptFile,
  ToolNameIndex,
  type TranscriptEvent,
} from "./lib/transcript.js";
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
  status?: "busy" | "idle" | string;
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

const hookState = new HookState();
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
  const sessions = await listLiveSessions();
  const attention = hookState.snapshot();
  const paneLocations = await listPaneLocations();
  const augmented = await Promise.all(
    sessions.map(async (s) => {
      const att = attention[s.sessionId];
      const pane = await resolveTmuxPaneForPid(s.pid);
      const loc: PaneLocation | undefined =
        pane ? paneLocations.get(pane.paneId) : undefined;
      return {
        ...s,
        hasTmuxPane: pane !== null,
        tmuxLocation: loc ? formatLocation(loc) : null,
        tmuxWindowName: loc?.windowName ?? null,
        needsAttention: att?.needsAttention ?? false,
        lastEvent: att?.lastEvent,
        lastEventAt: att?.lastEventAt,
        lastEventMessage: att?.message,
        notificationType: att?.notificationType,
        pendingPermission: att?.pendingPermission,
      };
    }),
  );
  res.json({ sessions: augmented });
});

app.post("/api/hook", (req, res) => {
  try {
    const ev = hookState.record(req.body);
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

  writeEvent(res, "snapshot", hookState.snapshot());

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
  const filePath = await findTranscriptPath(req.params.id);
  if (!filePath) {
    res.status(404).json({ error: "transcript not found" });
    return;
  }
  const { events, offset } = await readTranscriptFile(filePath);
  res.json({ events, offset });
});

app.get("/api/sessions/:id/stream", async (req, res) => {
  const filePath = await findTranscriptPath(req.params.id);
  if (!filePath) {
    res.status(404).json({ error: "transcript not found" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Prime a tool-name index from everything already in the file so that
  // tool_result events arriving on the stream can be enriched even though
  // their matching tool_use blocks were emitted in an earlier read pass.
  const toolNames = new ToolNameIndex();
  try {
    const existing = await fs.readFile(filePath, "utf8");
    for (const line of existing.split("\n")) {
      const ev = parseLine(line);
      if (ev?.kind === "assistant") toolNames.noteAssistant(ev.blocks);
    }
  } catch {
    /* file may be missing — fall through */
  }

  let offset = (await fs.stat(filePath)).size;
  res.write(`event: ready\ndata: ${JSON.stringify({ offset })}\n\n`);

  let inFlight = false;
  // First watch-fire time per pending batch; reset when drain consumes it.
  let pendingWatchTs: number | null = null;
  const drain = async () => {
    if (inFlight) return;
    inFlight = true;
    const tWatch = pendingWatchTs ?? Date.now();
    pendingWatchTs = null;
    try {
      const { events, offset: newOffset } = await readFromOffset(
        filePath,
        offset,
        toolNames,
      );
      const tParsed = Date.now();
      offset = newOffset;
      for (const ev of events) {
        const tSse = Date.now();
        const payload = TIMING
          ? { ...ev, _timing: { tWatch, tParsed, tSse } }
          : ev;
        writeEvent(res, "event", payload);
        if (TIMING) {
          const parsedTs = ev.ts ? Date.parse(ev.ts) : NaN;
          const tJsonl = Number.isFinite(parsedTs) ? parsedTs : tWatch;
          const sid = req.params.id.slice(0, 8);
          const uuid = ev.uuid ? ev.uuid.slice(0, 8) : "-";
          console.log(
            `[timing] sid=${sid} kind=${ev.kind} uuid=${uuid} ` +
              `jsonl→watch=${tWatch - tJsonl}ms ` +
              `watch→parse=${tParsed - tWatch}ms ` +
              `parse→sse=${tSse - tParsed}ms`,
          );
        }
      }
    } catch (err) {
      writeEvent(res, "error", { message: String(err) });
    } finally {
      inFlight = false;
    }
  };

  const watcher = watch(filePath, () => {
    if (pendingWatchTs === null) pendingWatchTs = Date.now();
    void drain();
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    watcher.close();
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
  const session = await findSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  const pane = await resolveTmuxPaneForPid(session.pid);
  if (!pane) {
    res.status(409).json({ error: "session not in tmux" });
    return;
  }

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
      const atts = (body.attachments ?? []).filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
      for (const p of atts) {
        await sendLiteral(pane.socket, pane.paneId, `@${p} `);
      }
      const text = typeof body.text === "string" ? body.text : "";
      if (text.length > 0) {
        await sendText(pane.socket, pane.paneId, text);
      }
      if (body.submit !== false) {
        await sendKey(pane.socket, pane.paneId, "Enter");
      }
    } else if (typeof body.key === "string") {
      await sendKey(pane.socket, pane.paneId, body.key);
    } else {
      res.status(400).json({ error: "expected text, key, or attachments" });
      return;
    }
    clearAttention(session.sessionId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/sessions/:id/upload", async (req, res) => {
  const session = await findSession(req.params.id);
  if (!session) {
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
          sessionId: session.sessionId,
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
  clearAttention(req.params.id);
  res.json({ ok: true });
});

app.post("/api/sessions/:id/close", async (req, res) => {
  const session = await findSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  try {
    const result = await closeSession(
      session.pid,
      sessionFilePathForPid(session.pid),
      closeSessionDeps,
    );
    hookState.clear(session.sessionId);
    res.json({ ok: true, ...result });
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

function clearAttention(sessionId: string): void {
  const prev = hookState.get(sessionId);
  if (!prev || !prev.needsAttention) return;
  hookState.clear(sessionId);
  const next = hookState.get(sessionId);
  if (!next) return;
  broadcastHook({ sessionId, ...next });
}

app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

export type { TranscriptEvent };
