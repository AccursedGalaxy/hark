import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  linkNodeModules,
  branchGitSummary,
  buildBranchDeleteArgs,
  buildDiffArgs,
  buildLogArgs,
  buildRevListCountArgs,
  buildShortstatArgs,
  diffBranch,
  buildWorktreeAddArgs,
  buildWorktreeListArgs,
  buildWorktreePruneArgs,
  buildWorktreeRemoveArgs,
  formatShortstat,
  parseWorktreeList,
  resolveWorktreeBase,
  slugify,
  worktreeBranchName,
  worktreeHeadBranch,
  worktreePath,
} from "./worktree.js";

describe("linkNodeModules", () => {
  let root: string;
  let repoRoot: string;
  let worktreeDir: string;

  function setup(): void {
    root = mkdtempSync(join(tmpdir(), "hark-nm-"));
    repoRoot = join(root, "repo");
    worktreeDir = join(root, "wt");
    // A worktree git would have already checked out; node_modules is the only
    // thing missing. web/ is tracked, so its dir exists in the checkout.
    mkdirSync(worktreeDir, { recursive: true });
    mkdirSync(join(worktreeDir, "web"), { recursive: true });
  }

  function cleanup(): void {
    rmSync(root, { recursive: true, force: true });
  }

  it("symlinks the root node_modules into the worktree", () => {
    setup();
    try {
      mkdirSync(join(repoRoot, "node_modules", "left-pad"), { recursive: true });
      writeFileSync(join(repoRoot, "node_modules", "left-pad", "index.js"), "1\n");

      linkNodeModules(repoRoot, worktreeDir);

      const link = join(worktreeDir, "node_modules");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(repoRoot, "node_modules")));
      expect(existsSync(join(link, "left-pad", "index.js"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("symlinks web/node_modules when the source exists", () => {
    setup();
    try {
      mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
      mkdirSync(join(repoRoot, "web", "node_modules", "react"), { recursive: true });

      linkNodeModules(repoRoot, worktreeDir);

      const link = join(worktreeDir, "web", "node_modules");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(
        realpathSync(join(repoRoot, "web", "node_modules")),
      );
    } finally {
      cleanup();
    }
  });

  it("skips web/node_modules when its source is absent", () => {
    setup();
    try {
      mkdirSync(join(repoRoot, "node_modules"), { recursive: true });

      linkNodeModules(repoRoot, worktreeDir);

      expect(existsSync(join(worktreeDir, "web", "node_modules"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("is a no-op when the repo has no node_modules at all", () => {
    setup();
    try {
      mkdirSync(repoRoot, { recursive: true });
      expect(() => linkNodeModules(repoRoot, worktreeDir)).not.toThrow();
      expect(existsSync(join(worktreeDir, "node_modules"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("leaves an already-present target untouched (idempotent)", () => {
    setup();
    try {
      mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
      // Pre-existing real dir at the target — must not be replaced by a link.
      mkdirSync(join(worktreeDir, "node_modules"), { recursive: true });

      linkNodeModules(repoRoot, worktreeDir);
      linkNodeModules(repoRoot, worktreeDir);

      expect(lstatSync(join(worktreeDir, "node_modules")).isSymbolicLink()).toBe(
        false,
      );
    } finally {
      cleanup();
    }
  });
});

describe("resolveWorktreeBase", () => {
  it("branches off HEAD without fetching", () => {
    expect(resolveWorktreeBase("HEAD", false)).toEqual({
      fetchRef: null,
      checkoutRef: "HEAD",
    });
  });

  it("branches off the local ref (no fetch) when the base is not on origin", () => {
    expect(resolveWorktreeBase("main", false)).toEqual({
      fetchRef: null,
      checkoutRef: "main",
    });
  });

  it("fetches and branches off origin/<base> when the base is on origin", () => {
    expect(resolveWorktreeBase("main", true)).toEqual({
      fetchRef: "main",
      checkoutRef: "origin/main",
    });
  });
});

describe("slugify", () => {
  it("reduces text to a ref/path-safe token", () => {
    expect(slugify("My Cool Project!")).toBe("my-cool-project");
    expect(slugify("feature/Foo  Bar")).toBe("feature-foo-bar");
    expect(slugify("--Edge--Case--")).toBe("edge-case");
  });

  it("never returns empty (git refuses empty ref segments)", () => {
    expect(slugify("")).toBe("x");
    expect(slugify("!!!")).toBe("x");
  });
});

describe("worktreeHeadBranch", () => {
  it("namespaces the head branch under the orch with a fixed head leaf", () => {
    expect(worktreeHeadBranch("Ship Login")).toBe("hark/ship-login/head");
  });
});

describe("git inspection builders (head reads worker branches vs base)", () => {
  it("builds a three-dot diff so it shows only the branch's own changes", () => {
    expect(buildDiffArgs("/repo", "main", "hark/o/coder-a", false)).toEqual([
      "-C",
      "/repo",
      "diff",
      "--stat",
      "main...hark/o/coder-a",
    ]);
    // --full drops --stat to emit the full patch.
    expect(buildDiffArgs("/repo", "main", "hark/o/coder-a", true)).toEqual([
      "-C",
      "/repo",
      "diff",
      "main...hark/o/coder-a",
    ]);
  });

  it("builds a shortstat diff and a commit-count rev-list", () => {
    expect(buildShortstatArgs("/repo", "main", "br")).toEqual([
      "-C",
      "/repo",
      "diff",
      "--shortstat",
      "main...br",
    ]);
    expect(buildRevListCountArgs("/repo", "main", "br")).toEqual([
      "-C",
      "/repo",
      "rev-list",
      "--count",
      "main..br",
    ]);
  });

  it("builds a compact one-line-per-commit log", () => {
    expect(buildLogArgs("/repo", "main", "br")).toEqual([
      "-C",
      "/repo",
      "log",
      "--oneline",
      "-n",
      "20",
      "main..br",
    ]);
  });
});

// End-to-end regression guard against the diff-inflation bug: when the base ref
// has advanced AHEAD of the worker's fork point, the worker's diff must show
// ONLY the worker's own changes — never the base's own commits. The three-dot
// `base...branch` form (a merge-base diff) does this; a two-dot `base..branch`
// would inflate the diff with the base's commits. This locks both the
// `hark agent diff` path (diffBranch) and the `hark pr` diffstat path
// (branchGitSummary) against a regression to the two-dot form.
describe("diff against an advanced base shows only the worker's own changes", () => {
  let root: string;
  let repo: string;

  function git(args: string[]): void {
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  }

  function setup(): void {
    root = mkdtempSync(join(tmpdir(), "hark-diff-"));
    repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    // Deterministic base branch name regardless of the host's init.defaultBranch.
    git(["symbolic-ref", "HEAD", "refs/heads/base"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    git(["config", "commit.gpgsign", "false"]);

    // Fork point.
    writeFileSync(join(repo, "shared.txt"), "0\n");
    git(["add", "."]);
    git(["commit", "-qm", "c0"]);
    git(["branch", "worker"]);

    // Base advances with its OWN commits after the fork — these must NOT appear
    // in the worker's diff.
    writeFileSync(join(repo, "base-only.txt"), "a\n");
    git(["add", "."]);
    git(["commit", "-qm", "base ahead 1"]);
    writeFileSync(join(repo, "base-only.txt"), "a\nb\n");
    git(["commit", "-q", "-a", "-m", "base ahead 2"]);

    // The worker makes its own single change on its branch.
    git(["checkout", "-q", "worker"]);
    writeFileSync(join(repo, "worker.txt"), "w\n");
    git(["add", "."]);
    git(["commit", "-qm", "worker commit"]);
  }

  function cleanup(): void {
    rmSync(root, { recursive: true, force: true });
  }

  it("diffBranch --stat shows worker.txt but not the base's own commits", async () => {
    setup();
    try {
      const stat = await diffBranch({
        repoRoot: repo,
        baseRef: "base",
        branch: "worker",
        full: false,
      });
      expect(stat).toContain("worker.txt");
      expect(stat).not.toContain("base-only.txt");
    } finally {
      cleanup();
    }
  });

  it("diffBranch --full patches worker.txt but not the base's own commits", async () => {
    setup();
    try {
      const full = await diffBranch({
        repoRoot: repo,
        baseRef: "base",
        branch: "worker",
        full: true,
      });
      expect(full).toContain("worker.txt");
      expect(full).toContain("+w");
      expect(full).not.toContain("base-only.txt");
    } finally {
      cleanup();
    }
  });

  it("branchGitSummary counts only the worker's commit and diffstat", async () => {
    setup();
    try {
      const summary = await branchGitSummary({
        repoRoot: repo,
        baseRef: "base",
        branch: "worker",
      });
      // One worker commit — NOT the two base-ahead commits.
      expect(summary.commitCount).toBe(1);
      expect(summary.diffstat).toBe("1 file +1/-0");
    } finally {
      cleanup();
    }
  });
});

// Regression guard for the stale-local-base bug: workers fork off `origin/<base>`
// (the #18 base-drift fix), but the diff readers measured against the LOCAL base.
// When local `main` lags `origin/main`, the three-dot merge-base falls behind the
// worker's true fork point, so the diff surfaces commits the worker never made.
// The fix fetches and measures against `origin/<base>`. This sets up exactly that
// skew — local base behind origin, worker forked off the fresh origin tip — and
// asserts the diff shows ONLY the worker's own change.
describe("diff against a stale local base shows only the worker's own changes", () => {
  let root: string;
  let origin: string;
  let repo: string;

  function git(args: string[]): void {
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  }

  function setup(): void {
    root = mkdtempSync(join(tmpdir(), "hark-stale-"));
    origin = join(root, "origin.git");
    repo = join(root, "repo");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    execFileSync("git", ["init", "-q", repo]);
    git(["symbolic-ref", "HEAD", "refs/heads/base"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["remote", "add", "origin", origin]);

    // Fork point — c0, pushed so origin/base and local base agree here.
    writeFileSync(join(repo, "shared.txt"), "0\n");
    git(["add", "."]);
    git(["commit", "-qm", "c0"]);
    git(["push", "-q", "origin", "base"]);

    // Origin advances with its OWN commits, then local base is rewound to c0 so
    // it LAGS origin/base by two commits. These drift commits are NOT the
    // worker's — they must never appear in its diff.
    writeFileSync(join(repo, "drift1.txt"), "a\n");
    git(["add", "."]);
    git(["commit", "-qm", "origin ahead 1"]);
    writeFileSync(join(repo, "drift2.txt"), "b\n");
    git(["add", "."]);
    git(["commit", "-qm", "origin ahead 2"]);
    git(["push", "-q", "origin", "base"]);
    git(["reset", "-q", "--hard", "HEAD~2"]); // local base back to c0 (stale)

    // Worker forks off the FRESH origin tip (as addWorktree does) and makes its
    // own single change.
    git(["branch", "worker", "origin/base"]);
    git(["checkout", "-q", "worker"]);
    writeFileSync(join(repo, "worker.txt"), "w\n");
    git(["add", "."]);
    git(["commit", "-qm", "worker commit"]);
  }

  function cleanup(): void {
    rmSync(root, { recursive: true, force: true });
  }

  it("diffBranch --stat shows worker.txt but not the origin drift commits", async () => {
    setup();
    try {
      const stat = await diffBranch({
        repoRoot: repo,
        baseRef: "base",
        branch: "worker",
        full: false,
      });
      expect(stat).toContain("worker.txt");
      expect(stat).not.toContain("drift1.txt");
      expect(stat).not.toContain("drift2.txt");
    } finally {
      cleanup();
    }
  });

  it("branchGitSummary counts only the worker's commit, not the drift", async () => {
    setup();
    try {
      const summary = await branchGitSummary({
        repoRoot: repo,
        baseRef: "base",
        branch: "worker",
      });
      expect(summary.commitCount).toBe(1);
      expect(summary.diffstat).toBe("1 file +1/-0");
    } finally {
      cleanup();
    }
  });
});

describe("formatShortstat", () => {
  it("reduces git --shortstat output to a compact token", () => {
    expect(
      formatShortstat(" 2 files changed, 30 insertions(+), 4 deletions(-)\n"),
    ).toBe("2 files +30/-4");
    expect(formatShortstat(" 1 file changed, 5 insertions(+)\n")).toBe(
      "1 file +5/-0",
    );
    expect(formatShortstat(" 1 file changed, 3 deletions(-)\n")).toBe(
      "1 file +0/-3",
    );
  });

  it("returns empty string when there are no changes", () => {
    expect(formatShortstat("")).toBe("");
    expect(formatShortstat("\n")).toBe("");
  });
});

describe("worktreePath", () => {
  it("groups by project then orchestration then agent", () => {
    expect(worktreePath("/base", "Hark App", "orch-7", "coder-1")).toBe(
      "/base/hark-app/orch-7/coder-1",
    );
  });
});

describe("worktreeBranchName", () => {
  it("namespaces under hark/ with role and short agent id", () => {
    expect(worktreeBranchName("Ship Login", "Coder", "a1b2")).toBe(
      "hark/ship-login/coder-a1b2",
    );
  });

  it("sanitizes every segment so the ref is always valid", () => {
    const b = worktreeBranchName("a b/c", "Re:viewer", "x y");
    expect(b).toBe("hark/a-b-c/re-viewer-x-y");
    // No characters git forbids in a ref.
    expect(b).not.toMatch(/[ ~^:?*[\\]/);
  });
});

describe("buildWorktreeAddArgs", () => {
  it("creates a new branch checked out into a directory off a base ref", () => {
    expect(
      buildWorktreeAddArgs("/repo", "/wt/coder", "hark/x/coder-1", "main"),
    ).toEqual([
      "-C",
      "/repo",
      "worktree",
      "add",
      "-b",
      "hark/x/coder-1",
      "/wt/coder",
      "main",
    ]);
  });
});

describe("buildWorktreeRemoveArgs", () => {
  it("omits --force when not forced", () => {
    expect(buildWorktreeRemoveArgs("/repo", "/wt/coder", false)).toEqual([
      "-C",
      "/repo",
      "worktree",
      "remove",
      "/wt/coder",
    ]);
  });

  it("includes --force when forced", () => {
    expect(buildWorktreeRemoveArgs("/repo", "/wt/coder", true)).toEqual([
      "-C",
      "/repo",
      "worktree",
      "remove",
      "--force",
      "/wt/coder",
    ]);
  });
});

describe("buildWorktreeListArgs / buildWorktreePruneArgs", () => {
  it("build the porcelain list and prune invocations", () => {
    expect(buildWorktreeListArgs("/repo")).toEqual([
      "-C",
      "/repo",
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(buildWorktreePruneArgs("/repo")).toEqual([
      "-C",
      "/repo",
      "worktree",
      "prune",
    ]);
  });
});

describe("buildBranchDeleteArgs", () => {
  it("uses -d normally and -D when forced", () => {
    expect(buildBranchDeleteArgs("/repo", "hark/x/coder-1", false)).toEqual([
      "-C",
      "/repo",
      "branch",
      "-d",
      "hark/x/coder-1",
    ]);
    expect(buildBranchDeleteArgs("/repo", "hark/x/coder-1", true)).toEqual([
      "-C",
      "/repo",
      "branch",
      "-D",
      "hark/x/coder-1",
    ]);
  });
});

describe("parseWorktreeList", () => {
  it("parses multiple porcelain records with branch/detached/flags", () => {
    const porcelain = [
      "worktree /home/u/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /home/u/.hark/worktrees/proj/orch-1/coder-1",
      "HEAD def456",
      "branch refs/heads/hark/proj/coder-1",
      "",
      "worktree /home/u/.hark/worktrees/proj/orch-1/tester-1",
      "HEAD 789aaa",
      "detached",
      "locked",
      "",
    ].join("\n");

    const entries = parseWorktreeList(porcelain);
    expect(entries).toHaveLength(3);

    expect(entries[0]).toMatchObject({
      path: "/home/u/repo",
      head: "abc123",
      branch: "main",
    });
    expect(entries[1].branch).toBe("hark/proj/coder-1");
    expect(entries[2]).toMatchObject({
      path: "/home/u/.hark/worktrees/proj/orch-1/tester-1",
      detached: true,
      locked: true,
    });
    expect(entries[2].branch).toBeUndefined();
  });

  it("handles a trailing record with no final blank line", () => {
    const porcelain = "worktree /repo\nHEAD abc\nbranch refs/heads/main";
    const entries = parseWorktreeList(porcelain);
    expect(entries).toHaveLength(1);
    expect(entries[0].branch).toBe("main");
  });

  it("returns [] for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});
