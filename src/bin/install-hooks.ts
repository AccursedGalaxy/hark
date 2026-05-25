#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildHookCommand,
  installHooks,
  type Settings,
  uninstallHooks,
} from "../lib/installHook.js";

type Mode = "install" | "uninstall";

function parseArgs(argv: string[]): { mode: Mode; url: string } {
  let mode: Mode = "install";
  let url = "http://localhost:3000/api/hook";
  for (const a of argv.slice(2)) {
    if (a === "--uninstall") mode = "uninstall";
    else if (a.startsWith("--url=")) url = a.slice("--url=".length);
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  return { mode, url };
}

function printHelp(): void {
  console.log(`Usage: install-hooks [--uninstall] [--url=URL]

Idempotently merges Notification + Stop + PermissionRequest hook entries
into ~/.claude/settings.json that POST to URL (default
http://localhost:3000/api/hook).

  --uninstall    Remove the managed entries.
  --url=URL      Hook endpoint URL (default localhost:3000/api/hook).
`);
}

async function readSettings(file: string): Promise<Settings> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Settings) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeSettings(file: string, value: Settings): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, json);
  await fs.rename(tmp, file);
}

async function main(): Promise<void> {
  const { mode, url } = parseArgs(process.argv);
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const before = await readSettings(settingsPath);
  const after =
    mode === "install" ? installHooks(before, url) : uninstallHooks(before, url);
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  if (beforeJson === afterJson) {
    console.log(
      mode === "install"
        ? `Already installed for ${url} — no changes.`
        : `Nothing to remove for ${url} — no changes.`,
    );
    return;
  }
  await writeSettings(settingsPath, after);
  console.log(
    mode === "install"
      ? `Installed Notification + Stop + PermissionRequest hooks → ${url}\n  ${buildHookCommand(url)}\n  ${settingsPath}`
      : `Removed managed hooks for ${url}\n  ${settingsPath}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
