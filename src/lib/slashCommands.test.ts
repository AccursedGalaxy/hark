import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverCommands,
  mergeCommandLists,
  parseCommandFile,
  type SlashCommand,
} from "./slashCommands.js";

type Mk = (
  name: string,
  source: SlashCommand["source"],
  kind?: SlashCommand["kind"],
) => SlashCommand;

describe("parseCommandFile", () => {
  it("extracts description and argument-hint from YAML frontmatter", () => {
    const src = [
      "---",
      "description: Pull a GitHub issue and drive it to a PR.",
      "argument-hint: <issue-number-or-url>",
      "allowed-tools: Bash, Read",
      "---",
      "",
      "Body of the prompt.",
    ].join("\n");
    expect(parseCommandFile(src)).toEqual({
      description: "Pull a GitHub issue and drive it to a PR.",
      argumentHint: "<issue-number-or-url>",
    });
  });

  it("strips surrounding quotes from frontmatter values", () => {
    const src = [
      "---",
      'description: "Ship a release"',
      "argument-hint: '[major|minor|patch]'",
      "---",
      "",
    ].join("\n");
    expect(parseCommandFile(src)).toEqual({
      description: "Ship a release",
      argumentHint: "[major|minor|patch]",
    });
  });

  it("returns empty fields when no frontmatter is present", () => {
    expect(parseCommandFile("Just a body, no frontmatter.")).toEqual({
      description: "",
      argumentHint: "",
    });
  });

  it("returns empty fields when frontmatter has neither field", () => {
    const src = ["---", "allowed-tools: Bash", "---", ""].join("\n");
    expect(parseCommandFile(src)).toEqual({
      description: "",
      argumentHint: "",
    });
  });
});

describe("mergeCommandLists", () => {
  const cmd: Mk = (name, source, kind = "command") => ({
    name,
    source,
    kind,
    description: source,
    argumentHint: "",
  });

  it("orders project ahead of user ahead of plugin", () => {
    const merged = mergeCommandLists([
      cmd("a", "plugin:foo"),
      cmd("b", "user"),
      cmd("c", "project"),
    ]);
    expect(merged.map((m) => [m.name, m.source])).toEqual([
      ["c", "project"],
      ["b", "user"],
      ["a", "plugin:foo"],
    ]);
  });

  it("deduplicates by name+kind, keeping the highest-priority source", () => {
    const merged = mergeCommandLists([
      cmd("ship", "user"),
      cmd("ship", "project"),
      cmd("ship", "plugin:bar"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("project");
  });

  it("keeps a command and a skill with the same name as separate entries", () => {
    const merged = mergeCommandLists([
      cmd("review", "user", "command"),
      cmd("review", "user", "skill"),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.kind).sort()).toEqual(["command", "skill"]);
  });

  it("sorts alphabetically within a priority tier", () => {
    const merged = mergeCommandLists([
      cmd("zeta", "user"),
      cmd("alpha", "user"),
      cmd("mu", "user"),
    ]);
    expect(merged.map((m) => m.name)).toEqual(["alpha", "mu", "zeta"]);
  });
});

describe("discoverCommands", () => {
  let tmp: string;
  let userDir: string;
  let projectDir: string;
  let pluginsRoot: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hark-cmds-"));
    userDir = path.join(tmp, "user", "commands");
    projectDir = path.join(tmp, "project", ".claude", "commands");
    pluginsRoot = path.join(tmp, "plugins");
    await fs.mkdir(userDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeCmd(
    dir: string,
    name: string,
    description: string,
    argumentHint = "",
  ) {
    const frontmatter = [
      "---",
      `description: ${description}`,
      argumentHint ? `argument-hint: ${argumentHint}` : "",
      "---",
      "",
      "body",
    ]
      .filter(Boolean)
      .join("\n");
    await fs.writeFile(path.join(dir, `${name}.md`), frontmatter, "utf8");
  }

  async function writeSkill(
    skillsDir: string,
    name: string,
    description: string,
  ) {
    const dir = path.join(skillsDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      ["---", `name: ${name}`, `description: ${description}`, "---", "", "body"].join("\n"),
      "utf8",
    );
  }

  it("returns an empty list when no command or skill dirs exist", async () => {
    const out = await discoverCommands({
      userCommandsDir: path.join(tmp, "missing"),
      userSkillsDir: path.join(tmp, "missing-skills"),
      projectCwd: path.join(tmp, "no-project"),
      pluginsRoot: path.join(tmp, "no-plugins"),
    });
    expect(out).toEqual([]);
  });

  it("discovers user-level commands", async () => {
    await writeCmd(userDir, "ship", "Ship a release", "[level]");
    const out = await discoverCommands({
      userCommandsDir: userDir,
      userSkillsDir: path.join(tmp, "missing-skills"),
      projectCwd: path.join(tmp, "no-project"),
      pluginsRoot,
    });
    expect(out).toEqual([
      {
        name: "ship",
        source: "user",
        kind: "command",
        description: "Ship a release",
        argumentHint: "[level]",
      },
    ]);
  });

  it("discovers user-level skills", async () => {
    const skillsDir = path.join(tmp, "user", "skills");
    await writeSkill(skillsDir, "morning", "Morning vault review");
    const out = await discoverCommands({
      userCommandsDir: path.join(tmp, "missing"),
      userSkillsDir: skillsDir,
      projectCwd: path.join(tmp, "no-project"),
      pluginsRoot,
    });
    expect(out).toEqual([
      {
        name: "morning",
        source: "user",
        kind: "skill",
        description: "Morning vault review",
        argumentHint: "",
      },
    ]);
  });

  it("discovers project-level skills under <cwd>/.claude/skills", async () => {
    const projectSkillsDir = path.join(tmp, "project", ".claude", "skills");
    await writeSkill(projectSkillsDir, "verify", "Project verify routine");
    const out = await discoverCommands({
      userCommandsDir: path.join(tmp, "missing"),
      userSkillsDir: path.join(tmp, "missing-skills"),
      projectCwd: path.join(tmp, "project"),
      pluginsRoot,
    });
    expect(out).toEqual([
      {
        name: "verify",
        source: "project",
        kind: "skill",
        description: "Project verify routine",
        argumentHint: "",
      },
    ]);
  });

  it("prefixes plugin skills with the plugin name (plugin:skill form)", async () => {
    const installPath = path.join(pluginsRoot, "cache", "mp", "obsidian", "1.0");
    const pluginSkillsDir = path.join(installPath, "skills");
    await writeSkill(pluginSkillsDir, "defuddle", "Extract clean markdown");
    await fs.mkdir(pluginsRoot, { recursive: true });
    await fs.writeFile(
      path.join(pluginsRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "obsidian@mp": [{ installPath }] },
      }),
    );
    const out = await discoverCommands({
      userCommandsDir: path.join(tmp, "missing"),
      userSkillsDir: path.join(tmp, "missing-skills"),
      projectCwd: path.join(tmp, "no-project"),
      pluginsRoot,
    });
    expect(out).toEqual([
      {
        name: "obsidian:defuddle",
        source: "plugin:obsidian",
        kind: "skill",
        description: "Extract clean markdown",
        argumentHint: "",
      },
    ]);
  });

  it("discovers project-level commands under <cwd>/.claude/commands", async () => {
    await writeCmd(projectDir, "deploy", "Deploy this app");
    const out = await discoverCommands({
      userCommandsDir: path.join(tmp, "missing"),
      userSkillsDir: path.join(tmp, "missing-skills"),
      projectCwd: path.join(tmp, "project"),
      pluginsRoot,
    });
    expect(out).toEqual([
      {
        name: "deploy",
        source: "project",
        kind: "command",
        description: "Deploy this app",
        argumentHint: "",
      },
    ]);
  });

  it("discovers commands for installed plugins and tags them with plugin name", async () => {
    const installPath = path.join(pluginsRoot, "cache", "mp", "code-review", "1.0");
    const pluginCommandsDir = path.join(installPath, "commands");
    await fs.mkdir(pluginCommandsDir, { recursive: true });
    await writeCmd(pluginCommandsDir, "review", "Review this PR");

    const otherInstall = path.join(pluginsRoot, "cache", "mp", "other", "1.0");
    await fs.mkdir(otherInstall, { recursive: true });
    // plugin without a commands dir — should be silently skipped.

    await fs.mkdir(pluginsRoot, { recursive: true });
    await fs.writeFile(
      path.join(pluginsRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "code-review@mp": [{ installPath }],
          "other@mp": [{ installPath: otherInstall }],
        },
      }),
    );

    const out = await discoverCommands({
      userCommandsDir: path.join(tmp, "missing"),
      userSkillsDir: path.join(tmp, "missing-skills"),
      projectCwd: path.join(tmp, "no-project"),
      pluginsRoot,
    });
    expect(out).toEqual([
      {
        name: "review",
        source: "plugin:code-review",
        kind: "command",
        description: "Review this PR",
        argumentHint: "",
      },
    ]);
  });

  it("ignores plugins whose installPath is missing on disk", async () => {
    await fs.mkdir(pluginsRoot, { recursive: true });
    await fs.writeFile(
      path.join(pluginsRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "ghost@mp": [{ installPath: path.join(tmp, "does-not-exist") }],
        },
      }),
    );
    const out = await discoverCommands({
      userCommandsDir: path.join(tmp, "missing"),
      userSkillsDir: path.join(tmp, "missing-skills"),
      projectCwd: path.join(tmp, "no-project"),
      pluginsRoot,
    });
    expect(out).toEqual([]);
  });

  it("merges all three sources with project > user > plugin priority", async () => {
    await writeCmd(userDir, "ship", "user ship");
    await writeCmd(projectDir, "ship", "project ship");
    const installPath = path.join(pluginsRoot, "cache", "mp", "shipper", "1.0");
    const pluginCommandsDir = path.join(installPath, "commands");
    await fs.mkdir(pluginCommandsDir, { recursive: true });
    await writeCmd(pluginCommandsDir, "ship", "plugin ship");
    await writeCmd(pluginCommandsDir, "deploy", "plugin deploy");
    await fs.mkdir(pluginsRoot, { recursive: true });
    await fs.writeFile(
      path.join(pluginsRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "shipper@mp": [{ installPath }] },
      }),
    );

    const out = await discoverCommands({
      userCommandsDir: userDir,
      projectCwd: path.join(tmp, "project"),
      pluginsRoot,
    });
    // project ship wins over user/plugin; plugin deploy still appears
    const ship = out.find((c) => c.name === "ship");
    const deploy = out.find((c) => c.name === "deploy");
    expect(ship?.source).toBe("project");
    expect(ship?.description).toBe("project ship");
    expect(deploy?.source).toBe("plugin:shipper");
  });

  it("ignores non-.md files in the commands dirs", async () => {
    await writeCmd(userDir, "real", "real one");
    await fs.writeFile(path.join(userDir, "README.txt"), "not a command");
    const out = await discoverCommands({
      userCommandsDir: userDir,
      userSkillsDir: path.join(tmp, "missing-skills"),
      projectCwd: path.join(tmp, "no-project"),
      pluginsRoot,
    });
    expect(out.map((c) => c.name)).toEqual(["real"]);
  });
});
