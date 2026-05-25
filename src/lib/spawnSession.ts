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

async function listSessionNames(): Promise<string[]> {
  try {
    const out = await runWithStdout(["list-sessions", "-F", "#{session_name}"]);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export interface SpawnResult {
  sessionName: string;
  createdSession: boolean;
}

// Spawn a new Claude window. To avoid polluting unrelated tmux sessions
// (e.g. "Work", "dev"), we keep our windows inside a dedicated "claude"
// session. If it exists, add a window; otherwise create the session.
export async function spawnClaudeSession(opts: {
  cwd: string;
  command?: string;
}): Promise<SpawnResult> {
  const command = opts.command ?? "claude";
  const sessions = await listSessionNames();

  if (sessions.includes("claude")) {
    await run(
      buildNewWindowArgs({
        sessionName: "claude",
        cwd: opts.cwd,
        command,
      }),
    );
    return { sessionName: "claude", createdSession: false };
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
