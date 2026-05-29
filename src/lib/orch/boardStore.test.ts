import { describe, it, expect } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BoardStore,
  MIGRATIONS,
  SCHEMA_VERSION,
  newTaskId,
  parseFieldAssignments,
  runMigrations,
  type Migration,
} from "./boardStore.js";

// ---- Field parsing (pure) --------------------------------------------------

describe("parseFieldAssignments", () => {
  it("parses field=value tokens into camelCase fields", () => {
    const r = parseFieldAssignments(["status=ready", "assignee=coder", "depends_on=task-1"]);
    expect("fields" in r && r.fields).toEqual({
      status: "ready",
      assignee: "coder",
      dependsOn: "task-1",
    });
  });

  it("accepts camelCase aliases for the snake_case columns", () => {
    const r = parseFieldAssignments(["dependsOn=t-1", "orchId=o-1", "agentId=a-1"]);
    expect("fields" in r && r.fields).toEqual({
      dependsOn: "t-1",
      orchId: "o-1",
      agentId: "a-1",
    });
  });

  it("treats an empty value as a clear (null)", () => {
    const r = parseFieldAssignments(["assignee="]);
    expect("fields" in r && r.fields).toEqual({ assignee: null });
  });

  it("rejects an unknown field", () => {
    const r = parseFieldAssignments(["nope=1"]);
    expect("error" in r && r.error).toMatch(/unknown field "nope"/);
  });

  it("rejects an invalid status", () => {
    const r = parseFieldAssignments(["status=banana"]);
    expect("error" in r && r.error).toMatch(/invalid status "banana"/);
  });

  it("rejects a token without =", () => {
    const r = parseFieldAssignments(["statusready"]);
    expect("error" in r && r.error).toMatch(/expected field=value/);
  });
});

// ---- Schema ----------------------------------------------------------------

describe("BoardStore schema", () => {
  it("applies idempotently and records the schema version", () => {
    const db = new BoardStore(":memory:");
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("re-opening an existing DB preserves the task source of truth", () => {
    const dir = mkdtempSync(join(tmpdir(), "hark-board-"));
    const file = join(dir, "board.db");
    try {
      const a = new BoardStore(file);
      a.setTask("task-1", { title: "persisted", status: "ready" });
      a.close();
      const b = new BoardStore(file);
      expect(b.schemaVersion()).toBe(SCHEMA_VERSION);
      const t = b.getTask("task-1");
      expect(t?.title).toBe("persisted");
      expect(t?.status).toBe("ready");
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- Schema migration: the source-of-truth durability promise --------------

describe("schema migrations", () => {
  // SF-1: a schema bump must EVOLVE an existing board.db, not rebuild it. Seed a
  // db at v1 with real rows + history, then run a v2 migration (an ALTER that
  // adds a column) against the SAME file. The rows + events must survive intact,
  // the new column must be present, and user_version must advance to 2.
  it("a v1->v2 bump evolves an existing db with real rows, losing no data", () => {
    const dir = mkdtempSync(join(tmpdir(), "hark-board-migrate-"));
    const file = join(dir, "board.db");
    try {
      // Seed v1 with genuine data through the normal store API (rows + events).
      const v1 = new BoardStore(file);
      expect(v1.schemaVersion()).toBe(1);
      v1.setTask("task-1", { title: "durable", status: "ready", assignee: "coder" });
      v1.setTask("task-2", { title: "second", status: "in-progress" });
      v1.setTask("task-1", { status: "review" }); // a second event on task-1
      v1.close();

      // A synthetic forward migration to v2: add a column WITHOUT touching rows.
      const addLabels: Migration = {
        to: 2,
        up: (db) => db.exec("ALTER TABLE tasks ADD COLUMN labels TEXT"),
      };

      // Run the full ordered list (v1 is skipped — already applied; v2 runs).
      const raw = new DatabaseSync(file);
      raw.exec("PRAGMA journal_mode = WAL");
      raw.exec("PRAGMA busy_timeout = 5000");
      runMigrations(raw, [...MIGRATIONS, addLabels]);

      // Version advanced.
      const ver = raw.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(ver.user_version).toBe(2);
      // New shape present.
      const cols = (raw.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols).toContain("labels");
      // Old rows survived byte-for-byte (the migration touched only the schema).
      const t1 = raw.prepare("SELECT * FROM tasks WHERE id = ?").get("task-1") as Record<
        string,
        unknown
      >;
      expect(t1.title).toBe("durable");
      expect(t1.status).toBe("review");
      expect(t1.assignee).toBe("coder");
      expect(t1.labels).toBeNull(); // new column defaults to null on existing rows
      // History survived too — created + the status change.
      const events = raw
        .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id")
        .all("task-1") as { kind: string }[];
      expect(events.map((e) => e.kind)).toEqual(["created", "set"]);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A migration body that throws must leave the version (and the data) exactly
  // where it was — user_version never leads the data, so a failed bump is safe
  // to retry after the bug is fixed.
  it("a failing migration rolls back and does not advance the version", () => {
    const dir = mkdtempSync(join(tmpdir(), "hark-board-migfail-"));
    const file = join(dir, "board.db");
    try {
      const v1 = new BoardStore(file);
      v1.setTask("task-1", { title: "keep me" });
      v1.close();

      const boom: Migration = {
        to: 2,
        up: (db) => {
          db.exec("ALTER TABLE tasks ADD COLUMN half_done TEXT");
          throw new Error("migration blew up mid-way");
        },
      };

      const raw = new DatabaseSync(file);
      raw.exec("PRAGMA journal_mode = WAL");
      raw.exec("PRAGMA busy_timeout = 5000");
      expect(() => runMigrations(raw, [...MIGRATIONS, boom])).toThrow(/blew up/);

      // Rolled back: version still 1, the half-added column is gone, row intact.
      const ver = raw.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(ver.user_version).toBe(1);
      const cols = (raw.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols).not.toContain("half_done");
      const t1 = raw.prepare("SELECT * FROM tasks WHERE id = ?").get("task-1") as {
        title: string;
      };
      expect(t1.title).toBe("keep me");
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A db whose version is AHEAD of the build's newest migration is a hard error:
  // an old build must refuse to open a newer source-of-truth file, not mangle it.
  it("refuses to open a db newer than the build understands", () => {
    const dir = mkdtempSync(join(tmpdir(), "hark-board-newer-"));
    const file = join(dir, "board.db");
    try {
      const raw = new DatabaseSync(file);
      raw.exec("PRAGMA user_version = 999");
      expect(() => runMigrations(raw, MIGRATIONS)).toThrow(/never downgrade/);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- Idempotency: the headline correctness property ------------------------

describe("setTask idempotency", () => {
  it("a re-applied set is a true no-op — no updated_at bump, no new event", () => {
    // A controllable clock: if a second write happened, updated_at would jump.
    let t = 1000;
    const db = new BoardStore(":memory:", () => t);

    const r1 = db.setTask("t1", { status: "ready", title: "X" });
    expect(r1.changed).toBe(true);
    expect(r1.task.updatedAt).toBe(1000);

    t = 2000; // advance — a real second write WOULD stamp 2000
    const r2 = db.setTask("t1", { status: "ready", title: "X" });
    const r3 = db.setTask("t1", { status: "ready", title: "X" });

    expect(r2.changed).toBe(false);
    expect(r3.changed).toBe(false);
    // The row is untouched — updated_at stays at the first write's stamp.
    expect(r2.task.updatedAt).toBe(1000);
    expect(r3.task).toEqual(r1.task);
    // Exactly ONE event (the create); no-op sets append nothing.
    const events = db.getEvents("t1");
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("created");
    db.close();
  });

  it("N repeated applications == one application (row + events identical)", () => {
    const db = new BoardStore(":memory:", () => 42);
    // One application as the reference.
    const ref = new BoardStore(":memory:", () => 42);
    ref.setTask("t", { status: "in-progress", assignee: "coder", title: "build" });
    const refTask = ref.getTask("t");
    const refEvents = ref.getEvents("t");

    // N applications of the identical set.
    for (let i = 0; i < 50; i++) {
      db.setTask("t", { status: "in-progress", assignee: "coder", title: "build" });
    }
    expect(db.listTasks()).toHaveLength(1);
    expect(db.getTask("t")).toEqual(refTask);
    const events = db.getEvents("t");
    expect(events).toHaveLength(refEvents.length); // == 1 (just the create)
    expect(events).toHaveLength(1);
    db.close();
    ref.close();
  });

  it("a genuine change DOES bump updated_at and append exactly one event", () => {
    let t = 1000;
    const db = new BoardStore(":memory:", () => t);
    db.setTask("t1", { status: "ready" });
    t = 3000;
    const r = db.setTask("t1", { status: "review" });
    expect(r.changed).toBe(true);
    expect(r.task.status).toBe("review");
    expect(r.task.updatedAt).toBe(3000);
    const events = db.getEvents("t1");
    expect(events).toHaveLength(2); // created + set
    expect(events[1].kind).toBe("set");
    expect(events[1].data).toEqual({ status: "review" });
    db.close();
  });

  it("only the differing columns are written when a multi-field set partially overlaps", () => {
    let t = 1;
    const db = new BoardStore(":memory:", () => t);
    db.setTask("t1", { status: "ready", assignee: "coder" });
    t = 2;
    // status already 'ready' — only assignee changes; the event records just the diff.
    const r = db.setTask("t1", { status: "ready", assignee: "tester" });
    expect(r.changed).toBe(true);
    const events = db.getEvents("t1");
    expect(events[1].data).toEqual({ assignee: "tester" });
    db.close();
  });

  it("closing stamps closed_at; re-closing is a no-op that keeps the stamp", () => {
    let t = 1000;
    const db = new BoardStore(":memory:", () => t);
    db.setTask("t1", { title: "x" });
    t = 5000;
    const closed = db.setTask("t1", { status: "done" });
    expect(closed.task.closedAt).toBe(5000);
    t = 9000;
    const reclosed = db.setTask("t1", { status: "done" });
    expect(reclosed.changed).toBe(false);
    expect(reclosed.task.closedAt).toBe(5000); // unchanged
    db.close();
  });

  it("moving a task out of done clears closed_at", () => {
    let t = 1;
    const db = new BoardStore(":memory:", () => t);
    db.setTask("t1", { status: "done" });
    expect(db.getTask("t1")?.closedAt).toBe(1);
    t = 2;
    db.setTask("t1", { status: "review" });
    expect(db.getTask("t1")?.closedAt).toBeNull();
    db.close();
  });
});

// ---- Listing + filtering ---------------------------------------------------

describe("listTasks", () => {
  it("filters by status / assignee / workstream / orch", () => {
    const db = new BoardStore(":memory:", () => 1);
    db.setTask("a", { status: "ready", assignee: "coder", workstream: "board" });
    db.setTask("b", { status: "done", assignee: "tester", workstream: "board" });
    db.setTask("c", { status: "ready", assignee: "coder", workstream: "io" });
    expect(db.listTasks({ status: "ready" }).map((t) => t.id)).toEqual(["a", "c"]);
    expect(db.listTasks({ assignee: "tester" }).map((t) => t.id)).toEqual(["b"]);
    expect(db.listTasks({ workstream: "board" }).map((t) => t.id)).toEqual(["a", "b"]);
    db.close();
  });
});

// ---- Append-integrity under TRUE concurrency (the second headline) ---------

// A CommonJS worker (eval) that opens the SAME db file and appends `count`
// events to `taskId`. Runs in its own thread, so multiple instances genuinely
// contend on the sqlite file — exercising WAL + busy_timeout, not just
// single-threaded interleaving.
const APPENDER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.dbPath);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA journal_mode = WAL');
const stmt = db.prepare(
  'INSERT INTO task_events (task_id, ts, kind, message, data_json) VALUES (?, ?, ?, ?, ?)'
);
for (let i = 0; i < workerData.count; i++) {
  stmt.run(workerData.taskId, Date.now(), 'append', 'w' + workerData.wid + '-' + i, null);
}
db.close();
parentPort.postMessage('done');
`;

function runAppenders(
  dbPath: string,
  workers: { wid: number; count: number; taskId: string }[],
): Promise<void[]> {
  return Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(APPENDER, {
            eval: true,
            workerData: { dbPath, ...w },
          });
          worker.on("message", () => resolve());
          worker.on("error", reject);
          worker.on("exit", (code) => {
            if (code !== 0) reject(new Error(`worker exited ${code}`));
          });
        }),
    ),
  );
}

describe("task_events append-integrity under concurrent writers", () => {
  it("loses no append and overwrites none when 4 threads append to the SAME task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hark-board-conc-"));
    const file = join(dir, "board.db");
    try {
      // Create the schema (and one seed event) before the threads run.
      const seed = new BoardStore(file);
      seed.appendEvent("t", "seed", "baseline");
      seed.close();

      const W = 4;
      const K = 250;
      await runAppenders(
        file,
        Array.from({ length: W }, (_, wid) => ({ wid, count: K, taskId: "t" })),
      );

      const check = new BoardStore(file);
      const events = check.getEvents("t");
      // Exact count: seed + every append landed (none lost).
      expect(events).toHaveLength(1 + W * K);
      // Every row has a distinct autoincrement id (none overwritten).
      const ids = new Set(events.map((e) => e.id));
      expect(ids.size).toBe(events.length);
      // Every appended message is present exactly once (no clobbering).
      const msgs = events.filter((e) => e.kind === "append").map((e) => e.message);
      expect(new Set(msgs).size).toBe(W * K);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loses no append when threads append to DIFFERENT tasks at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hark-board-conc2-"));
    const file = join(dir, "board.db");
    try {
      const seed = new BoardStore(file);
      seed.appendEvent("seed", "seed");
      seed.close();

      const W = 4;
      const K = 200;
      await runAppenders(
        file,
        Array.from({ length: W }, (_, wid) => ({
          wid,
          count: K,
          taskId: `task-${wid}`,
        })),
      );

      const check = new BoardStore(file);
      for (let wid = 0; wid < W; wid++) {
        expect(check.getEvents(`task-${wid}`)).toHaveLength(K);
      }
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- id minting ------------------------------------------------------------

describe("newTaskId", () => {
  it("mints unique task- prefixed ids", () => {
    const a = newTaskId();
    const b = newTaskId();
    expect(a).toMatch(/^task-/);
    expect(a).not.toBe(b);
  });
});
