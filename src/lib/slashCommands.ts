import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type CommandSource = "project" | "user" | `plugin:${string}`;

export interface SlashCommand {
  name: string;
  source: CommandSource;
  description: string;
  argumentHint: string;
}

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
  const byName = new Map<string, SlashCommand>();
  for (const cmd of all) {
    const existing = byName.get(cmd.name);
    if (!existing || sourcePriority(cmd.source) < sourcePriority(existing.source)) {
      byName.set(cmd.name, cmd);
    }
  }
  return [...byName.values()].sort((a, b) => {
    const pa = sourcePriority(a.source);
    const pb = sourcePriority(b.source);
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}

export interface DiscoverOptions {
  userCommandsDir?: string;
  projectCwd?: string;
  pluginsRoot?: string;
}

function defaultUserCommandsDir(): string {
  return path.join(os.homedir(), ".claude", "commands");
}

function defaultPluginsRoot(): string {
  return path.join(os.homedir(), ".claude", "plugins");
}

export async function discoverCommands(
  opts: DiscoverOptions = {},
): Promise<SlashCommand[]> {
  const userDir = opts.userCommandsDir ?? defaultUserCommandsDir();
  const pluginsRoot = opts.pluginsRoot ?? defaultPluginsRoot();
  const projectDir = opts.projectCwd
    ? path.join(opts.projectCwd, ".claude", "commands")
    : null;

  const all: SlashCommand[] = [];
  const collect = async (dir: string, source: CommandSource) => {
    for (const cmd of await readCommandsDir(dir, source)) all.push(cmd);
  };

  await Promise.all([
    collect(userDir, "user"),
    projectDir ? collect(projectDir, "project") : Promise.resolve(),
    collectPluginCommands(pluginsRoot, all),
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
        description: fm.description,
        argumentHint: fm.argumentHint,
      });
    } catch {
      // Unreadable file — skip rather than fail the whole scan.
    }
  }
  return out;
}

// Walk only plugins listed in installed_plugins.json — the catalog under
// marketplaces/ holds every available plugin, including ones the user hasn't
// installed and which the TUI therefore wouldn't expose as a slash command.
async function collectPluginCommands(
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
    for (const entry of entries) {
      const installPath = (entry as { installPath?: unknown })?.installPath;
      if (typeof installPath !== "string") continue;
      const cmds = await readCommandsDir(
        path.join(installPath, "commands"),
        `plugin:${pluginName}` as CommandSource,
      );
      for (const cmd of cmds) out.push(cmd);
    }
  }
}
