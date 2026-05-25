import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveTmuxPaneForPid, type TmuxPane } from "./pane.js";

// A "pending" session is a `claude` process that's alive in a tmux pane but
// hasn't yet written `~/.claude/sessions/<pid>.json`. This happens whenever
// Claude is blocked on its trust dialog — the gate that appears the first
// time you open an unfamiliar working directory. Without surfacing these,
// the user spawns a session from the web, sees nothing new in the rail, and
// concludes the spawn failed when really it's just waiting for `1\r`.

const SYNTHETIC_ID_PREFIX = "pending-";

export interface PendingSession {
  // Synthetic identifier so the web layer can treat this like any other row.
  // Server-side, anything starting with `pending-` resolves directly to a
  // PID rather than going through the registered-session table.
  sessionId: string;
  pid: number;
  cwd: string;
  // We always have a pane for pending sessions — if it had no TMUX_PANE we'd
  // have no way to drive it, so we don't surface it.
  paneId: string;
  socket: string;
}

export function syntheticSessionId(pid: number): string {
  return `${SYNTHETIC_ID_PREFIX}${pid}`;
}

export function parseSyntheticSessionId(id: string): number | null {
  if (!id.startsWith(SYNTHETIC_ID_PREFIX)) return null;
  const pid = Number(id.slice(SYNTHETIC_ID_PREFIX.length));
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

// ---- runtime ----

async function readComm(pid: number): Promise<string | null> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/comm`, "utf8");
    return raw.trim();
  } catch {
    return null;
  }
}

async function readCwd(pid: number): Promise<string | null> {
  try {
    return await fs.readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

async function listClaudePids(): Promise<number[]> {
  let entries: string[];
  try {
    entries = await fs.readdir("/proc");
  } catch {
    return [];
  }
  const pids = entries
    .filter((e) => /^\d+$/.test(e))
    .map((e) => Number(e));
  const checks = await Promise.all(
    pids.map(async (pid) => ((await readComm(pid)) === "claude" ? pid : null)),
  );
  return checks.filter((p): p is number => p !== null);
}

function sessionFilePathForPid(pid: number): string {
  return path.join(os.homedir(), ".claude", "sessions", `${pid}.json`);
}

async function hasSessionFile(pid: number): Promise<boolean> {
  try {
    await fs.access(sessionFilePathForPid(pid));
    return true;
  } catch {
    return false;
  }
}

// Returns the claude processes that ARE running in a tmux pane but have NOT
// yet registered themselves with Claude Code's session-file mechanism. These
// are the ones still blocked on the trust dialog (or otherwise pre-init).
export async function listPendingSessions(): Promise<PendingSession[]> {
  const pids = await listClaudePids();
  const results = await Promise.all(
    pids.map(async (pid) => {
      if (await hasSessionFile(pid)) return null;
      const pane: TmuxPane | null = await resolveTmuxPaneForPid(pid);
      if (!pane) return null;
      const cwd = (await readCwd(pid)) ?? "";
      return {
        sessionId: syntheticSessionId(pid),
        pid,
        cwd,
        paneId: pane.paneId,
        socket: pane.socket,
      };
    }),
  );
  return results.filter((r): r is PendingSession => r !== null);
}
