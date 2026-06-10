import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionIndex, type SessionFile } from "./sessionIndex.js";

function sessionJson(over: Partial<SessionFile> = {}): SessionFile {
  return {
    pid: 100,
    sessionId: "sid-1",
    cwd: "/tmp",
    startedAt: 1,
    updatedAt: 1,
    version: "1.0.0",
    kind: "interactive",
    ...over,
  };
}

async function waitFor(
  cond: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("SessionIndex", () => {
  let dir: string;
  let sessionsDir: string;
  let projectsDir: string;
  let index: SessionIndex | null;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-sindex-"));
    sessionsDir = path.join(dir, "sessions");
    projectsDir = path.join(dir, "projects");
    await fs.mkdir(sessionsDir);
    await fs.mkdir(projectsDir);
    index = null;
  });

  afterEach(async () => {
    index?.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeSession(name: string, data: SessionFile): Promise<void> {
    await fs.writeFile(
      path.join(sessionsDir, name),
      JSON.stringify(data),
    );
  }

  it("lists live sessions, filtering dead pids and deduping", async () => {
    await writeSession("1.json", sessionJson({ pid: 1, updatedAt: 5 }));
    await writeSession(
      "2.json",
      sessionJson({ pid: 2, sessionId: "sid-1", updatedAt: 9 }),
    );
    await writeSession(
      "3.json",
      sessionJson({ pid: 3, sessionId: "sid-2", updatedAt: 7 }),
    );
    await writeSession(
      "4.json",
      sessionJson({ pid: 4, sessionId: "sid-dead", updatedAt: 8 }),
    );
    index = new SessionIndex({
      sessionsDir,
      projectsDir,
      isAlive: (pid) => pid !== 4,
    });
    const sessions = await index.listSessions();
    // sid-1 deduped to the newest pid; dead pid 4 dropped; newest first.
    expect(sessions.map((s) => s.sessionId)).toEqual(["sid-1", "sid-2"]);
    expect(sessions[0].pid).toBe(2);
  });

  it("rescans on watch fires and notifies onChange", async () => {
    index = new SessionIndex({
      sessionsDir,
      projectsDir,
      debounceMs: 20,
      isAlive: () => true,
    });
    index.start();
    expect(await index.listSessions()).toHaveLength(0);

    let changes = 0;
    index.onChange(() => changes++);
    await writeSession("1.json", sessionJson());
    await waitFor(() => changes > 0);
    const sessions = await index.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("sid-1");
  });

  it("does not notify when a rescan finds no change", async () => {
    await writeSession("1.json", sessionJson());
    index = new SessionIndex({ sessionsDir, projectsDir, isAlive: () => true });
    await index.listSessions();
    let changes = 0;
    index.onChange(() => changes++);
    await index.rescan();
    expect(changes).toBe(0);
    await writeSession("1.json", sessionJson({ updatedAt: 99 }));
    await index.rescan();
    expect(changes).toBe(1);
  });

  it("caches transcript paths forever on hit, briefly on miss", async () => {
    let now = 1000;
    index = new SessionIndex({
      sessionsDir,
      projectsDir,
      negativeTtlMs: 2000,
      now: () => now,
    });
    // Miss cached: file appears right after the probe, but within the TTL
    // we still get the cached null.
    expect(await index.transcriptPathFor("sid-x")).toBeNull();
    const projDir = path.join(projectsDir, "proj");
    await fs.mkdir(projDir);
    const transcript = path.join(projDir, "sid-x.jsonl");
    await fs.writeFile(transcript, "");
    expect(await index.transcriptPathFor("sid-x")).toBeNull();
    // TTL expiry → re-probe finds it.
    now += 2001;
    expect(await index.transcriptPathFor("sid-x")).toBe(transcript);
    // Hits are sticky: even with the file gone the cached path is returned
    // (callers stat and invalidate explicitly).
    await fs.rm(transcript);
    expect(await index.transcriptPathFor("sid-x")).toBe(transcript);
    index.invalidateTranscriptPath("sid-x");
    now += 5000;
    expect(await index.transcriptPathFor("sid-x")).toBeNull();
  });

  it("re-reads titles only when the transcript mtime changes", async () => {
    const projDir = path.join(projectsDir, "proj");
    await fs.mkdir(projDir);
    const transcript = path.join(projDir, "sid-t.jsonl");
    await fs.writeFile(transcript, "x");
    let titleReads = 0;
    index = new SessionIndex({
      sessionsDir,
      projectsDir,
      readTitle: async () => {
        titleReads++;
        return `title-${titleReads}`;
      },
    });
    expect(await index.titleFor(transcript)).toBe("title-1");
    expect(await index.titleFor(transcript)).toBe("title-1");
    expect(titleReads).toBe(1);
    // Force an mtime change (some filesystems have coarse mtime resolution).
    await fs.utimes(transcript, new Date(), new Date(Date.now() + 5000));
    expect(await index.titleFor(transcript)).toBe("title-2");
    expect(titleReads).toBe(2);
  });

  it("caches pane lookups for the TTL", async () => {
    let now = 0;
    let resolves = 0;
    index = new SessionIndex({
      sessionsDir,
      projectsDir,
      paneTtlMs: 10_000,
      now: () => now,
      resolvePane: async () => {
        resolves++;
        return { socket: "s", paneId: `%${resolves}` };
      },
    });
    expect((await index.paneFor(1))?.paneId).toBe("%1");
    now += 5000;
    expect((await index.paneFor(1))?.paneId).toBe("%1");
    expect(resolves).toBe(1);
    now += 5001;
    expect((await index.paneFor(1))?.paneId).toBe("%2");
    expect(resolves).toBe(2);
  });

  it("caches pane locations for the TTL and coalesces concurrent calls", async () => {
    let now = 0;
    let lists = 0;
    index = new SessionIndex({
      sessionsDir,
      projectsDir,
      locationsTtlMs: 3000,
      now: () => now,
      listLocations: async () => {
        lists++;
        return new Map();
      },
    });
    await Promise.all([index.paneLocations(), index.paneLocations()]);
    expect(lists).toBe(1);
    now += 3001;
    await index.paneLocations();
    expect(lists).toBe(2);
  });
});
