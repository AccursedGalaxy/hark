import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mergeSuggestions,
  promoteDir,
  readRecentDirs,
  recordSpawnedDir,
} from "./recentDirs.js";

describe("promoteDir", () => {
  it("adds a new entry to the front", () => {
    expect(promoteDir(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("moves an existing entry to the front without duplicating", () => {
    expect(promoteDir(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  it("trims and ignores empty input", () => {
    expect(promoteDir(["a"], "   ")).toEqual(["a"]);
    expect(promoteDir(["a"], "  b  ")).toEqual(["b", "a"]);
  });

  it("drops the oldest tail when the list exceeds max", () => {
    expect(promoteDir(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

describe("mergeSuggestions", () => {
  it("pins live cwds before persisted history", () => {
    expect(mergeSuggestions(["live1", "live2"], ["histA", "live1"]))
      .toEqual(["live1", "live2", "histA"]);
  });

  it("dedupes within each input", () => {
    expect(mergeSuggestions(["a", "a"], ["b", "b"])).toEqual(["a", "b"]);
  });

  it("respects the max cap", () => {
    expect(mergeSuggestions(["a", "b"], ["c", "d"], 2)).toEqual(["a", "b"]);
  });
});

describe("recordSpawnedDir / readRecentDirs round-trip", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-recent-"));
    storePath = path.join(tmpDir, "recent-dirs.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty list when no file exists", async () => {
    expect(await readRecentDirs(storePath)).toEqual([]);
  });

  it("appends and reads back in LRU order", async () => {
    await recordSpawnedDir("/a", storePath);
    await recordSpawnedDir("/b", storePath);
    await recordSpawnedDir("/a", storePath); // bumps /a to front
    expect(await readRecentDirs(storePath)).toEqual(["/a", "/b"]);
  });

  it("survives a corrupt store file", async () => {
    await fs.writeFile(storePath, "{ not json", "utf8");
    expect(await readRecentDirs(storePath)).toEqual([]);
  });
});
