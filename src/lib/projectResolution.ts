import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ProjectInfo } from "../shared/protocol.js";

const execFile = promisify(execFileCb);

export interface ResolveDeps {
  // Run `git rev-parse --show-toplevel` in `cwd`. Returns the trimmed stdout
  // (an absolute path) on success, or null if the command fails / cwd is not
  // inside a repo. Injected for testability — defaults to a real execFile.
  gitTopLevel: (cwd: string) => Promise<string | null>;
}

async function realGitTopLevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // cwd isn't a repo, git not installed, or cwd doesn't exist.
    return null;
  }
}

export const defaultDeps: ResolveDeps = {
  gitTopLevel: realGitTopLevel,
};

export async function resolveProjectFromCwd(
  cwd: string,
  deps: ResolveDeps = defaultDeps,
): Promise<ProjectInfo | null> {
  const root = await deps.gitTopLevel(cwd);
  if (!root) return null;
  // path.basename strips a trailing slash, so "/tmp/myproj/" → "myproj".
  const name = path.basename(root);
  if (!name) return null;
  return {
    key: root,
    root,
    name,
    planExists: false,
    planMtime: null,
  };
}
