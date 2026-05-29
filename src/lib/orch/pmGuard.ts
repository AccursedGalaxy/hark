import path from "node:path";

// The pure-PM enforcement policy (PM-Head Orchestration Harness, spec §2.2 +
// §3.8). A PM-head is read-only on its project tree *by construction*: a
// Claude Code `PreToolUse` hook runs every tool call through this function and
// denies anything that would write or mutate the source tree. Only PLAN.md and
// `.hark/` coordination files are writable. "Pure PM" becomes a system
// property, not a guideline the agent can talk itself out of.
//
// Pure + IO-free so the policy is exhaustively testable; the server is the thin
// part that resolves whether a session is a head and shapes the hook response.
//
// Scope (faithful to §3.8): we gate `Edit`/`Write`/`MultiEdit`/`NotebookEdit`
// (robust — LLM agents mutate files almost exclusively through these) and
// tree-mutating `git` / destructive shell file-ops in `Bash` (best-effort
// parse). Read tools and everything not recognised as a mutator pass through.
// The Write/Edit path check is the airtight guarantee; the Bash parse is a
// backstop layered on top of the charter, not a sandbox.

export interface PreToolUseInput {
  toolName: string;
  toolInput: unknown;
  // The PM-head's project tree (absolute). Mutations resolving inside it are
  // denied except to PLAN.md + `.hark/`.
  projectRoot: string;
  // The session's cwd, for resolving relative paths/commands. Defaults to
  // projectRoot. (The PreToolUse payload carries this.)
  cwd?: string;
  // Absolute PLAN.md path; defaults to <projectRoot>/PLAN.md.
  planPath?: string;
}

export type PreToolUseDecision =
  | { decision: "deny"; reason: string }
  | { decision: "allow" };

const ALLOW: PreToolUseDecision = { decision: "allow" };
function deny(reason: string): PreToolUseDecision {
  return { decision: "deny", reason };
}

const PURE_PM_REASON =
  "Blocked by hark: a PM-head is read-only on the project tree. Only PLAN.md and .hark/ are writable. " +
  "To change source, dispatch a worker (`hark agent spawn …`) or propose a patch for the human to apply.";

// True if `child` is the same as or nested under `parent` (both absolute,
// normalized). Uses path.relative so `..`-traversal can't escape detection.
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Whether a write/mutation to `target` is permitted. Writable = PLAN.md, or
// anywhere under `.hark/`, or anywhere OUTSIDE the project tree (other
// worktrees, /tmp, ~/.hark). Anything else inside the tree is source → denied.
function isWritablePath(
  target: string,
  projectRoot: string,
  planPath: string,
): boolean {
  if (target === planPath) return true;
  if (isInside(target, path.join(projectRoot, ".hark"))) return true;
  if (!isInside(target, projectRoot)) return true;
  return false;
}

function resolveTarget(p: string, cwd: string): string {
  return path.resolve(cwd, p);
}

// ---- Bash command parsing (best-effort) -------------------------------------

// Split a command line into statements on shell control operators (`&&`, `||`,
// `|`, `;`, `&`, newline), honouring single + double quotes so an operator that
// appears INSIDE a quoted string does not over-split the command. This matters
// for worker-dispatch: a `--task` brief routinely contains `;`, `|`, `&` and
// newlines as prose, and splitting on them would shred the quoted payload into
// fragments that `inspectStatement` then misreads as shell. Quote state is
// tracked across the whole string; `tokenize` honours quotes within a statement.
function splitStatements(command: string): string[] {
  const stmts: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "&" || ch === "|") {
      // Consume the paired second char of `&&` / `||` so it isn't left dangling.
      if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
        i++;
      }
      stmts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  stmts.push(cur);
  return stmts.map((s) => s.trim()).filter((s) => s.length > 0);
}

// Tokenize a statement, honouring single + double quotes so paths with spaces
// stay intact. Redirection operators are emitted as their own tokens so the
// caller can pair `>`/`>>` with the following target.
function tokenize(stmt: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let hasChar = false;
  const push = () => {
    if (hasChar) tokens.push(cur);
    cur = "";
    hasChar = false;
  };
  for (let i = 0; i < stmt.length; i++) {
    const ch = stmt[i];
    if (quote) {
      if (ch === quote) quote = null;
      else {
        cur += ch;
        hasChar = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasChar = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      push();
      continue;
    }
    if (ch === ">" || ch === "<") {
      // Emit any pending word, then the redirection operator (>>, >, <).
      push();
      let op = ch;
      if (ch === ">" && stmt[i + 1] === ">") {
        op = ">>";
        i++;
      }
      tokens.push(op);
      continue;
    }
    cur += ch;
    hasChar = true;
  }
  push();
  return tokens;
}

// Drop a leading run of `VAR=value` env assignments so the real command word
// is found (e.g. `FOO=1 git commit` → command is `git`).
function commandWord(tokens: string[]): { cmd: string; args: string[] } | null {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return null;
  const base = path.basename(tokens[i]);
  return { cmd: base, args: tokens.slice(i + 1) };
}

// Script runners that execute a script supplied as their first non-flag
// argument (e.g. `node ./bin/hark …`). Used to recognise a hark dispatch
// launched indirectly.
const SCRIPT_RUNNERS = new Set(["node", "npx", "tsx", "ts-node", "bun", "deno"]);

// Whether a statement is a sanctioned hark worker-dispatch invocation: the
// command word is `hark`, or a script runner whose first non-flag argument
// resolves to a `bin/hark` script. Such statements carry opaque `--task` /
// `--title` payloads (prose, not shell), so the caller must not parse their
// arguments as tree mutations. Applied per-statement — a real mutation chained
// after a dispatch is its own statement and is still inspected.
function isHarkDispatch(cw: { cmd: string; args: string[] }): boolean {
  if (cw.cmd === "hark") return true;
  if (SCRIPT_RUNNERS.has(cw.cmd)) {
    const script = cw.args.find((a) => !a.startsWith("-"));
    if (script) {
      return path.basename(script) === "hark" && path.basename(path.dirname(script)) === "bin";
    }
  }
  return false;
}

const GIT_TREE_MUTATORS = new Set([
  "commit",
  "add",
  "rm",
  "mv",
  "restore",
  "checkout",
  "switch",
  "reset",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "stash",
  "clean",
  "apply",
  "am",
  "pull",
]);

// Parse a `git …` invocation: extract the effective working dir (-C value, else
// cwd) and the subcommand, skipping global options.
function parseGit(
  args: string[],
  cwd: string,
): { dir: string; sub: string | null } {
  let dir = cwd;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "-C") {
      dir = resolveTarget(args[i + 1] ?? ".", cwd);
      i += 2;
      continue;
    }
    if (a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") {
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      i++;
      continue;
    }
    return { dir, sub: a };
  }
  return { dir, sub: null };
}

// Programs whose path arguments mutate the filesystem. For each, `targetArgs`
// extracts which non-flag args are write targets.
type MutatorSpec = (args: string[]) => string[];
const FILE_MUTATORS: Record<string, MutatorSpec> = {
  // All non-flag args are removed.
  rm: (args) => args.filter((a) => !a.startsWith("-")),
  rmdir: (args) => args.filter((a) => !a.startsWith("-")),
  unlink: (args) => args.filter((a) => !a.startsWith("-")),
  // Destination is the last non-flag arg.
  mv: lastNonFlag,
  cp: lastNonFlag,
  install: lastNonFlag,
  tee: (args) => args.filter((a) => !a.startsWith("-")),
  // sed/perl mutate in place only with -i; then file args are targets.
  sed: inPlaceEditTargets,
  perl: inPlaceEditTargets,
};

function lastNonFlag(args: string[]): string[] {
  const nonFlags = args.filter((a) => !a.startsWith("-"));
  const last = nonFlags[nonFlags.length - 1];
  return last ? [last] : [];
}

function inPlaceEditTargets(args: string[]): string[] {
  const inPlace = args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place");
  if (!inPlace) return [];
  // Heuristic: the trailing path-looking args are the files being edited.
  return args.filter((a) => !a.startsWith("-") && !/^s[/|]/.test(a) && a.includes("."));
}

// Inspect one Bash statement for a tree mutation. Returns a deny reason or null.
function inspectStatement(
  stmt: string,
  projectRoot: string,
  cwd: string,
  planPath: string,
): string | null {
  const tokens = tokenize(stmt);
  const cw = commandWord(tokens);

  // A sanctioned hark worker-dispatch carries opaque prose in `--task` /
  // `--title`; treat the whole statement as data and skip mutation parsing.
  // (Per-statement: anything chained after it is a separate statement and is
  // still inspected.)
  if (cw && isHarkDispatch(cw)) return null;

  // Redirections (`>`/`>>` target) mutate the target file regardless of the
  // command. Scan token pairs.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === ">" || tokens[i] === ">>") {
      const target = tokens[i + 1];
      if (target && !isWritablePath(resolveTarget(target, cwd), projectRoot, planPath)) {
        return `redirection into the project tree (${target})`;
      }
    }
  }

  if (!cw) return null;

  if (cw.cmd === "git") {
    const { dir, sub } = parseGit(cw.args, cwd);
    if (sub && GIT_TREE_MUTATORS.has(sub) && isInside(dir, projectRoot)) {
      return `tree-mutating git (\`git ${sub}\`) against the project root`;
    }
    return null;
  }

  const mut = FILE_MUTATORS[cw.cmd];
  if (mut) {
    for (const t of mut(cw.args)) {
      if (!isWritablePath(resolveTarget(t, cwd), projectRoot, planPath)) {
        return `${cw.cmd} mutating a file in the project tree (${t})`;
      }
    }
  }
  return null;
}

// ---- Top-level policy -------------------------------------------------------

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

function inputObj(toolInput: unknown): Record<string, unknown> {
  return toolInput && typeof toolInput === "object"
    ? (toolInput as Record<string, unknown>)
    : {};
}

export function evaluatePreToolUse(input: PreToolUseInput): PreToolUseDecision {
  const projectRoot = path.resolve(input.projectRoot);
  const cwd = path.resolve(input.cwd ?? projectRoot);
  const planPath = input.planPath
    ? path.resolve(input.planPath)
    : path.join(projectRoot, "PLAN.md");
  const ti = inputObj(input.toolInput);

  if (WRITE_TOOLS.has(input.toolName)) {
    const raw = typeof ti.file_path === "string" ? ti.file_path : null;
    if (!raw) return deny(PURE_PM_REASON); // fail closed — no resolvable target
    const target = resolveTarget(raw, cwd);
    return isWritablePath(target, projectRoot, planPath) ? ALLOW : deny(PURE_PM_REASON);
  }

  if (input.toolName === "NotebookEdit") {
    const raw = typeof ti.notebook_path === "string" ? ti.notebook_path : null;
    if (!raw) return deny(PURE_PM_REASON);
    const target = resolveTarget(raw, cwd);
    return isWritablePath(target, projectRoot, planPath) ? ALLOW : deny(PURE_PM_REASON);
  }

  if (input.toolName === "Bash") {
    const command = typeof ti.command === "string" ? ti.command : null;
    if (!command) return ALLOW;
    for (const stmt of splitStatements(command)) {
      const reason = inspectStatement(stmt, projectRoot, cwd, planPath);
      if (reason) return deny(`${PURE_PM_REASON} (${reason})`);
    }
    return ALLOW;
  }

  return ALLOW;
}
