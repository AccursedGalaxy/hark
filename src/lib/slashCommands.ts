import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SlashCommand,
  SlashCommandKind,
  SlashCommandSource,
} from "../shared/protocol.js";

// Local aliases keep the existing in-file vocabulary (CommandSource,
// CommandKind) while the canonical types live in src/shared/protocol.ts —
// the same file web imports from. Re-exported for callers that import these
// names from `./slashCommands.js`.
export type CommandSource = SlashCommandSource;
export type CommandKind = SlashCommandKind;
export type { SlashCommand };

export interface CommandFileFrontmatter {
  description: string;
  argumentHint: string;
}

// Minimal YAML-frontmatter parser. We only care about two scalar keys
// (description, argument-hint), and Claude's official command files always
// use a flat key:value shape — no nesting, no multiline. Pulling in a real
// YAML dependency for that is overkill.
export function parseCommandFile(source: string): CommandFileFrontmatter {
  const empty: CommandFileFrontmatter = { description: "", argumentHint: "" };
  if (!source.startsWith("---")) return empty;
  const end = source.indexOf("\n---", 3);
  if (end === -1) return empty;
  const block = source.slice(3, end);
  const out: CommandFileFrontmatter = { ...empty };
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = stripQuotes(line.slice(colon + 1).trim());
    if (key === "description") out.description = value;
    else if (key === "argument-hint") out.argumentHint = value;
  }
  return out;
}

function stripQuotes(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

// Priority: project > user > plugin. The TUI follows the same precedence —
// a project-local override of a user command should "win" in the popover.
const SOURCE_PRIORITY: Record<string, number> = {
  project: 0,
  user: 1,
};
function sourcePriority(s: CommandSource): number {
  return SOURCE_PRIORITY[s] ?? 2;
}

export function mergeCommandLists(all: SlashCommand[]): SlashCommand[] {
  // Key by name+kind: a command and a skill that share a name are distinct
  // surfaces in the TUI, so the popover should expose both.
  const byKey = new Map<string, SlashCommand>();
  for (const cmd of all) {
    const key = `${cmd.kind}:${cmd.name}`;
    const existing = byKey.get(key);
    if (!existing || sourcePriority(cmd.source) < sourcePriority(existing.source)) {
      byKey.set(key, cmd);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const pa = sourcePriority(a.source);
    const pb = sourcePriority(b.source);
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}

export interface DiscoverOptions {
  userCommandsDir?: string;
  userSkillsDir?: string;
  projectCwd?: string;
  pluginsRoot?: string;
}

function defaultUserCommandsDir(): string {
  return path.join(os.homedir(), ".claude", "commands");
}

function defaultUserSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

function defaultPluginsRoot(): string {
  return path.join(os.homedir(), ".claude", "plugins");
}

export async function discoverCommands(
  opts: DiscoverOptions = {},
): Promise<SlashCommand[]> {
  const userCommandsDir = opts.userCommandsDir ?? defaultUserCommandsDir();
  const userSkillsDir = opts.userSkillsDir ?? defaultUserSkillsDir();
  const pluginsRoot = opts.pluginsRoot ?? defaultPluginsRoot();
  const projectCommandsDir = opts.projectCwd
    ? path.join(opts.projectCwd, ".claude", "commands")
    : null;
  const projectSkillsDir = opts.projectCwd
    ? path.join(opts.projectCwd, ".claude", "skills")
    : null;

  const all: SlashCommand[] = [];
  const collectCmds = async (dir: string, source: CommandSource) => {
    for (const cmd of await readCommandsDir(dir, source)) all.push(cmd);
  };
  const collectSkills = async (
    dir: string,
    source: CommandSource,
    namePrefix = "",
  ) => {
    for (const cmd of await readSkillsDir(dir, source, namePrefix)) all.push(cmd);
  };

  await Promise.all([
    collectCmds(userCommandsDir, "user"),
    collectSkills(userSkillsDir, "user"),
    projectCommandsDir ? collectCmds(projectCommandsDir, "project") : Promise.resolve(),
    projectSkillsDir ? collectSkills(projectSkillsDir, "project") : Promise.resolve(),
    collectPluginContent(pluginsRoot, all),
  ]);

  return mergeCommandLists(all);
}

async function readCommandsDir(
  dir: string,
  source: CommandSource,
): Promise<SlashCommand[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: SlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const full = path.join(dir, entry);
    try {
      const text = await fs.readFile(full, "utf8");
      const fm = parseCommandFile(text);
      out.push({
        name: entry.slice(0, -3),
        source,
        kind: "command",
        description: fm.description,
        argumentHint: fm.argumentHint,
      });
    } catch {
      // Unreadable file — skip rather than fail the whole scan.
    }
  }
  return out;
}

// Skills live one level deeper: <skillsDir>/<name>/SKILL.md. The SKILL.md
// frontmatter shape is the same flat key:value YAML; we only care about
// description (name comes from the directory). `namePrefix` lets plugin
// skills carry the "<plugin>:" prefix Claude's TUI uses for invocation.
async function readSkillsDir(
  dir: string,
  source: CommandSource,
  namePrefix: string,
): Promise<SlashCommand[]> {
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    try {
      const text = await fs.readFile(skillFile, "utf8");
      const fm = parseCommandFile(text);
      out.push({
        name: `${namePrefix}${entry.name}`,
        source,
        kind: "skill",
        description: fm.description,
        argumentHint: fm.argumentHint,
      });
    } catch {
      // No SKILL.md — directory isn't a skill, skip silently.
    }
  }
  return out;
}

// Walk only plugins listed in installed_plugins.json — the catalog under
// marketplaces/ holds every available plugin, including ones the user hasn't
// installed and which the TUI therefore wouldn't expose as a slash command.
async function collectPluginContent(
  pluginsRoot: string,
  out: SlashCommand[],
): Promise<void> {
  const manifestPath = path.join(pluginsRoot, "installed_plugins.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return;
  }
  const plugins =
    (manifest as { plugins?: Record<string, unknown> } | null)?.plugins;
  if (!plugins || typeof plugins !== "object") return;

  for (const [key, entries] of Object.entries(plugins)) {
    // Key shape is "<plugin-name>@<marketplace>"; strip the marketplace.
    const pluginName = key.split("@")[0] ?? key;
    if (!Array.isArray(entries)) continue;
    const source: CommandSource = `plugin:${pluginName}`;
    for (const entry of entries) {
      const installPath = (entry as { installPath?: unknown })?.installPath;
      if (typeof installPath !== "string") continue;
      const cmds = await readCommandsDir(
        path.join(installPath, "commands"),
        source,
      );
      for (const cmd of cmds) out.push(cmd);
      const skills = await readSkillsDir(
        path.join(installPath, "skills"),
        source,
        `${pluginName}:`,
      );
      for (const skill of skills) out.push(skill);
    }
  }
}
