import fs from "node:fs/promises";
import {
  CLAUDE_MD_BLOCK,
  HARK_BLOCK_END,
  HARK_BLOCK_START,
} from "./projectConstants.js";

export interface ApplyResult {
  // True when CLAUDE.md was created from scratch by this call.
  created: boolean;
  // True when the file already had a hark block and the body differed from
  // the new block (so we replaced it).
  replaced: boolean;
  // True when the file existed and the existing hark block already matched
  // the new content exactly — no write happened.
  unchanged: boolean;
  // True when CLAUDE.md existed but had no hark block — we appended.
  appended: boolean;
}

export function findHarkBlockRange(
  content: string,
): { startIdx: number; endIdx: number } | null {
  const startIdx = content.indexOf(HARK_BLOCK_START);
  if (startIdx === -1) return null;
  const endMarkerIdx = content.indexOf(HARK_BLOCK_END, startIdx);
  if (endMarkerIdx === -1) return null;
  return { startIdx, endIdx: endMarkerIdx + HARK_BLOCK_END.length };
}

function ensureSingleTrailingNewline(s: string): string {
  // Collapse any run of trailing newlines down to exactly one.
  return s.replace(/\n*$/, "\n");
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function applyManagedBlock(
  claudemdPath: string,
  block: string = CLAUDE_MD_BLOCK,
): Promise<ApplyResult> {
  const existing = await readIfExists(claudemdPath);

  if (existing === null) {
    // Missing file: write just the block with a single trailing newline.
    await fs.writeFile(claudemdPath, ensureSingleTrailingNewline(block), "utf8");
    return {
      created: true,
      replaced: false,
      unchanged: false,
      appended: false,
    };
  }

  const range = findHarkBlockRange(existing);

  if (range === null) {
    // Append: ensure existing content ends with a single newline, then add
    // one blank line separator before the block.
    const base = existing.endsWith("\n") ? existing : existing + "\n";
    const next = ensureSingleTrailingNewline(base + "\n" + block);
    await fs.writeFile(claudemdPath, next, "utf8");
    return {
      created: false,
      replaced: false,
      unchanged: false,
      appended: true,
    };
  }

  // Markers found: build the replacement file content.
  const before = existing.slice(0, range.startIdx);
  const after = existing.slice(range.endIdx);
  const replaced = before + block + after;
  const next = ensureSingleTrailingNewline(replaced);

  if (next === existing) {
    return {
      created: false,
      replaced: false,
      unchanged: true,
      appended: false,
    };
  }

  await fs.writeFile(claudemdPath, next, "utf8");
  return {
    created: false,
    replaced: true,
    unchanged: false,
    appended: false,
  };
}
