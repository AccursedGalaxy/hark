import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// We keep this list small — it's a "did you mean one of these" hint, not a
// full project browser. 20 entries is plenty to cover the active rotation.
const MAX_ENTRIES = 20;

export interface RecentDirsStore {
  dirs: string[];
}

function defaultStorePath(): string {
  const root =
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(root, "hark", "recent-dirs.json");
}

// Move `dir` to the front of the list, dropping the oldest tail if needed.
// Case-insensitive on the OS but we preserve the user's exact spelling.
export function promoteDir(list: string[], dir: string, max = MAX_ENTRIES): string[] {
  const trimmed = dir.trim();
  if (!trimmed) return list;
  const without = list.filter((d) => d !== trimmed);
  without.unshift(trimmed);
  return without.slice(0, max);
}

export async function readRecentDirs(
  storePath = defaultStorePath(),
): Promise<string[]> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as RecentDirsStore;
    return Array.isArray(parsed.dirs)
      ? parsed.dirs.filter((d): d is string => typeof d === "string")
      : [];
  } catch {
    return [];
  }
}

export async function recordSpawnedDir(
  dir: string,
  storePath = defaultStorePath(),
): Promise<void> {
  const existing = await readRecentDirs(storePath);
  const next = promoteDir(existing, dir);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify({ dirs: next }, null, 2),
    "utf8",
  );
}

// Compact the persisted list with the cwds of currently-live sessions, with
// live entries pinned to the top (they're the strongest "useful right now"
// signal). Returns unique entries, capped at `max`.
export function mergeSuggestions(
  liveCwds: string[],
  recent: string[],
  max = MAX_ENTRIES,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (d: string) => {
    const t = d.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const d of liveCwds) push(d);
  for (const d of recent) push(d);
  return out.slice(0, max);
}
