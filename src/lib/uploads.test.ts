import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  sanitizeFilename,
  uploadRootFor,
  storeUpload,
} from "./uploads.js";

describe("sanitizeFilename", () => {
  it("strips path separators", () => {
    expect(sanitizeFilename("../etc/passwd")).toBe("etc_passwd");
    expect(sanitizeFilename("a/b\\c.png")).toBe("a_b_c.png");
  });

  it("collapses unsafe characters but preserves extension", () => {
    expect(sanitizeFilename("hello world!.png")).toBe("hello_world_.png");
  });

  it("falls back when the result would be empty", () => {
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename("...")).toBe("file");
  });

  it("caps very long names", () => {
    const long = "a".repeat(300) + ".txt";
    const out = sanitizeFilename(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(".txt")).toBe(true);
  });
});

describe("uploadRootFor", () => {
  it("namespaces under a per-session directory in the cache root", () => {
    const root = uploadRootFor("/tmp/hark-cache", "abc-123");
    expect(root).toBe(path.join("/tmp/hark-cache", "abc-123"));
  });

  it("rejects session ids containing path traversal", () => {
    expect(() => uploadRootFor("/tmp/hark-cache", "../escape")).toThrow();
    expect(() => uploadRootFor("/tmp/hark-cache", "a/b")).toThrow();
  });
});

describe("storeUpload", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hark-upload-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("writes the file under <root>/<sessionId>/<timestamp>-<safename>", async () => {
    const buf = Buffer.from("hello world");
    const meta = await storeUpload({
      cacheRoot: tmp,
      sessionId: "sess-1",
      originalName: "note.txt",
      mime: "text/plain",
      data: buf,
      now: 1700000000000,
    });

    expect(meta.name).toBe("note.txt");
    expect(meta.mime).toBe("text/plain");
    expect(meta.size).toBe(buf.length);
    expect(meta.path.startsWith(path.join(tmp, "sess-1") + path.sep)).toBe(true);
    const content = await fs.readFile(meta.path);
    expect(content.equals(buf)).toBe(true);
  });

  it("avoids collisions when two files share a name", async () => {
    const a = await storeUpload({
      cacheRoot: tmp,
      sessionId: "s",
      originalName: "x.png",
      mime: "image/png",
      data: Buffer.from("a"),
      now: 1700000000000,
    });
    const b = await storeUpload({
      cacheRoot: tmp,
      sessionId: "s",
      originalName: "x.png",
      mime: "image/png",
      data: Buffer.from("b"),
      now: 1700000000000,
    });
    expect(a.path).not.toBe(b.path);
  });
});
