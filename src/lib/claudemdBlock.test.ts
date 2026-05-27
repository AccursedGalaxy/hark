import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_MD_BLOCK,
  HARK_BLOCK_END,
  HARK_BLOCK_START,
} from "./projectConstants.js";
import { applyManagedBlock, findHarkBlockRange } from "./claudemdBlock.js";

describe("claudemdBlock", () => {
  let dir: string;
  let claudemdPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-claudemd-"));
    claudemdPath = path.join(dir, "CLAUDE.md");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe("findHarkBlockRange", () => {
    it("returns null when no markers are present", () => {
      expect(findHarkBlockRange("hello")).toBe(null);
    });

    it("returns null when only the start marker is present", () => {
      expect(findHarkBlockRange(`prefix ${HARK_BLOCK_START} no end`)).toBe(
        null,
      );
    });

    it("returns null when only the end marker is present", () => {
      expect(findHarkBlockRange(`prefix ${HARK_BLOCK_END} only end`)).toBe(
        null,
      );
    });

    it("finds a complete block and brackets it including markers", () => {
      const before = "user content\n";
      const block = `${HARK_BLOCK_START}\nbody\n${HARK_BLOCK_END}`;
      const after = "\ntrailing";
      const content = before + block + after;
      const range = findHarkBlockRange(content);
      expect(range).not.toBe(null);
      expect(range!.startIdx).toBe(before.length);
      expect(range!.endIdx).toBe(before.length + block.length);
      expect(content.slice(range!.startIdx, range!.endIdx)).toBe(block);
    });
  });

  describe("applyManagedBlock", () => {
    it("creates CLAUDE.md when missing", async () => {
      const result = await applyManagedBlock(claudemdPath);
      expect(result.created).toBe(true);
      expect(result.replaced).toBe(false);
      expect(result.unchanged).toBe(false);
      expect(result.appended).toBe(false);
      const content = await fs.readFile(claudemdPath, "utf8");
      expect(content).toContain(CLAUDE_MD_BLOCK);
    });

    it("appends when file exists without markers", async () => {
      const original = "# Project rules\n\nDo the thing.\n";
      await fs.writeFile(claudemdPath, original, "utf8");
      const result = await applyManagedBlock(claudemdPath);
      expect(result.appended).toBe(true);
      expect(result.created).toBe(false);
      expect(result.replaced).toBe(false);
      expect(result.unchanged).toBe(false);
      const content = await fs.readFile(claudemdPath, "utf8");
      // Original content preserved at the top.
      expect(content.startsWith("# Project rules\n\nDo the thing.\n")).toBe(
        true,
      );
      // Block ends the file.
      expect(content).toContain(CLAUDE_MD_BLOCK);
      expect(content.trimEnd().endsWith(HARK_BLOCK_END)).toBe(true);
    });

    it("replaces the block body when markers exist", async () => {
      const seed = `prefix\n${HARK_BLOCK_START}\nOLD BODY\n${HARK_BLOCK_END}\nsuffix\n`;
      await fs.writeFile(claudemdPath, seed, "utf8");
      const result = await applyManagedBlock(claudemdPath);
      expect(result.replaced).toBe(true);
      expect(result.created).toBe(false);
      expect(result.appended).toBe(false);
      expect(result.unchanged).toBe(false);
      const content = await fs.readFile(claudemdPath, "utf8");
      expect(content).toContain("prefix");
      expect(content).toContain("suffix");
      expect(content).not.toContain("OLD BODY");
      expect(content).toContain(CLAUDE_MD_BLOCK);
    });

    it("is idempotent — does not rewrite when content already matches", async () => {
      await applyManagedBlock(claudemdPath);
      const first = await fs.stat(claudemdPath);
      await new Promise((r) => setTimeout(r, 50));
      const result = await applyManagedBlock(claudemdPath);
      expect(result.unchanged).toBe(true);
      expect(result.created).toBe(false);
      expect(result.replaced).toBe(false);
      expect(result.appended).toBe(false);
      const second = await fs.stat(claudemdPath);
      expect(second.mtimeMs).toBe(first.mtimeMs);
    });

    it("preserves user content above and below markers", async () => {
      const seed = `USER ABOVE\n${HARK_BLOCK_START}\nold\n${HARK_BLOCK_END}\nUSER BELOW\n`;
      await fs.writeFile(claudemdPath, seed, "utf8");
      await applyManagedBlock(claudemdPath);
      const content = await fs.readFile(claudemdPath, "utf8");
      expect(content).toContain("USER ABOVE");
      expect(content).toContain("USER BELOW");
      expect(content).not.toContain("\nold\n");
      expect(content).toContain(CLAUDE_MD_BLOCK);
    });

    it("accepts a custom block string", async () => {
      const custom = `${HARK_BLOCK_START}\nhi\n${HARK_BLOCK_END}`;
      const result = await applyManagedBlock(claudemdPath, custom);
      expect(result.created).toBe(true);
      const content = await fs.readFile(claudemdPath, "utf8");
      expect(content).toContain(custom);
    });

    it("file ends with exactly one trailing newline after create", async () => {
      await applyManagedBlock(claudemdPath);
      const content = await fs.readFile(claudemdPath, "utf8");
      expect(content.endsWith("\n")).toBe(true);
      expect(content.endsWith("\n\n")).toBe(false);
    });

    it("file ends with exactly one trailing newline after append", async () => {
      await fs.writeFile(claudemdPath, "# Project rules\n", "utf8");
      await applyManagedBlock(claudemdPath);
      const content = await fs.readFile(claudemdPath, "utf8");
      expect(content.endsWith("\n")).toBe(true);
      expect(content.endsWith("\n\n")).toBe(false);
    });

    it("file ends with exactly one trailing newline after replace", async () => {
      const seed = `prefix\n${HARK_BLOCK_START}\nOLD\n${HARK_BLOCK_END}\nsuffix\n`;
      await fs.writeFile(claudemdPath, seed, "utf8");
      await applyManagedBlock(claudemdPath);
      const content = await fs.readFile(claudemdPath, "utf8");
      expect(content.endsWith("\n")).toBe(true);
      expect(content.endsWith("\n\n")).toBe(false);
    });

    it("handles append when existing file lacks a trailing newline", async () => {
      await fs.writeFile(claudemdPath, "no trailing newline", "utf8");
      const result = await applyManagedBlock(claudemdPath);
      expect(result.appended).toBe(true);
      const content = await fs.readFile(claudemdPath, "utf8");
      expect(content.startsWith("no trailing newline\n")).toBe(true);
      expect(content).toContain(CLAUDE_MD_BLOCK);
      expect(content.endsWith("\n")).toBe(true);
      expect(content.endsWith("\n\n")).toBe(false);
    });
  });
});
