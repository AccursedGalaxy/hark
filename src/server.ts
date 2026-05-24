import express from "express";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HookState, type HookBroadcast } from "./lib/hookState.js";
import { resolveTmuxPaneForPid } from "./lib/pane.js";
import { sendKey, sendText } from "./lib/sendKeys.js";
import {
  readFromOffset,
  readTranscriptFile,
  type TranscriptEvent,
} from "./lib/transcript.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 3000;

const sessionsDir = path.join(os.homedir(), ".claude", "sessions");
const projectsDir = path.join(os.homedir(), ".claude", "projects");

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
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
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
  const augmented = await Promise.all(
    sessions.map(async (s) => {
      const att = attention[s.sessionId];
      return {
        ...s,
        hasTmuxPane: (await resolveTmuxPaneForPid(s.pid)) !== null,
        needsAttention: att?.needsAttention ?? false,
        lastEvent: att?.lastEvent,
        lastEventAt: att?.lastEventAt,
        lastEventMessage: att?.message,
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

  let offset = (await fs.stat(filePath)).size;
  res.write(`event: ready\ndata: ${JSON.stringify({ offset })}\n\n`);

  let inFlight = false;
  const drain = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { events, offset: newOffset } = await readFromOffset(
        filePath,
        offset,
      );
      offset = newOffset;
      for (const ev of events) {
        writeEvent(res, "event", ev);
      }
    } catch (err) {
      writeEvent(res, "error", { message: String(err) });
    } finally {
      inFlight = false;
    }
  };

  const watcher = watch(filePath, () => {
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
  };

  try {
    if (typeof body.text === "string") {
      if (body.text.length > 0) {
        await sendText(pane.socket, pane.paneId, body.text);
      }
      if (body.submit !== false) {
        await sendKey(pane.socket, pane.paneId, "Enter");
      }
    } else if (typeof body.key === "string") {
      await sendKey(pane.socket, pane.paneId, body.key);
    } else {
      res.status(400).json({ error: "expected text or key" });
      return;
    }
    clearAttention(session.sessionId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/sessions/:id/attention/clear", (req, res) => {
  clearAttention(req.params.id);
  res.json({ ok: true });
});

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
