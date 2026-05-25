#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderUnit, unitInstallPath } from "../lib/serviceUnit.js";

type Mode = "install" | "uninstall" | "print";

interface Args {
  mode: Mode;
  installDir: string;
  nodeBinary: string;
  noReload: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function parseArgs(argv: string[]): Args {
  let mode: Mode = "install";
  let installDir = PROJECT_ROOT;
  let nodeBinary = process.execPath;
  let noReload = false;
  for (const a of argv.slice(2)) {
    if (a === "--uninstall") mode = "uninstall";
    else if (a === "--print") mode = "print";
    else if (a.startsWith("--install-dir=")) installDir = a.slice("--install-dir=".length);
    else if (a.startsWith("--node=")) nodeBinary = a.slice("--node=".length);
    else if (a === "--no-reload") noReload = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  return { mode, installDir, nodeBinary, noReload };
}

function printHelp(): void {
  console.log(`Usage: install-service [--uninstall|--print] [--install-dir=PATH] [--node=PATH] [--no-reload]

Writes a templated hark.service unit to ~/.config/systemd/user/hark.service
and runs \`systemctl --user daemon-reload\`. Then enable it with:

  systemctl --user enable --now hark

Options:
  --uninstall       Remove the unit (disables it first).
  --print           Print the rendered unit to stdout without touching disk.
  --install-dir     Project directory (default: ${PROJECT_ROOT}).
  --node            Node binary path (default: \`process.execPath\`).
  --no-reload       Skip the systemctl daemon-reload call after writing.
`);
}

function runSystemctl(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile("systemctl", args, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: stderr ?? "" });
    });
  });
}

async function readTemplate(): Promise<string> {
  const templatePath = path.join(PROJECT_ROOT, "systemd", "hark.service.template");
  return fs.readFile(templatePath, "utf8");
}

async function writeUnit(unitPath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  const tmp = `${unitPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, contents);
  await fs.rename(tmp, unitPath);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const unitPath = unitInstallPath(os.homedir());

  if (args.mode === "print") {
    const template = await readTemplate();
    process.stdout.write(
      renderUnit({
        template,
        installDir: args.installDir,
        nodeBinary: args.nodeBinary,
      }),
    );
    return;
  }

  if (args.mode === "uninstall") {
    if (!args.noReload) {
      const stop = await runSystemctl(["--user", "disable", "--now", "hark"]);
      if (!stop.ok && stop.stderr) console.error(stop.stderr.trim());
    }
    try {
      await fs.unlink(unitPath);
      console.log(`Removed ${unitPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.log(`No unit at ${unitPath} — nothing to do.`);
      } else {
        throw err;
      }
    }
    if (!args.noReload) {
      await runSystemctl(["--user", "daemon-reload"]);
    }
    return;
  }

  const template = await readTemplate();
  const contents = renderUnit({
    template,
    installDir: args.installDir,
    nodeBinary: args.nodeBinary,
  });
  await writeUnit(unitPath, contents);
  console.log(`Wrote ${unitPath}`);

  if (!args.noReload) {
    const reload = await runSystemctl(["--user", "daemon-reload"]);
    if (!reload.ok) {
      console.error(
        "systemctl --user daemon-reload failed; reload it manually before enabling.",
      );
      if (reload.stderr) console.error(reload.stderr.trim());
    }
  }

  console.log(`\nNext steps:
  npm run build                       # produce dist/server.js the unit references
  systemctl --user enable --now hark
  systemctl --user status hark`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
