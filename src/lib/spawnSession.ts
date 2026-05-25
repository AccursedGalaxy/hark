import { execFile } from "node:child_process";
import os from "node:os";

// Pure argv builders for the two tmux invocations we use. Kept separate from
// the runner so the shape is easy to test without spawning processes.

export interface SpawnInput {
  sessionName: string;
  cwd: string;
  command: string;
}

// Build a shell-command that runs `claude` inside the user's login +
// interactive shell so PATH from .zshrc / .bashrc is in effect. The pane
// IS interactive (it's a TUI), so `-i` is correct here; without it, zsh
// users whose PATH additions live in .zshrc (the common case) end up with
// only `.zprofile`'s PATH and `claude` isn't found, causing the window
// to auto-close on spawn.
export function buildLoginShellCommand(
  claudeCommand: string,
  shell: string,
): string {
  // Single-quote the inner command and escape any embedded single quotes:
  // ' → '\''. Keeps complex commands (e.g., `claude --resume <id>`) safe.
  const escaped = claudeCommand.replace(/'/g, "'\\''");
  return `exec ${shell} -ilc 'exec ${escaped}'`;
}

// -P -F '#{pane_pid}' makes tmux print the PID of the new pane's process,
// which is the shell that immediately exec's into claude — same PID
// throughout the exec chain (sh → user shell → claude). The client uses
// this to find and focus the corresponding pending session row as soon as
// it appears in the rail.
export function buildNewWindowArgs(input: SpawnInput): string[] {
  return [
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{pane_pid}",
    "-t",
    input.sessionName,
    "-c",
    input.cwd,
    input.command,
  ];
}

export function buildNewSessionArgs(input: SpawnInput): string[] {
  return [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_pid}",
    "-s",
    input.sessionName,
    "-c",
    input.cwd,
    input.command,
  ];
}

export function parsePanePid(stdout: string): number | null {
  const line = stdout.split("\n").map((s) => s.trim()).find((s) => s.length > 0);
  if (!line) return null;
  const n = Number(line);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// One row from `tmux list-sessions -F '#{session_attached} #{session_activity} #{session_name}'`.
export interface TmuxSessionRow {
  name: string;
  attached: number;
  activity: number;
}

export function parseSessionRows(stdout: string): TmuxSessionRow[] {
  const rows: TmuxSessionRow[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // `attached activity name` — name is the rest of the line because tmux
    // session names can contain spaces, though it's rare.
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const attached = Number(parts[0]);
    const activity = Number(parts[1]);
    const name = parts.slice(2).join(" ");
    if (!Number.isFinite(attached) || !Number.isFinite(activity)) continue;
    rows.push({ name, attached, activity });
  }
  return rows;
}

// Pick the best existing tmux session to drop a new window into:
//   1. attached sessions ranked by most recent activity
//   2. otherwise the most-recently-active unattached session
// Returns null when there are no sessions at all (caller should new-session).
export function pickSpawnTarget(
  rows: TmuxSessionRow[],
): TmuxSessionRow | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    if (a.attached !== b.attached) return b.attached - a.attached;
    return b.activity - a.activity;
  });
  return sorted[0] ?? null;
}

// ---- runtime ----

function runWithStdout(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function listSessions(): Promise<TmuxSessionRow[]> {
  try {
    const out = await runWithStdout([
      "list-sessions",
      "-F",
      "#{session_attached} #{session_activity} #{session_name}",
    ]);
    return parseSessionRows(out);
  } catch {
    return [];
  }
}

export interface SpawnResult {
  sessionName: string;
  createdSession: boolean;
  // PID of the new pane's process. Stays the same across the exec chain
  // (sh → user shell → claude), so the client can match it against
  // pending/registered session rows to focus the new session.
  pid: number | null;
}

// Spawn a new Claude window. Prefers the user's current tmux focus: pick the
// most-recently-attached existing session and add a window there. If there's
// no tmux server at all, fall back to creating a dedicated "claude" session.
export async function spawnClaudeSession(opts: {
  cwd: string;
  command?: string;
}): Promise<SpawnResult> {
  const userShell = os.userInfo().shell || "/bin/sh";
  const inner = opts.command ?? "claude";
  const command = buildLoginShellCommand(inner, userShell);
  const sessions = await listSessions();
  const target = pickSpawnTarget(sessions);

  if (target) {
    const stdout = await runWithStdout(
      buildNewWindowArgs({
        sessionName: target.name,
        cwd: opts.cwd,
        command,
      }),
    );
    return {
      sessionName: target.name,
      createdSession: false,
      pid: parsePanePid(stdout),
    };
  }

  const stdout = await runWithStdout(
    buildNewSessionArgs({
      sessionName: "claude",
      cwd: opts.cwd,
      command,
    }),
  );
  return {
    sessionName: "claude",
    createdSession: true,
    pid: parsePanePid(stdout),
  };
}
