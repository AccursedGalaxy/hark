import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveTmuxPaneForPid, type TmuxPane } from "./pane.js";
import { dedupeBySessionId } from "./sessionList.js";
import {
  listPaneLocations,
  type PaneLocation,
} from "./tmuxLocations.js";
import { readSessionTitle } from "./transcript.js";

// Watcher-backed cache over everything `/api/sessions` needs. Before this,
// every poll (every client, every 3s) re-read all session files, probed every
// project directory for every session's transcript, tail-read every
// transcript for its title, and shelled out to tmux per session. The index
// keeps all of that warm and exposes an onChange signal so the server can
// push the session list over SSE instead of being polled.

export type SessionFile = {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  version: string;
  kind: "interactive" | "bg" | string;
  // Newer Claude Code emits "waiting" when the TUI is blocked on a prompt
  // (permission, AskUserQuestion, ExitPlanMode, trust dialog). Older versions
  // only set "busy" / "idle". Keep the union open with `string` so unknown
  // values flow through rather than getting silently dropped.
  status?: "busy" | "idle" | "waiting" | string;
  // Free-text hint that accompanies status="waiting" (e.g. "permission
  // prompt", "ask user question"). Surfaced for header chips.
  waitingFor?: string;
  name?: string;
};

export interface SessionIndexOptions {
  sessionsDir: string;
  projectsDir: string;
  // Watch-fire debounce before rescanning the sessions dir.
  debounceMs?: number;
  // How long a "no transcript for this session" answer stays cached. Found
  // paths are cached forever (a session's transcript never moves).
  negativeTtlMs?: number;
  paneTtlMs?: number;
  locationsTtlMs?: number;
  isAlive?: (pid: number) => boolean;
  resolvePane?: (pid: number) => Promise<TmuxPane | null>;
  listLocations?: () => Promise<Map<string, PaneLocation>>;
  readTitle?: (transcriptPath: string) => Promise<string | null>;
  now?: () => number;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SessionIndex {
  private readonly debounceMs: number;
  private readonly negativeTtlMs: number;
  private readonly paneTtlMs: number;
  private readonly locationsTtlMs: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly resolvePane: (pid: number) => Promise<TmuxPane | null>;
  private readonly listLocations: () => Promise<Map<string, PaneLocation>>;
  private readonly readTitle: (p: string) => Promise<string | null>;
  private readonly now: () => number;

  private watcher: FSWatcher | null = null;
  private watching = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private closed = false;

  // Parsed session files (pre-liveness). `null` until the first scan.
  private files: SessionFile[] | null = null;
  private scanInFlight: Promise<SessionFile[]> | null = null;
  private lastScanAt = 0;
  private lastScanJson = "";

  private transcriptPaths = new Map<
    string,
    { path: string | null; at: number }
  >();
  private titles = new Map<string, { mtimeMs: number; title: string | null }>();
  private panes = new Map<number, { pane: TmuxPane | null; at: number }>();
  private locations: {
    value: Map<string, PaneLocation>;
    at: number;
  } | null = null;
  private locationsInFlight: Promise<Map<string, PaneLocation>> | null = null;

  private changeSubscribers = new Set<() => void>();

  constructor(private opts: SessionIndexOptions) {
    this.debounceMs = opts.debounceMs ?? 150;
    this.negativeTtlMs = opts.negativeTtlMs ?? 2000;
    this.paneTtlMs = opts.paneTtlMs ?? 10_000;
    this.locationsTtlMs = opts.locationsTtlMs ?? 3000;
    this.isAlive = opts.isAlive ?? defaultIsAlive;
    this.resolvePane = opts.resolvePane ?? resolveTmuxPaneForPid;
    this.listLocations = opts.listLocations ?? listPaneLocations;
    this.readTitle = opts.readTitle ?? readSessionTitle;
    this.now = opts.now ?? Date.now;
  }

  /** Attach the directory watcher. Safe to call once at server start. */
  start(): void {
    try {
      this.watcher = watch(this.opts.sessionsDir, () => this.scheduleRescan());
      this.watcher.on("error", () => {
        // Directory vanished or watch backend gave up — fall back to
        // TTL-based rescans in listSessionFiles.
        this.watching = false;
      });
      this.watching = true;
    } catch {
      this.watching = false;
    }
  }

  close(): void {
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.changeSubscribers.clear();
  }

  /** Subscribe to "the session list probably changed" signals. */
  onChange(cb: () => void): () => void {
    this.changeSubscribers.add(cb);
    return () => this.changeSubscribers.delete(cb);
  }

  /**
   * Live sessions: parsed files filtered by process liveness (checked fresh
   * per call — a dead PID must never linger until the next watch fire),
   * deduped by sessionId, newest first.
   */
  async listSessions(): Promise<SessionFile[]> {
    const files = await this.ensureScanned();
    const alive = files.filter((f) => this.isAlive(f.pid));
    const deduped = dedupeBySessionId(alive);
    deduped.sort((a, b) => b.updatedAt - a.updatedAt);
    return deduped;
  }

  async findSession(sessionId: string): Promise<SessionFile | null> {
    const all = await this.listSessions();
    return all.find((s) => s.sessionId === sessionId) ?? null;
  }

  /**
   * sessionId → transcript JSONL path. Probing all project dirs is the
   * O(sessions×projects) hot path this kills: hits are cached forever,
   * misses for `negativeTtlMs` (a brand-new session writes its JSONL within
   * a couple of seconds).
   */
  async transcriptPathFor(sessionId: string): Promise<string | null> {
    const cached = this.transcriptPaths.get(sessionId);
    if (
      cached &&
      (cached.path !== null || this.now() - cached.at < this.negativeTtlMs)
    ) {
      return cached.path;
    }
    const found = await this.probeTranscript(sessionId);
    this.transcriptPaths.set(sessionId, { path: found, at: this.now() });
    return found;
  }

  /** Drop a cached transcript path (e.g. the file was deleted under us). */
  invalidateTranscriptPath(sessionId: string): void {
    this.transcriptPaths.delete(sessionId);
  }

  /**
   * Last `ai-title` in a transcript, re-tail-read only when the file's
   * mtime moved. One stat per call instead of a 32KB read.
   */
  async titleFor(transcriptPath: string): Promise<string | null> {
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(transcriptPath)).mtimeMs;
    } catch {
      this.titles.delete(transcriptPath);
      return null;
    }
    const cached = this.titles.get(transcriptPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.title;
    const title = await this.readTitle(transcriptPath);
    this.titles.set(transcriptPath, { mtimeMs, title });
    return title;
  }

  /**
   * pid → tmux pane with a short TTL. Used for the *list view only* — the
   * send-keys path must keep resolving fresh so input never lands in a
   * stale pane.
   */
  async paneFor(pid: number): Promise<TmuxPane | null> {
    const cached = this.panes.get(pid);
    if (cached && this.now() - cached.at < this.paneTtlMs) return cached.pane;
    const pane = await this.resolvePane(pid);
    this.panes.set(pid, { pane, at: this.now() });
    return pane;
  }

  async paneLocations(): Promise<Map<string, PaneLocation>> {
    if (this.locations && this.now() - this.locations.at < this.locationsTtlMs) {
      return this.locations.value;
    }
    if (!this.locationsInFlight) {
      this.locationsInFlight = this.listLocations()
        .then((value) => {
          this.locations = { value, at: this.now() };
          return value;
        })
        .finally(() => {
          this.locationsInFlight = null;
        });
    }
    return this.locationsInFlight;
  }

  /** Force a rescan now (test hook; also used by the debounce timer). */
  async rescan(): Promise<void> {
    const files = await this.scanSessionsDir();
    this.files = files;
    this.lastScanAt = this.now();
    const json = JSON.stringify(files);
    if (json !== this.lastScanJson) {
      this.lastScanJson = json;
      this.notifyChange();
    }
  }

  private async ensureScanned(): Promise<SessionFile[]> {
    // Watcher healthy → trust the cache. Degraded (watch failed) → rescan
    // when stale; the 30s client poll still keeps things converging.
    const stale =
      this.files === null ||
      (!this.watching && this.now() - this.lastScanAt > this.debounceMs * 2);
    if (stale) {
      if (!this.scanInFlight) {
        this.scanInFlight = this.scanSessionsDir().finally(() => {
          this.scanInFlight = null;
        });
      }
      const files = await this.scanInFlight;
      this.files = files;
      this.lastScanAt = this.now();
      this.lastScanJson = JSON.stringify(files);
    }
    return this.files!;
  }

  private scheduleRescan(): void {
    if (this.closed || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.rescan().catch(() => {});
    }, this.debounceMs);
  }

  private notifyChange(): void {
    for (const cb of this.changeSubscribers) {
      try {
        cb();
      } catch {
        /* skip broken subscriber */
      }
    }
  }

  private async scanSessionsDir(): Promise<SessionFile[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.opts.sessionsDir);
    } catch {
      return [];
    }
    const out: SessionFile[] = [];
    await Promise.all(
      entries
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          try {
            const raw = await fs.readFile(
              path.join(this.opts.sessionsDir, f),
              "utf8",
            );
            out.push(JSON.parse(raw) as SessionFile);
          } catch {
            /* mid-write or vanished — next fire catches it */
          }
        }),
    );
    // Stable order so the change-detection JSON compare doesn't false-fire
    // on readdir order.
    out.sort((a, b) => a.pid - b.pid);
    return out;
  }

  private async probeTranscript(sessionId: string): Promise<string | null> {
    let projects: string[];
    try {
      projects = await fs.readdir(this.opts.projectsDir);
    } catch {
      return null;
    }
    for (const p of projects) {
      const candidate = path.join(
        this.opts.projectsDir,
        p,
        `${sessionId}.jsonl`,
      );
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        /* try next */
      }
    }
    return null;
  }
}
