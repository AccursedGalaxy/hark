import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearTrust, mergeTrust, isTrusted } from "./trust.js";

// ---- Pure merge ------------------------------------------------------------

describe("mergeTrust", () => {
  it("sets hasTrustDialogAccepted for an exact worktree path", () => {
    const out = mergeTrust({}, "/home/u/.hark/worktrees/app/orch-1/head");
    expect(
      out.projects["/home/u/.hark/worktrees/app/orch-1/head"]
        .hasTrustDialogAccepted,
    ).toBe(true);
  });

  it("preserves oauthAccount and other top-level keys untouched", () => {
    const existing = {
      oauthAccount: { id: "acc-123", email: "u@example.com" },
      numStartups: 42,
      tipsHistory: { a: 1 },
    };
    const out = mergeTrust(existing, "/wt/head");
    expect(out.oauthAccount).toEqual({ id: "acc-123", email: "u@example.com" });
    expect(out.numStartups).toBe(42);
    expect(out.tipsHistory).toEqual({ a: 1 });
    expect(out.projects["/wt/head"].hasTrustDialogAccepted).toBe(true);
  });

  it("preserves sibling project entries and merges into an existing one", () => {
    const existing = {
      projects: {
        "/some/other/repo": { hasTrustDialogAccepted: true, history: ["x"] },
        "/wt/head": { allowedTools: ["Bash"] },
      },
    };
    const out = mergeTrust(existing, "/wt/head");
    // Sibling untouched.
    expect(out.projects["/some/other/repo"]).toEqual({
      hasTrustDialogAccepted: true,
      history: ["x"],
    });
    // Existing per-project fields preserved, flag added.
    expect(out.projects["/wt/head"]).toEqual({
      allowedTools: ["Bash"],
      hasTrustDialogAccepted: true,
    });
  });

  it("does not mutate the input object", () => {
    const existing = { projects: { "/a": { hasTrustDialogAccepted: true } } };
    const snapshot = JSON.parse(JSON.stringify(existing));
    mergeTrust(existing, "/wt/head");
    expect(existing).toEqual(snapshot);
  });
});

describe("isTrusted", () => {
  it("is true only when the exact path is accepted", () => {
    const cfg = { projects: { "/wt/head": { hasTrustDialogAccepted: true } } };
    expect(isTrusted(cfg, "/wt/head")).toBe(true);
    expect(isTrusted(cfg, "/wt/other")).toBe(false);
    expect(isTrusted({}, "/wt/head")).toBe(false);
  });
});

// ---- Atomic IO -------------------------------------------------------------

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-trust-"));
  configPath = path.join(dir, ".claude.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("clearTrust", () => {
  it("creates the config when it doesn't exist", async () => {
    await clearTrust("/wt/head", { configPath });
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(raw.projects["/wt/head"].hasTrustDialogAccepted).toBe(true);
  });

  it("merges into an existing config without clobbering oauthAccount", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        oauthAccount: { id: "acc-9" },
        projects: { "/old": { hasTrustDialogAccepted: true } },
      }),
      "utf8",
    );
    await clearTrust("/wt/head", { configPath });
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(raw.oauthAccount).toEqual({ id: "acc-9" });
    expect(raw.projects["/old"].hasTrustDialogAccepted).toBe(true);
    expect(raw.projects["/wt/head"].hasTrustDialogAccepted).toBe(true);
  });

  it("leaves no temp file behind after the atomic write", async () => {
    await clearTrust("/wt/head", { configPath });
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([".claude.json"]);
  });

  it("is idempotent — running twice keeps a single accepted entry", async () => {
    await clearTrust("/wt/head", { configPath });
    await clearTrust("/wt/head", { configPath });
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(Object.keys(raw.projects)).toEqual(["/wt/head"]);
    expect(raw.projects["/wt/head"].hasTrustDialogAccepted).toBe(true);
  });
});
