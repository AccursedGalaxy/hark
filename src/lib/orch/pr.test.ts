import { describe, it, expect } from "vitest";
import {
  buildGhPrArgs,
  buildPushArgs,
  preparePr,
  renderPrResult,
  type PrDeps,
} from "./pr.js";

const baseDeps: PrDeps = {
  hasOrigin: async () => true,
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
});

describe("preparePr", () => {
  it("pushes + opens a PR when origin + gh are ready", async () => {
    const calls: string[] = [];
    const r = await preparePr(input, {
      ...baseDeps,
      push: async (_r, b) => { calls.push(`push:${b}`); },
      createPr: async (_r, base, b) => { calls.push(`pr:${base}:${b}`); return "url-7"; },
    });
    expect(r).toEqual({ status: "created", url: "url-7", branch: "feat/x" });
    expect(calls).toEqual(["push:feat/x", "pr:main:feat/x"]);
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
    expect(renderPrResult({ status: "error", branch: "b", message: "boom" })).toContain(
      "boom",
    );
  });
});
