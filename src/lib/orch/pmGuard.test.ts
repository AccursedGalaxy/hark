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

describe("evaluatePreToolUse — worker-dispatch + quote awareness", () => {
  const bash = (command: string, cwd = ROOT) =>
    evaluatePreToolUse({ ...base, cwd, toolName: "Bash", toolInput: { command } });

  it("does not split on operators inside quotes (quote-aware)", () => {
    // The `; rm src/index.ts` is inside the quoted echo arg, so it is one
    // statement, not a chained rm — must be allowed. (Old splitter shredded it.)
    expect(bash(`echo "cleanup: ; rm src/index.ts now"`).decision).toBe("allow");
    expect(bash(`echo 'pipe it | tee src/x.ts'`).decision).toBe("allow");
  });

  it("allows a hark dispatch whose --task brief is full of shell-looking prose", () => {
    const brief =
      "Refactor the PR flow.\n" +
      "Steps: read src/lib/orch/pr.ts; pipe it | grep foo; emit a > marker.\n" +
      "Flow: parse -> validate -> ship. Mind x>y edge cases & retries.";
    expect(bash(`node ./bin/hark agent spawn coder --task "${brief}"`).decision).toBe(
      "allow",
    );
  });

  it("allows a hark dispatch via the hark binary directly", () => {
    expect(
      bash('hark agent spawn coder --task "ship src/x.ts; do | thing > here"').decision,
    ).toBe("allow");
  });

  it("allows a hark dispatch run via an absolute bin/hark path", () => {
    expect(
      bash('node /opt/hark/bin/hark agent spawn coder --task "edit src/a.ts > b"').decision,
    ).toBe("allow");
  });

  it("still denies a real rm chained after a hark dispatch", () => {
    expect(
      bash('node ./bin/hark agent spawn coder --task "do x"; rm src/index.ts').decision,
    ).toBe("deny");
  });

  it("still denies a redirection chained after a hark dispatch", () => {
    expect(
      bash('hark agent spawn coder --task "do x" && echo hi > src/index.ts').decision,
    ).toBe("deny");
  });

  it("still denies a tree-mutating git chained after a hark dispatch", () => {
    expect(
      bash('hark agent spawn coder --task "do x" ; git add -A').decision,
    ).toBe("deny");
  });

  it("allows stdin/heredoc reads (<, <<, <<<) — they are reads, not writes", () => {
    // Bare `<` reads a tree file into stdin; never a write.
    expect(bash("cat < src/index.ts").decision).toBe("allow");
    // Here-string `<<<` feeds same-line data to stdin.
    expect(bash("grep foo <<< src/index.ts").decision).toBe("allow");
    // Heredoc `<<DELIM`: the body is opaque data, even when it contains
    // shell-looking prose like `>` or `rm` that would otherwise be flagged.
    const heredoc =
      "cat <<EOF\n" +
      "ship src/x.ts; emit a > marker then rm the stub & retry | tee\n" +
      "EOF";
    expect(bash(heredoc).decision).toBe("allow");
  });

  it("allows a hark dispatch whose brief is piped via a heredoc (--task-file -)", () => {
    const cmd =
      "hark agent spawn coder --task-file - <<BRIEF\n" +
      "Refactor the PR flow.\n" +
      "Steps: read src/lib/orch/pr.ts; pipe it | grep foo; emit a > marker.\n" +
      "Then write src/out.ts > here and rm the scratch file.\n" +
      "BRIEF";
    expect(bash(cmd).decision).toBe("allow");
  });

  it("still denies > / >> into a tree path chained after a heredoc body", () => {
    // The terminating delimiter line ends the heredoc statement, so a real
    // write redirection on the next line is still inspected and denied.
    expect(bash("cat <<EOF\nbody text\nEOF\necho x > src/index.ts").decision).toBe(
      "deny",
    );
    expect(bash("cat <<EOF\nbody text\nEOF\ncat foo >> src/notes.txt").decision).toBe(
      "deny",
    );
    // And a write redirection on the command line itself (not the body).
    expect(bash("echo x > src/index.ts").decision).toBe("deny");
  });

  it("keeps existing deny cases intact alongside the dispatch allowlist", () => {
    // Write to source still denied.
    expect(
      evaluatePreToolUse({
        ...base,
        toolName: "Write",
        toolInput: { file_path: `${ROOT}/src/index.ts` },
      }).decision,
    ).toBe("deny");
    // git commit at root, rm and redirection into the tree still denied.
    expect(bash("git commit -m x").decision).toBe("deny");
    expect(bash("rm src/index.ts").decision).toBe("deny");
    expect(bash("echo x > src/index.ts").decision).toBe("deny");
  });
});
