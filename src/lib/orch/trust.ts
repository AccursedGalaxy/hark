import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

// Folder-trust clearing (Sharp Edge 0, Gate 1). Claude Code shows a "Do you
// trust the files in this folder?" dialog once per worktree at startup. With
// the head-always + spawn-on-demand model, that dialog must clear unattended
// for the head AND every head-spawned worker — there is no human to click it.
//
// The chosen mechanism (see docs/orchestration-head.md) is to pre-write
// `~/.claude.json`: setting `projects["<absolute-worktree-dir>"]
// .hasTrustDialogAccepted = true` *before* spawning makes the dialog never
// fire. Two hard constraints shape this module:
//
//   1. The entry is keyed by EXACT absolute path — no parent coverage — so one
//      write per head and per worker, at spawn time.
//   2. `~/.claude.json` also holds `oauthAccount` and other live state, so the
//      write MUST be an atomic, merge-preserving read-modify-write (temp file +
//      rename) — never a clobber.
//
// As elsewhere in hark, the pure merge lives up top (unit-tested without
// touching the real config) and the atomic IO wrapper is the thin part.

// Minimal view of the bits of ~/.claude.json we touch. Everything else is
// preserved verbatim via the index signature.
export interface ClaudeConfig {
  projects?: Record<string, ProjectTrustEntry>;
  [key: string]: unknown;
}

export interface ProjectTrustEntry {
  hasTrustDialogAccepted?: boolean;
  [key: string]: unknown;
}

// The default location Claude Code reads. Overridable for tests.
export function defaultClaudeConfigPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

// Pure: return a NEW config object with `dir` marked trusted, preserving every
// other top-level key (oauthAccount, numStartups, …) and every sibling project
// entry, and merging into an existing entry for `dir` rather than replacing it.
// Does not mutate its input.
export function mergeTrust(
  existing: ClaudeConfig,
  dir: string,
): ClaudeConfig & { projects: Record<string, ProjectTrustEntry> } {
  const projects = { ...(existing.projects ?? {}) };
  projects[dir] = {
    ...(projects[dir] ?? {}),
    hasTrustDialogAccepted: true,
  };
  return { ...existing, projects };
}

// Pure: whether the exact path is already trusted in this config.
export function isTrusted(existing: ClaudeConfig, dir: string): boolean {
  return existing.projects?.[dir]?.hasTrustDialogAccepted === true;
}

async function readConfig(configPath: string): Promise<ClaudeConfig> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ClaudeConfig) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // A corrupt config is not ours to repair — re-throw so the caller knows
    // the spawn would race a trust dialog rather than silently clobbering.
    throw err;
  }
}

// Atomic, merge-preserving write that clears the trust dialog for one worktree.
// Temp file in the same dir + rename, so a concurrent Claude Code reader never
// observes a half-written config. Low-severity race remains if another CC
// instance flushes a different project entry between our read and rename — the
// spec accepts this (the worst case is a single re-shown dialog, recoverable).
export async function clearTrust(
  dir: string,
  opts: { configPath?: string } = {},
): Promise<void> {
  const configPath = opts.configPath ?? defaultClaudeConfigPath();
  const existing = await readConfig(configPath);
  const merged = mergeTrust(existing, dir);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const tmp = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${randomBytes(4).toString("hex")}.tmp`,
  );
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
  await fs.rename(tmp, configPath);
}
