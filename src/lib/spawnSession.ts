import { execFile } from "node:child_process";

// Pure argv builders for the two tmux invocations we use. Kept separate from
// the runner so the shape is easy to test without spawning processes.

export interface SpawnInput {
  sessionName: string;
  cwd: string;
  command: string;
}

export function buildNewWindowArgs(input: SpawnInput): string[] {
  return [
    "new-window",
    "-d",
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
    "-s",
    input.sessionName,
    "-c",
    input.cwd,
    input.command,
  ];
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

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

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
}

// Spawn a new Claude window. Prefers the user's current tmux focus: pick the
// most-recently-attached existing session and add a window there. If there's
// no tmux server at all, fall back to creating a dedicated "claude" session.
export async function spawnClaudeSession(opts: {
  cwd: string;
  command?: string;
}): Promise<SpawnResult> {
  const command = opts.command ?? "claude";
  const sessions = await listSessions();
  const target = pickSpawnTarget(sessions);

  if (target) {
    await run(
      buildNewWindowArgs({
        sessionName: target.name,
        cwd: opts.cwd,
        command,
      }),
    );
    return { sessionName: target.name, createdSession: false };
  }

  await run(
    buildNewSessionArgs({
      sessionName: "claude",
      cwd: opts.cwd,
      command,
    }),
  );
  return { sessionName: "claude", createdSession: true };
}
