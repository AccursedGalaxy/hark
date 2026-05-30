import { execFile } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AgentLifecycle, isHandoffReady } from "../../shared/protocol.js";

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

// The head's branch. One per orchestration, namespaced like the workers but
// with a fixed `head` leaf so it's obvious which ref is the coordinator's.
export function worktreeHeadBranch(orchSlug: string): string {
  return `hark/${slugify(orchSlug)}/head`;
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

// Decide how to base a new worktree, given whether the requested base is a real
// branch on origin. Pure so it's unit-testable without a real repo (the IO —
// the actual fetch / origin probe — happens in addWorktree).
//
// - HEAD / empty base, or no matching branch on origin: keep today's behavior —
//   branch off the LOCAL ref, no fetch. This preserves the local-only-WIP-base
//   and no-remote cases (no regression).
// - Otherwise: fetch that branch from origin and branch off the freshly-updated
//   remote-tracking ref, so workers fork the live remote tip, not a stale local.
export function resolveWorktreeBase(
  baseRef: string,
  originHasBase: boolean,
): { fetchRef: string | null; checkoutRef: string } {
  if (baseRef === "HEAD" || baseRef === "" || !originHasBase) {
    return { fetchRef: null, checkoutRef: baseRef };
  }
  return { fetchRef: baseRef, checkoutRef: `origin/${baseRef}` };
}

// Decide how to base a DEPENDENT (--depends-on) worker's worktree, given its
// upstream worker. Mirrors resolveWorktreeBase, but the fork point is the
// UPSTREAM's branch HEAD — not the orchestration base — so the dependent
// inherits the upstream's commits. The catch is timing: at spawn time the
// upstream usually hasn't produced those commits yet, so we branch lazily at
// HANDOFF time. Pure so the decision is unit-testable without a real repo (the
// orchestrator does the IO and the deferral bookkeeping).
//
// - upstream missing, or not yet handed off: NOT ready — the dependent stays
//   deferred (no worktree), to be materialized when the upstream finishes.
// - upstream handed off (review/done): ready — branch off the upstream's branch.
export function resolveDependentBase(
  upstream: { branch: string; lifecycle: AgentLifecycle } | undefined,
): { ready: boolean; baseRef: string | null } {
  if (!upstream || !isHandoffReady(upstream.lifecycle)) {
    return { ready: false, baseRef: null };
  }
  return { ready: true, baseRef: upstream.branch };
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

// `git -C <repo> diff [--stat] <base>...<branch>`. The three-dot form diffs
// the branch against the merge-base, so it shows only the branch's OWN changes
// (not unrelated commits that landed on base since) — exactly what the head
// wants when judging a worker's work. `full` emits the patch; otherwise --stat.
export function buildDiffArgs(
  repoRoot: string,
  baseRef: string,
  branch: string,
  full: boolean,
): string[] {
  const args = ["-C", repoRoot, "diff"];
  if (!full) args.push("--stat");
  args.push(`${baseRef}...${branch}`);
  return args;
}

// `git -C <repo> diff --shortstat <base>...<branch>` — the one-line summary
// formatShortstat compacts for the head notification / status view.
export function buildShortstatArgs(
  repoRoot: string,
  baseRef: string,
  branch: string,
): string[] {
  return ["-C", repoRoot, "diff", "--shortstat", `${baseRef}...${branch}`];
}

// `git -C <repo> rev-list --count <base>..<branch>` — commits on branch since
// base (two-dot: ahead-count, the natural "how many commits did this worker
// make" number).
export function buildRevListCountArgs(
  repoRoot: string,
  baseRef: string,
  branch: string,
): string[] {
  return ["-C", repoRoot, "rev-list", "--count", `${baseRef}..${branch}`];
}

// `git -C <repo> log --oneline -n 20 <base>..<branch>` — recent commits on the
// worker branch, compact.
export function buildLogArgs(
  repoRoot: string,
  baseRef: string,
  branch: string,
): string[] {
  return ["-C", repoRoot, "log", "--oneline", "-n", "20", `${baseRef}..${branch}`];
}

// Reduce `git diff --shortstat` output to a compact token like "2 files +30/-4".
// Returns "" when there were no changes (empty output).
export function formatShortstat(shortstat: string): string {
  const line = shortstat.trim();
  if (!line) return "";
  const files = /(\d+) files? changed/.exec(line)?.[1] ?? "0";
  const ins = /(\d+) insertions?\(\+\)/.exec(line)?.[1] ?? "0";
  const del = /(\d+) deletions?\(-\)/.exec(line)?.[1] ?? "0";
  const fileWord = files === "1" ? "file" : "files";
  return `${files} ${fileWord} +${ins}/-${del}`;
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

// Symlink the repo's installed dependencies into a fresh worktree so workers
// can actually build/typecheck/test their change. A new git worktree shares the
// repo's object store but NOT its `node_modules`, so without this every JS/TS
// worker fails its own verification (the dogfound `SKIP_TYPECHECK: no
// node_modules installed`). We symlink (instant, zero disk) rather than copy or
// reinstall, covering the root package and the `web/` workspace. Best-effort and
// idempotent: a subdir whose source is absent is skipped, an already-present
// target is left untouched, and any fs error is swallowed so it can never abort
// a spawn (the worker can still fall back to a manual install).
export function linkNodeModules(repoRoot: string, worktreeDir: string): void {
  for (const sub of ["", "web"]) {
    try {
      const source = path.join(repoRoot, sub, "node_modules");
      if (!existsSync(source)) continue;
      const target = path.join(worktreeDir, sub, "node_modules");
      if (existsSync(target)) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(source, target, "dir");
    } catch {
      /* best-effort — a missing/locked dir must not break the spawn */
    }
  }
}

export async function addWorktree(opts: {
  repoRoot: string;
  worktreeDir: string;
  branch: string;
  baseRef?: string;
}): Promise<void> {
  const baseRef = opts.baseRef ?? "HEAD";
  // Fork the LIVE remote tip, not a stale local ref: when the base is a real
  // branch on origin, fetch it first and branch off `origin/<base>`. Falls back
  // to the local ref for HEAD, local-only WIP bases, and no-remote repos.
  const originHasBase =
    baseRef !== "HEAD" &&
    baseRef !== "" &&
    (await hasOrigin(opts.repoRoot)) &&
    (await baseOnOrigin(opts.repoRoot, baseRef));
  const resolved = resolveWorktreeBase(baseRef, originHasBase);
  let checkoutRef = resolved.checkoutRef;
  if (resolved.fetchRef) {
    try {
      await runGit(["-C", opts.repoRoot, "fetch", "origin", resolved.fetchRef]);
    } catch {
      // Best-effort, like linkNodeModules: a failed fetch (offline, auth, etc.)
      // must not abort the spawn — branch off the local ref instead.
      checkoutRef = baseRef;
    }
  }
  await runGit(
    buildWorktreeAddArgs(
      opts.repoRoot,
      opts.worktreeDir,
      opts.branch,
      checkoutRef,
    ),
  );
  linkNodeModules(opts.repoRoot, opts.worktreeDir);
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

// The branch currently checked out in a repo (the PM-head's base — workers
// branch off it). Returns "HEAD" on a detached head or any failure, so a
// promotion never breaks on an unusual git state.
export async function currentBranch(repoRoot: string): Promise<string> {
  try {
    const out = await runGit(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
    const b = out.trim();
    return b.length > 0 ? b : "HEAD";
  } catch {
    return "HEAD";
  }
}

// Whether the repo has an `origin` remote — the precondition for opening a PR
// (Sharp Edge 7). False on any failure (no remote / not a repo).
export async function hasOrigin(repoRoot: string): Promise<boolean> {
  try {
    const out = await runGit(["-C", repoRoot, "remote", "get-url", "origin"]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Whether a base ref exists on origin — a PR target must be a real remote
// branch. `git ls-remote --heads origin <base>` prints a line per match, so
// empty stdout means the base (often a local-only WIP branch) was never pushed.
// False on any failure, so the caller degrades to the ready-branch handoff.
export async function baseOnOrigin(
  repoRoot: string,
  baseRef: string,
): Promise<boolean> {
  try {
    const out = await runGit(["-C", repoRoot, "ls-remote", "--heads", "origin", baseRef]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Push a branch to origin with upstream tracking. Throws on failure (the caller
// reports it) — no checkout happens, so the project root tree is never touched.
export async function pushBranch(
  repoRoot: string,
  branch: string,
): Promise<void> {
  await runGit(["-C", repoRoot, "push", "-u", "origin", branch]);
}

// Worker branch vs base, as text. `full` returns the patch; otherwise --stat.
// Used by the `hark agent diff` endpoint.
export async function diffBranch(opts: {
  repoRoot: string;
  baseRef: string;
  branch: string;
  full?: boolean;
}): Promise<string> {
  return runGit(
    buildDiffArgs(opts.repoRoot, opts.baseRef, opts.branch, opts.full ?? false),
  );
}

// Recent commits on the worker branch (compact). Used by `hark agent log`.
export async function logBranch(opts: {
  repoRoot: string;
  baseRef: string;
  branch: string;
}): Promise<string> {
  return runGit(buildLogArgs(opts.repoRoot, opts.baseRef, opts.branch));
}

// Compact diffstat + commit count for a worker branch — the figures that go
// into `hark orch status` and the worker→head notification. Best-effort: a
// branch with no commits / a bad ref yields { diffstat: "", commitCount: 0 }.
export async function branchGitSummary(opts: {
  repoRoot: string;
  baseRef: string;
  branch: string;
}): Promise<{ diffstat: string; commitCount: number }> {
  let diffstat = "";
  let commitCount = 0;
  try {
    const ss = await runGit(
      buildShortstatArgs(opts.repoRoot, opts.baseRef, opts.branch),
    );
    diffstat = formatShortstat(ss);
  } catch {
    /* no diff / bad ref — leave empty */
  }
  try {
    const out = await runGit(
      buildRevListCountArgs(opts.repoRoot, opts.baseRef, opts.branch),
    );
    const n = Number(out.trim());
    if (Number.isFinite(n)) commitCount = n;
  } catch {
    /* leave 0 */
  }
  return { diffstat, commitCount };
}
