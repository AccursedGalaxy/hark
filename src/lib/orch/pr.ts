// `hark pr` — the integration helper (PM-Head Orchestration Harness, spec §6
// #8 / §3.7). Pushes a worker branch and opens a PR against the base, WITHOUT
// ever checking the branch out against the project root (mutations elsewhere;
// the human still owns the final landing). Covers the no-remote case (Sharp
// Edge 7 / the resolved open question): with no `origin`, it stops at "branch
// ready, here's the diff" rather than failing. Also covers the common PM-head
// case where the base is a local-only WIP branch never pushed to origin: rather
// than letting `gh pr create` die with a raw "Base ref must be a branch"
// GraphQL error, it degrades to the same ready-branch handoff.
//
// The orchestration is pure + DI'd so the policy (remote present? base pushed?
// push head? open PR? degrade to ready-branch?) is unit-testable; the server
// injects the real git/gh IO.

// Pure arg builders (mirrors worktree.ts's style — tested without spawning).
export function buildPushArgs(repoRoot: string, branch: string): string[] {
  // -u sets upstream so a later `git push` from the worktree just works.
  return ["-C", repoRoot, "push", "-u", "origin", branch];
}

// `git ls-remote --heads origin <base>` — empty stdout means the base branch
// has never been pushed to origin (so a PR against it would fail).
export function buildLsRemoteArgs(repoRoot: string, baseRef: string): string[] {
  return ["-C", repoRoot, "ls-remote", "--heads", "origin", baseRef];
}

export function buildGhPrArgs(
  baseRef: string,
  branch: string,
  title?: string,
): string[] {
  const args = ["pr", "create", "--base", baseRef, "--head", branch];
  if (title && title.trim().length > 0) {
    args.push("--title", title.trim(), "--body", "");
  } else {
    args.push("--fill");
  }
  return args;
}

export interface PrDeps {
  // Whether the repo has an `origin` remote.
  hasOrigin: (repoRoot: string) => Promise<boolean>;
  // Whether the base ref exists on origin (a PR target must be a real remote
  // branch). False when the base is a local-only WIP branch.
  baseOnOrigin: (repoRoot: string, baseRef: string) => Promise<boolean>;
  // Whether `gh` is installed + authenticated.
  ghReady: () => Promise<boolean>;
  // Push the branch to origin.
  push: (repoRoot: string, branch: string) => Promise<void>;
  // Open the PR; resolves to the PR URL (gh prints it on stdout).
  createPr: (
    repoRoot: string,
    baseRef: string,
    branch: string,
    title?: string,
  ) => Promise<string>;
  // Compact diffstat for the ready-branch message in the no-remote case.
  diffstat: () => Promise<string>;
}

export interface PrInput {
  repoRoot: string;
  baseRef: string;
  branch: string;
  title?: string;
}

export type PrResult =
  | { status: "created"; url: string; branch: string }
  | { status: "no_remote"; branch: string; diffstat: string; message: string }
  | { status: "no_base"; branch: string; diffstat: string; message: string }
  | { status: "no_gh"; branch: string; message: string }
  | { status: "error"; branch: string; message: string };

// Prepare a PR for a worker branch. Order: no origin → hand back a ready
// branch (the human merges locally); base not on origin → same ready-branch
// handoff (a local-only WIP base can't be a PR target — don't auto-push the
// human's WIP); no gh → push but tell the user to open the PR themselves; else
// push + open PR.
export async function preparePr(
  input: PrInput,
  deps: PrDeps,
): Promise<PrResult> {
  const { repoRoot, baseRef, branch, title } = input;
  if (!(await deps.hasOrigin(repoRoot))) {
    const diffstat = await deps.diffstat().catch(() => "");
    return {
      status: "no_remote",
      branch,
      diffstat,
      message:
        `No \`origin\` remote — can't open a PR. Branch \`${branch}\` is ready; ` +
        `the human can review the diff and merge it locally (the landing is always theirs).`,
    };
  }
  // The base must be a real branch on origin or `gh pr create` dies with a raw
  // "Base ref must be a branch" GraphQL error. The PM-head commonly works off a
  // local-only WIP base — degrade to the ready-branch handoff instead of
  // surfacing that error, and leave pushing the WIP base to the human.
  if (!(await deps.baseOnOrigin(repoRoot, baseRef))) {
    const diffstat = await deps.diffstat().catch(() => "");
    return {
      status: "no_base",
      branch,
      diffstat,
      message:
        `Base \`${baseRef}\` isn't on origin yet, so a PR can't target it. ` +
        `Branch \`${branch}\` is ready — either push the base ` +
        `(\`git push -u origin ${baseRef}\`) and re-run \`hark pr\`, ` +
        `or merge \`${branch}\` locally (the landing is always yours).`,
    };
  }
  if (!(await deps.ghReady())) {
    try {
      await deps.push(repoRoot, branch);
    } catch (err) {
      return { status: "error", branch, message: `push failed: ${String(err)}` };
    }
    return {
      status: "no_gh",
      branch,
      message:
        `Pushed \`${branch}\` to origin, but \`gh\` isn't available/authed — ` +
        `open the PR against \`${baseRef}\` yourself.`,
    };
  }
  try {
    await deps.push(repoRoot, branch);
    const url = await deps.createPr(repoRoot, baseRef, branch, title);
    return { status: "created", url: url.trim(), branch };
  } catch (err) {
    return { status: "error", branch, message: String(err) };
  }
}

// Render a PrResult as the `hark pr` command's stdout.
export function renderPrResult(r: PrResult): string {
  switch (r.status) {
    case "created":
      return `PR opened: ${r.url}`;
    case "no_remote":
    case "no_base":
      return `${r.message}${r.diffstat ? `\n${r.diffstat}` : ""}`;
    case "no_gh":
      return r.message;
    case "error":
      return `pr failed: ${r.message}`;
  }
}
