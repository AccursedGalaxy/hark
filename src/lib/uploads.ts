import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface StoredUpload {
  name: string;
  path: string;
  size: number;
  mime: string;
}

export interface StoreUploadOptions {
  cacheRoot: string;
  sessionId: string;
  originalName: string;
  mime: string;
  data: Buffer;
  now?: number;
}

const MAX_NAME = 120;

export function sanitizeFilename(input: string): string {
  // Strip any directory components first — path separators or traversal
  // tokens have no business surviving into the on-disk name.
  const base = input.replace(/[\\/]/g, "_");
  // Collapse anything not in a friendly safelist.
  const safe = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[._-]+/, "");
  if (!safe || safe.replace(/[._-]/g, "") === "") return "file";
  if (safe.length <= MAX_NAME) return safe;
  // Cap length but keep the extension so file pickers stay happy.
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  return stem.slice(0, MAX_NAME - ext.length) + ext;
}

export function uploadRootFor(cacheRoot: string, sessionId: string): string {
  if (!sessionId || /[\\/]/.test(sessionId) || sessionId.includes("..")) {
    throw new Error(`invalid sessionId: ${sessionId}`);
  }
  return path.join(cacheRoot, sessionId);
}

export async function storeUpload(opts: StoreUploadOptions): Promise<StoredUpload> {
  const dir = uploadRootFor(opts.cacheRoot, opts.sessionId);
  await fs.mkdir(dir, { recursive: true });
  const safe = sanitizeFilename(opts.originalName);
  const ts = opts.now ?? Date.now();
  // Short random suffix prevents collisions when the user uploads two files
  // with the same name within the same millisecond (and also if `now` is
  // pinned in tests).
  const suffix = randomBytes(3).toString("hex");
  const filename = `${ts}-${suffix}-${safe}`;
  const full = path.join(dir, filename);
  await fs.writeFile(full, opts.data);
  return {
    name: opts.originalName,
    path: full,
    size: opts.data.length,
    mime: opts.mime,
  };
}
