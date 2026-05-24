import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 3000;

const sessionsDir = path.join(os.homedir(), ".claude", "sessions");

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

app.get("/api/sessions", async (_req, res) => {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    res.json({ sessions: [] });
    return;
  }

  const sessions: SessionFile[] = [];
  await Promise.all(
    entries
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => {
        try {
          const raw = await fs.readFile(path.join(sessionsDir, f), "utf8");
          const data = JSON.parse(raw) as SessionFile;
          if (isAlive(data.pid)) sessions.push(data);
        } catch {
          /* skip unreadable/stale */
        }
      }),
  );

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ sessions });
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
