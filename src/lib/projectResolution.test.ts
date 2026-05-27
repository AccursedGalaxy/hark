import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultDeps,
  resolveProjectFromCwd,
  type ResolveDeps,
} from "./projectResolution.js";

const execFile = promisify(execFileCb);

function stubGit(value: string | null): ResolveDeps {
  return {
    gitTopLevel: async () => value,
  };
}

describe("resolveProjectFromCwd", () => {
  it("resolves a repo root cwd", async () => {
    const info = await resolveProjectFromCwd("/tmp/myproj", stubGit("/tmp/myproj"));
    expect(info).toEqual({
      key: "/tmp/myproj",
      root: "/tmp/myproj",
      name: "myproj",
      planExists: false,
      planMtime: null,
    });
  });

  it("resolves a subdirectory inside a repo to the repo root", async () => {
    const info = await resolveProjectFromCwd(
      "/tmp/myproj/src/lib",
      stubGit("/tmp/myproj"),
    );
    expect(info).not.toBeNull();
    expect(info?.key).toBe("/tmp/myproj");
    expect(info?.root).toBe("/tmp/myproj");
    expect(info?.name).toBe("myproj");
  });

  it("returns null when not inside a repo", async () => {
    expect(await resolveProjectFromCwd("/tmp", stubGit(null))).toBeNull();
  });

  it("returns null on empty git output", async () => {
    expect(await resolveProjectFromCwd("/tmp", stubGit(""))).toBeNull();
  });

  it("strips trailing slash when computing the display name", async () => {
    const info = await resolveProjectFromCwd("/tmp/myproj", stubGit("/tmp/myproj/"));
    expect(info?.name).toBe("myproj");
  });
});

describe("defaultDeps.gitTopLevel (integration)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-project-res-"));
    // macOS prefixes tmpdir with /private/var/... vs /var/...; resolve so the
    // path we expect matches what git returns.
    tmpDir = await fs.realpath(tmpDir);
    await execFile("git", ["init", "-q"], { cwd: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns the repo root for a real git repo", async () => {
    const info = await resolveProjectFromCwd(tmpDir, defaultDeps);
    expect(info).not.toBeNull();
    expect(info?.root).toBe(tmpDir);
    expect(info?.name).toBe(path.basename(tmpDir));
    expect(info?.planExists).toBe(false);
    expect(info?.planMtime).toBeNull();
  });
});
