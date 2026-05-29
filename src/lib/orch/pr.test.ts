import { describe, it, expect } from "vitest";
import {
  buildGhPrArgs,
  buildLsRemoteArgs,
  buildPushArgs,
  preparePr,
  renderPrResult,
  type PrDeps,
} from "./pr.js";

const baseDeps: PrDeps = {
  hasOrigin: async () => true,
  baseOnOrigin: async () => true,
  ghReady: async () => true,
  push: async () => {},
  createPr: async () => "https://github.com/o/r/pull/7\n",
  diffstat: async () => "2 files +30/-4",
};

const input = { repoRoot: "/repo", baseRef: "main", branch: "feat/x" };

describe("arg builders", () => {
  it("pushes with -u origin", () => {
    expect(buildPushArgs("/repo", "feat/x")).toEqual([
      "-C", "/repo", "push", "-u", "origin", "feat/x",
    ]);
  });
  it("uses --fill without a title and --title/--body with one", () => {
    expect(buildGhPrArgs("main", "feat/x")).toContain("--fill");
    const withTitle = buildGhPrArgs("main", "feat/x", "Add X");
    expect(withTitle).toContain("--title");
    expect(withTitle).toContain("Add X");
    expect(withTitle).not.toContain("--fill");
  });
  it("passes a non-empty body through as --body <body>", () => {
    const args = buildGhPrArgs("main", "feat/x", "Add X", "## Task\n\ndo the thing");
    const i = args.indexOf("--body");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("## Task\n\ndo the thing");
    expect(args).not.toContain("--fill");
  });
  it("keeps the title-without-body behavior (--body \"\")", () => {
    const args = buildGhPrArgs("main", "feat/x", "Add X");
    const i = args.indexOf("--body");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("");
  });
  it("ignores a body when there is no title (still --fill)", () => {
    const args = buildGhPrArgs("main", "feat/x", undefined, "some body");
    expect(args).toContain("--fill");
    expect(args).not.toContain("--body");
  });
  it("checks the base on origin with ls-remote --heads", () => {
    expect(buildLsRemoteArgs("/repo", "pm-head-harness")).toEqual([
      "-C", "/repo", "ls-remote", "--heads", "origin", "pm-head-harness",
    ]);
  });
});

describe("preparePr", () => {
  it("pushes + opens a PR when origin, base, and gh are ready", async () => {
    const calls: string[] = [];
    const r = await preparePr(input, {
      ...baseDeps,
      push: async (_r, b) => { calls.push(`push:${b}`); },
      createPr: async (_r, base, b) => { calls.push(`pr:${base}:${b}`); return "url-7"; },
    });
    expect(r).toEqual({ status: "created", url: "url-7", branch: "feat/x" });
    expect(calls).toEqual(["push:feat/x", "pr:main:feat/x"]);
  });

  it("threads input.body through to the createPr dep", async () => {
    let received: string | undefined = "UNSET";
    const r = await preparePr(
      { ...input, title: "Add X", body: "## Task\n\nimplement X" },
      {
        ...baseDeps,
        createPr: async (_r, _base, _b, _t, body) => {
          received = body;
          return "url-9";
        },
      },
    );
    expect(r).toEqual({ status: "created", url: "url-9", branch: "feat/x" });
    expect(received).toBe("## Task\n\nimplement X");
  });

  it("hands back a ready branch when the base isn't on origin (no raw gh error)", async () => {
    const calls: string[] = [];
    const r = await preparePr(
      { repoRoot: "/repo", baseRef: "pm-head-harness", branch: "feat/x" },
      {
        ...baseDeps,
        baseOnOrigin: async (_r, base) => { calls.push(`lsremote:${base}`); return false; },
        // A real gh against a local-only base would throw a GraphQL error — prove
        // we never reach it (and never push the human's WIP base or the head).
        push: async (_r, b) => { calls.push(`push:${b}`); },
        createPr: async () => { calls.push("pr"); throw new Error("Base ref must be a branch"); },
      },
    );
    expect(r.status).toBe("no_base");
    if (r.status === "no_base") {
      expect(r.branch).toBe("feat/x");
      expect(r.diffstat).toBe("2 files +30/-4");
      expect(r.message).toContain("pm-head-harness");
      expect(r.message).toContain("ready");
    }
    // Checked the base, then degraded — no push, no gh pr create.
    expect(calls).toEqual(["lsremote:pm-head-harness"]);
  });

  it("hands back a ready branch when there is no origin (never fails)", async () => {
    const pushed: string[] = [];
    const r = await preparePr(input, {
      ...baseDeps,
      hasOrigin: async () => false,
      push: async (_r, b) => { pushed.push(b); },
    });
    expect(r.status).toBe("no_remote");
    if (r.status === "no_remote") {
      expect(r.diffstat).toBe("2 files +30/-4");
      expect(r.message).toContain("ready");
    }
    // It must NOT push when there's no remote.
    expect(pushed).toHaveLength(0);
  });

  it("pushes but defers PR creation when gh isn't ready", async () => {
    const r = await preparePr(input, { ...baseDeps, ghReady: async () => false });
    expect(r.status).toBe("no_gh");
  });

  it("reports an error if the push/PR fails", async () => {
    const r = await preparePr(input, {
      ...baseDeps,
      push: async () => { throw new Error("auth"); },
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.message).toContain("auth");
  });
});

describe("renderPrResult", () => {
  it("renders each status", () => {
    expect(renderPrResult({ status: "created", url: "u", branch: "b" })).toContain("u");
    expect(
      renderPrResult({ status: "no_remote", branch: "b", diffstat: "d", message: "m" }),
    ).toContain("m");
    expect(
      renderPrResult({ status: "no_base", branch: "b", diffstat: "d", message: "m" }),
    ).toContain("m");
    expect(renderPrResult({ status: "error", branch: "b", message: "boom" })).toContain(
      "boom",
    );
  });
});
