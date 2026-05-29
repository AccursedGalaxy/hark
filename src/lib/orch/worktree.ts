import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Isolated git worktrees are how orchestration keeps N agents working the same
// repo without stepping on each other: each agent gets its own branch checked
// out into its own directory, so file edits, staged changes, and `git status`
// are fully independent. The main session's working tree is never touched.
//
// As with the rest of hark, the IO-free argv builders and parsers live up top
// so they're unit-testable without a real repo; the thin runtime wrappers at
// the bottom shell out to `git`.

// ---- Naming -----------------------------------------------------------------

// Reduce arbitrary text to a token that's safe in a git ref AND a path
// segment: lowercase, ASCII alnum + dash, collapsed, trimmed. Git ref rules
// forbid spaces, `~^:?*[\`, `..`, leading/trailing slashes, and `@{`; staying
// inside `[a-z0-9-]` sidesteps all of them.
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s.length > 0 ? s : "x";
}

// Where all orchestration worktrees live, outside any repo's own working tree
// so they never show up in the parent's `git status` or get committed by
// accident. Overridable for tests / unusual setups via HARK_WORKTREE_DIR.
export function worktreeBaseDir(): string {
  return (
    process.env.HARK_WORKTREE_DIR ||
    path.join(os.homedir(), ".hark", "worktrees")
  );
}

// Deterministic worktree directory for one agent. Grouped by project then
// orchestration so a `tree ~/.hark/worktrees` reads like the org chart, and a
// whole orchestration's worktrees can be removed as a unit.
export function worktreePath(
  baseDir: string,
  projectName: string,
  orchId: string,
  agentId: string,
): string {
  return path.join(baseDir, slugify(projectName), orchId, agentId);
}

// Branch an agent commits onto. Namespaced under `hark/` so it's obvious in
// `git branch` which refs are orchestration-owned and safe to prune. The short
// agent id keeps two same-role agents in one orchestration from colliding.
export function worktreeBranchName(
  orchSlug: string,
  role: string,
  agentShortId: string,
): string {
  return `hark/${slugify(orchSlug)}/${slugify(role)}-${slugify(agentShortId)}`;
}

// ---- Pure argv builders -----------------------------------------------------

// `git -C <repoRoot> worktree add -b <branch> <path> <baseRef>` — create a new
// branch off baseRef and check it out into a fresh directory. baseRef defaults
// to HEAD at the call site.
export function buildWorktreeAddArgs(
  repoRoot: string,
  worktreeDir: string,
  branch: string,
  baseRef: string,
): string[] {
  return [
    "-C",
    repoRoot,
    "worktree",
    "add",
    "-b",
    branch,
    worktreeDir,
    baseRef,
  ];
}

// `git -C <repoRoot> worktree remove [--force] <path>`. Force is needed when
// the worktree has uncommitted changes — callers decide whether that's
// acceptable (usually: keep the branch, discard the throwaway checkout).
export function buildWorktreeRemoveArgs(
  repoRoot: string,
  worktreeDir: string,
  force: boolean,
): string[] {
  const args = ["-C", repoRoot, "worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreeDir);
  return args;
}

export function buildWorktreeListArgs(repoRoot: string): string[] {
  return ["-C", repoRoot, "worktree", "list", "--porcelain"];
}

// Drop administrative files for worktrees whose directories were deleted out
// from under git (e.g. a manual `rm -rf`). Cheap and idempotent.
export function buildWorktreePruneArgs(repoRoot: string): string[] {
  return ["-C", repoRoot, "worktree", "prune"];
}

export function buildBranchDeleteArgs(
  repoRoot: string,
  branch: string,
  force: boolean,
): string[] {
  return ["-C", repoRoot, "branch", force ? "-D" : "-d", branch];
}

// ---- Parsing ----------------------------------------------------------------

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

// Parse `git worktree list --porcelain`. Records are separated by a blank
// line; each line is either `key value` or a bare flag keyword. `branch` comes
// as a full ref (`refs/heads/foo`) which we trim to the short name.
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  for (const raw of porcelain.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      flush();
      cur = {
        path: value,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!cur) continue;
    switch (key) {
      case "HEAD":
        cur.head = value;
        break;
      case "branch":
        cur.branch = value.replace(/^refs\/heads\//, "");
        break;
      case "bare":
        cur.bare = true;
        break;
      case "detached":
        cur.detached = true;
        break;
      case "locked":
        cur.locked = true;
        break;
      case "prunable":
        cur.prunable = true;
        break;
    }
  }
  flush();
  return out;
}

// ---- Errors -----------------------------------------------------------------

export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly argv: string[],
    readonly stderr: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorktreeError";
  }
}

// ---- Runtime ----------------------------------------------------------------

const GIT_TIMEOUT_MS = 30000;

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new WorktreeError(
              `git ${args.slice(0, 4).join(" ")} failed: ${
                (stderr ?? "").trim() || err.message
              }`,
              args,
              stderr ?? "",
              { cause: err },
            ),
          );
        } else {
          resolve(stdout ?? "");
        }
      },
    );
  });
}

export async function addWorktree(opts: {
  repoRoot: string;
  worktreeDir: string;
  branch: string;
  baseRef?: string;
}): Promise<void> {
  await runGit(
    buildWorktreeAddArgs(
      opts.repoRoot,
      opts.worktreeDir,
      opts.branch,
      opts.baseRef ?? "HEAD",
    ),
  );
}

export async function removeWorktree(opts: {
  repoRoot: string;
  worktreeDir: string;
  force?: boolean;
}): Promise<void> {
  await runGit(
    buildWorktreeRemoveArgs(opts.repoRoot, opts.worktreeDir, opts.force ?? true),
  );
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const out = await runGit(buildWorktreeListArgs(repoRoot));
  return parseWorktreeList(out);
}

export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await runGit(buildWorktreePruneArgs(repoRoot));
}

export async function deleteBranch(opts: {
  repoRoot: string;
  branch: string;
  force?: boolean;
}): Promise<void> {
  await runGit(
    buildBranchDeleteArgs(opts.repoRoot, opts.branch, opts.force ?? false),
  );
}
