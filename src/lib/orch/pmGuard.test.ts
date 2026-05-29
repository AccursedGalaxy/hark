import { describe, it, expect } from "vitest";
import { evaluatePreToolUse } from "./pmGuard.js";

const ROOT = "/home/u/Projects/app";
const base = { projectRoot: ROOT, cwd: ROOT };

describe("evaluatePreToolUse — read-only / coordination tools", () => {
  it("allows read tools regardless of path", () => {
    for (const toolName of ["Read", "Grep", "Glob", "LS", "NotebookRead"]) {
      const d = evaluatePreToolUse({
        ...base,
        toolName,
        toolInput: { file_path: `${ROOT}/src/index.ts` },
      });
      expect(d.decision).toBe("allow");
    }
  });

  it("allows an unknown tool by default (only known mutators are gated)", () => {
    const d = evaluatePreToolUse({
      ...base,
      toolName: "WebFetch",
      toolInput: { url: "https://example.com" },
    });
    expect(d.decision).toBe("allow");
  });
});

describe("evaluatePreToolUse — Write/Edit path guard", () => {
  const writers = ["Write", "Edit", "MultiEdit"];

  it("denies writing source inside the project tree", () => {
    for (const toolName of writers) {
      const d = evaluatePreToolUse({
        ...base,
        toolName,
        toolInput: { file_path: `${ROOT}/src/index.ts` },
      });
      expect(d.decision).toBe("deny");
      if (d.decision === "deny") expect(d.reason).toMatch(/PLAN|read-only|pure PM/i);
    }
  });

  it("denies writing a relative source path (resolved against cwd)", () => {
    const d = evaluatePreToolUse({
      ...base,
      cwd: `${ROOT}/src`,
      toolName: "Edit",
      toolInput: { file_path: "index.ts" },
    });
    expect(d.decision).toBe("deny");
  });

  it("denies a '..' traversal that lands back in the tree", () => {
    const d = evaluatePreToolUse({
      ...base,
      toolName: "Write",
      toolInput: { file_path: `${ROOT}/.hark/../src/x.ts` },
    });
    expect(d.decision).toBe("deny");
  });

  it("allows writing PLAN.md", () => {
    const d = evaluatePreToolUse({
      ...base,
      toolName: "Edit",
      toolInput: { file_path: `${ROOT}/PLAN.md` },
    });
    expect(d.decision).toBe("allow");
  });

  it("allows writing inside the .hark coordination dir", () => {
    const d = evaluatePreToolUse({
      ...base,
      toolName: "Write",
      toolInput: { file_path: `${ROOT}/.hark/notes.md` },
    });
    expect(d.decision).toBe("allow");
  });

  it("allows writing outside the project tree (integration worktree, /tmp)", () => {
    for (const p of ["/home/u/.hark/worktrees/app/orch-1/int/x.ts", "/tmp/scratch.txt"]) {
      const d = evaluatePreToolUse({
        ...base,
        toolName: "Write",
        toolInput: { file_path: p },
      });
      expect(d.decision).toBe("allow");
    }
  });

  it("denies NotebookEdit on a tree notebook (uses notebook_path)", () => {
    const d = evaluatePreToolUse({
      ...base,
      toolName: "NotebookEdit",
      toolInput: { notebook_path: `${ROOT}/analysis.ipynb` },
    });
    expect(d.decision).toBe("deny");
  });

  it("denies a writer with no resolvable path (fail closed)", () => {
    const d = evaluatePreToolUse({
      ...base,
      toolName: "Write",
      toolInput: {},
    });
    expect(d.decision).toBe("deny");
  });
});

describe("evaluatePreToolUse — Bash git mutation guard", () => {
  const bash = (command: string, cwd = ROOT) =>
    evaluatePreToolUse({ ...base, cwd, toolName: "Bash", toolInput: { command } });

  it("allows read-only git", () => {
    for (const c of [
      "git status",
      "git diff main..feature",
      "git log --oneline -5",
      "git show HEAD:src/index.ts",
      "git rev-parse HEAD",
      "git branch -a",
    ]) {
      expect(bash(c).decision).toBe("allow");
    }
  });

  it("allows git push and fetch (no tree mutation)", () => {
    expect(bash("git push origin feature").decision).toBe("allow");
    expect(bash("git fetch origin").decision).toBe("allow");
  });

  it("allows git worktree add (operates elsewhere)", () => {
    expect(bash("git worktree add /tmp/wt feature").decision).toBe("allow");
  });

  it("denies tree-mutating git against the project root", () => {
    for (const c of [
      "git commit -m x",
      "git add -A",
      "git checkout main",
      "git switch main",
      "git reset --hard HEAD",
      "git merge feature",
      "git rebase main",
      "git restore src/index.ts",
      "git stash",
      "git clean -fd",
      "git cherry-pick abc",
      "git pull",
    ]) {
      const d = bash(c);
      expect(d.decision, c).toBe("deny");
    }
  });

  it("denies a mutating git buried in a compound command", () => {
    expect(bash("cd /x && echo hi && git commit -am wip").decision).toBe("deny");
    expect(bash("git status; git add .").decision).toBe("deny");
  });

  it("allows mutating git scoped via -C to a dir OUTSIDE the tree", () => {
    expect(bash("git -C /home/u/.hark/worktrees/app/int commit -m x").decision).toBe(
      "allow",
    );
  });

  it("denies mutating git scoped via -C to a dir INSIDE the tree", () => {
    expect(bash(`git -C ${ROOT}/src add .`).decision).toBe("deny");
    expect(bash("git -C ./src commit -m x").decision).toBe("deny");
  });
});

describe("evaluatePreToolUse — Bash file-mutation guard", () => {
  const bash = (command: string, cwd = ROOT) =>
    evaluatePreToolUse({ ...base, cwd, toolName: "Bash", toolInput: { command } });

  it("denies rm of a tree file", () => {
    expect(bash("rm src/index.ts").decision).toBe("deny");
    expect(bash("rm -rf src").decision).toBe("deny");
  });

  it("denies output redirection into the tree", () => {
    expect(bash("echo x > src/index.ts").decision).toBe("deny");
    expect(bash("cat foo >> src/notes.txt").decision).toBe("deny");
  });

  it("denies sed -i on a tree file", () => {
    expect(bash("sed -i 's/a/b/' src/index.ts").decision).toBe("deny");
  });

  it("allows redirection / writes outside the tree", () => {
    expect(bash("echo x > /tmp/out.txt").decision).toBe("allow");
    expect(bash("npm test 2>&1 | tee /tmp/log").decision).toBe("allow");
  });

  it("allows redirection into PLAN.md and .hark", () => {
    expect(bash(`echo x >> ${ROOT}/.hark/scratch`).decision).toBe("allow");
  });

  it("allows reading source via cat / grep (no mutation)", () => {
    expect(bash("cat src/index.ts").decision).toBe("allow");
    expect(bash("grep -r foo src/").decision).toBe("allow");
  });

  it("allows running the hark CLI and gh", () => {
    expect(bash('hark agent spawn coder --task "x"').decision).toBe("allow");
    expect(bash("gh pr create --base main").decision).toBe("allow");
  });

  it("allows a Bash with no command field", () => {
    expect(
      evaluatePreToolUse({ ...base, toolName: "Bash", toolInput: {} }).decision,
    ).toBe("allow");
  });
});
