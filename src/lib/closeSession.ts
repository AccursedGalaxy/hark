import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Default grace period between SIGTERM and the SIGKILL fallback. Claude Code
// flushes its session JSONL and clears `~/.claude/sessions/<pid>.json` on a
// clean exit, so we want to give it real time to do that before forcing.
const DEFAULT_GRACE_MS = 1500;

export interface CloseSessionDeps {
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isAlive: (pid: number) => boolean;
  delay: (ms: number) => Promise<void>;
  removeFile: (filePath: string) => Promise<void>;
}

export interface CloseSessionResult {
  signaled: boolean;
  escalated: boolean;
  fileRemoved: boolean;
}

// Tear down a Claude session by terminating its process. We do a polite
// SIGTERM first (lets Claude flush state + remove its own session file),
// then escalate to SIGKILL if it's still around after `graceMs`. The
// session file is removed at the end as belt-and-suspenders in case the
// process died without cleaning up — `listLiveSessions` already filters
// by `kill(pid, 0)` but a stale file is wasted I/O on every poll.
export async function closeSession(
  pid: number,
  sessionFilePath: string | null,
  deps: CloseSessionDeps,
  graceMs = DEFAULT_GRACE_MS,
): Promise<CloseSessionResult> {
  let signaled = false;
  let escalated = false;

  if (deps.isAlive(pid)) {
    try {
      deps.kill(pid, "SIGTERM");
      signaled = true;
    } catch {
      /* already gone — fall through */
    }
  }

  if (signaled && deps.isAlive(pid)) {
    await deps.delay(graceMs);
    if (deps.isAlive(pid)) {
      try {
        deps.kill(pid, "SIGKILL");
        escalated = true;
      } catch {
        /* gone in the window — that's fine */
      }
    }
  }

  let fileRemoved = false;
  if (sessionFilePath) {
    try {
      await deps.removeFile(sessionFilePath);
      fileRemoved = true;
    } catch {
      /* may have been cleaned up already */
    }
  }

  return { signaled, escalated, fileRemoved };
}

// ---- runtime adapters ----

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const defaultDeps: CloseSessionDeps = {
  kill: (pid, signal) => process.kill(pid, signal),
  isAlive: isPidAlive,
  delay,
  removeFile: (p) => fs.rm(p, { force: true }),
};

export function sessionFilePathForPid(pid: number): string {
  return path.join(os.homedir(), ".claude", "sessions", `${pid}.json`);
}

// Optionally try to kill the tmux window the session lives in. Best-effort:
// if Claude has already exited the window may also be gone. We don't surface
// errors — the SIGTERM above is the source of truth.
export function killTmuxWindow(
  socket: string,
  paneId: string,
): Promise<void> {
  return new Promise((resolve) => {
    execFile("tmux", ["-S", socket, "kill-window", "-t", paneId], () =>
      resolve(),
    );
  });
}
