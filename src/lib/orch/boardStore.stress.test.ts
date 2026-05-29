import { describe, it, expect } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./boardStore.js";

// ADVERSARIAL stress tests for the two load-bearing board properties. These sit
// ON TOP of boardStore.test.ts (the coder's happy-path coverage): they exist to
// BREAK the properties, not confirm them. A reconciliation / silent-drop layer
// is built atop these, so a subtle break here corrupts everything above it.
//
//   1. setTask upsert IDEMPOTENCY — a `set` whose result you didn't see is safe
//      to re-run, even interleaved with other ops, even re-applying a clear.
//   2. task_events APPEND-ONLY + lossless + order-preserving under CONCURRENCY.

// ============================================================================
// PROPERTY 1 — Upsert idempotency (sequential + interleaved attacks)
// ============================================================================

describe("setTask idempotency — adversarial", () => {
  // The flaky-IO contract spelled out verbatim: a write LANDED but its result
  // was never seen by the caller. Re-running the identical set must be a true
  // no-op — the row is byte-identical and NO new event is appended.
  it("re-apply after a write whose result you never saw is a pure no-op (INSERT path)", () => {
    let t = 1000;
    const db = new BoardStore(":memory:", () => t);

    // The write lands. Pretend the response was eaten by flaky IO.
    db.setTask("t1", { status: "ready", title: "X", assignee: "coder" });
    const afterFirst = db.getTask("t1");
    const eventsAfterFirst = db.getEvents("t1");
    expect(eventsAfterFirst).toHaveLength(1); // just `created`

    // Caller, not knowing whether it landed, re-runs the SAME set repeatedly.
    t = 2000; // a real second write would stamp 2000 into updated_at
    for (let i = 0; i < 25; i++) {
      const r = db.setTask("t1", { status: "ready", title: "X", assignee: "coder" });
      expect(r.changed).toBe(false);
    }
    expect(db.getTask("t1")).toEqual(afterFirst); // no drift
    expect(db.getEvents("t1")).toHaveLength(1); // no spurious events
    db.close();
  });

  // Re-applies INTERLEAVED with genuine, unrelated changes. The re-applied set
  // must stay a no-op as long as its own fields haven't drifted, regardless of
  // what other ops touched other columns in between.
  it("interleaved re-applies converge and never spuriously re-write", () => {
    let t = 1;
    const db = new BoardStore(":memory:", () => t);

    t = 10;
    db.setTask("t1", { status: "ready", title: "build board" });
    // Re-apply A (no-op) ...
    t = 11;
    expect(db.setTask("t1", { status: "ready", title: "build board" }).changed).toBe(false);
    // ... then a genuine, DIFFERENT-field op (B) ...
    t = 12;
    expect(db.setTask("t1", { assignee: "coder" }).changed).toBe(true);
    // ... then re-apply A again — must STILL be a no-op (A's fields unchanged) ...
    t = 13;
    expect(db.setTask("t1", { status: "ready", title: "build board" }).changed).toBe(false);
    // ... then re-apply B — also a no-op now.
    t = 14;
    expect(db.setTask("t1", { assignee: "coder" }).changed).toBe(false);

    const task = db.getTask("t1");
    expect(task?.status).toBe("ready");
    expect(task?.title).toBe("build board");
    expect(task?.assignee).toBe("coder");
    // Exactly two writes ever happened: created + the one assignee change.
    const events = db.getEvents("t1");
    expect(events.map((e) => e.kind)).toEqual(["created", "set"]);
    expect(events[1].data).toEqual({ assignee: "coder" });
    db.close();
  });

  // A CLEAR (field=value with empty value → null) must be idempotent too.
  // Re-clearing an already-null column writes nothing.
  it("clearing a field is idempotent — re-clearing an already-null column is a no-op", () => {
    let t = 1;
    const db = new BoardStore(":memory:", () => t);
    db.setTask("t1", { assignee: "coder", title: "x" });
    t = 2;
    const cleared = db.setTask("t1", { assignee: null });
    expect(cleared.changed).toBe(true);
    expect(cleared.task.assignee).toBeNull();
    const eventsAfterClear = db.getEvents("t1");
    expect(eventsAfterClear).toHaveLength(2); // created + the clear

    // Re-clear N times — already null, so every one is a no-op.
    t = 3;
    for (let i = 0; i < 10; i++) {
      expect(db.setTask("t1", { assignee: null }).changed).toBe(false);
    }
    expect(db.getEvents("t1")).toHaveLength(2);
    expect(db.getTask("t1")?.assignee).toBeNull();
    db.close();
  });

  // The absent-key vs explicit-null trap: a column that was NEVER set is null.
  // Re-applying a set that explicitly names that column with null must NOT count
  // as a change — else every re-apply that spells out a still-empty field would
  // spuriously append an event and bump updated_at.
  it("explicit null for a never-set column is not a change", () => {
    let t = 1;
    const db = new BoardStore(":memory:", () => t);
    db.setTask("t1", { status: "ready" }); // assignee never touched → null
    t = 2;
    const r = db.setTask("t1", { status: "ready", assignee: null, workstream: null });
    expect(r.changed).toBe(false);
    expect(r.task.updatedAt).toBe(1); // not bumped to 2
    expect(db.getEvents("t1")).toHaveLength(1);
    db.close();
  });

  // closed_at must NOT drift when an intervening edit touches an unrelated field
  // while status stays `done`. The stamp records when it was closed, full stop.
  it("closed_at does not drift across edits that leave status=done", () => {
    let t = 100;
    const db = new BoardStore(":memory:", () => t);
    db.setTask("t1", { title: "x" });
    t = 500;
    db.setTask("t1", { status: "done" });
    expect(db.getTask("t1")?.closedAt).toBe(500);

    // Edit an unrelated field much later — status stays done.
    t = 9000;
    const r = db.setTask("t1", { body: "post-mortem notes" });
    expect(r.changed).toBe(true);
    expect(r.task.closedAt).toBe(500); // NOT re-stamped to 9000

    // Re-apply status=done — pure no-op, stamp untouched.
    t = 12000;
    expect(db.setTask("t1", { status: "done" }).changed).toBe(false);
    expect(db.getTask("t1")?.closedAt).toBe(500);
    db.close();
  });

  // Object key ORDER must not affect the diff — re-applying the same logical set
  // with keys in a different order is still a no-op.
  it("field order does not affect idempotency", () => {
    const db = new BoardStore(":memory:", () => 1);
    db.setTask("t1", { status: "ready", title: "a", assignee: "b", priority: "p1" });
    const r = db.setTask("t1", { priority: "p1", assignee: "b", title: "a", status: "ready" });
    expect(r.changed).toBe(false);
    expect(db.getEvents("t1")).toHaveLength(1);
    db.close();
  });

  // Flip a field A→B→A. The final state equals the first; re-applying the final
  // value is a no-op. The history records every REAL transition (no loss, no
  // collapse), but settles.
  it("flip A->B->A settles, then re-apply is a no-op, with full history kept", () => {
    let t = 0;
    const db = new BoardStore(":memory:", () => ++t);
    db.setTask("t1", { status: "ready" }); // created (status ready)
    db.setTask("t1", { status: "review" }); // set
    db.setTask("t1", { status: "ready" }); // set (back)
    expect(db.setTask("t1", { status: "ready" }).changed).toBe(false); // no-op
    expect(db.setTask("t1", { status: "ready" }).changed).toBe(false); // no-op

    expect(db.getTask("t1")?.status).toBe("ready");
    const kinds = db.getEvents("t1").map((e) => e.kind);
    expect(kinds).toEqual(["created", "set", "set"]); // 3 real writes, no more
    db.close();
  });
});

// ============================================================================
// PROPERTY 2 — task_events append-only + lossless + ordered, under CONCURRENCY
// ============================================================================

// A CJS worker that opens the SAME db file in its own thread and appends `count`
// events tagged `w{wid}-{i}`, so true OS threads contend on the sqlite file —
// exercising WAL + busy_timeout, not single-thread interleaving. Each appended
// row's data_json carries {wid, i} so we can reconstruct per-writer ordering.
const APPENDER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
const stmt = db.prepare(
  'INSERT INTO task_events (task_id, ts, kind, message, data_json) VALUES (?, ?, ?, ?, ?)'
);
for (let i = 0; i < workerData.count; i++) {
  const tid = workerData.taskIds[i % workerData.taskIds.length];
  stmt.run(tid, Date.now(), 'append', 'w' + workerData.wid + '-' + i,
           JSON.stringify({ wid: workerData.wid, i }));
}
db.close();
parentPort.postMessage('done');
`;

function runAppenders(
  dbPath: string,
  workers: { wid: number; count: number; taskIds: string[] }[],
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

describe("task_events under heavy concurrency — adversarial", () => {
  // Higher contention than the baseline (8 writers), SAME task, plus a stronger
  // claim than count+distinct: per-writer ORDERING is preserved. A single
  // writer's appends must land in the global id sequence in the order it issued
  // them — if the autoincrement / WAL serialization ever reordered or dropped an
  // append, the reconstructed per-writer sequence would not be 0,1,2,...
  it("8 writers hammering ONE task: lossless, distinct ids, per-writer order kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hark-board-hammer-"));
    const file = join(dir, "board.db");
    try {
      const seed = new BoardStore(file);
      seed.appendEvent("t", "seed", "baseline");
      seed.close();

      const W = 8;
      const K = 300;
      await runAppenders(
        file,
        Array.from({ length: W }, (_, wid) => ({ wid, count: K, taskIds: ["t"] })),
      );

      const check = new BoardStore(file);
      const events = check.getEvents("t"); // ORDER BY id
      // No loss: seed + every single append landed.
      expect(events).toHaveLength(1 + W * K);
      // No overwrite: every autoincrement id is distinct.
      expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
      // ids are strictly increasing in id order (sanity on the ORDER BY itself).
      for (let i = 1; i < events.length; i++) {
        expect(events[i].id).toBeGreaterThan(events[i - 1].id);
      }
      // Per-writer ordering: filtering the global id-ordered stream down to one
      // writer must yield i = 0,1,2,...,K-1 with no gaps and no reorder.
      const appends = events.filter((e) => e.kind === "append");
      for (let wid = 0; wid < W; wid++) {
        const mine = appends
          .filter((e) => (e.data as { wid: number }).wid === wid)
          .map((e) => (e.data as { i: number }).i);
        expect(mine).toEqual(Array.from({ length: K }, (_, i) => i));
      }
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The realistic hammer: some writers pound the SAME task while others spread
  // across DIFFERENT tasks, all at once. Total appends and per-task counts must
  // both be exact — neither cross-task contention nor same-task contention loses
  // an append.
  it("mixed same-task + different-task writers simultaneously lose nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hark-board-mixed-"));
    const file = join(dir, "board.db");
    try {
      const seed = new BoardStore(file);
      seed.appendEvent("seed", "seed");
      seed.close();

      const K = 200;
      // wid 0,1 hammer the shared task "hot"; wid 2,3 own a private task each.
      const workers = [
        { wid: 0, count: K, taskIds: ["hot"] },
        { wid: 1, count: K, taskIds: ["hot"] },
        { wid: 2, count: K, taskIds: ["task-2"] },
        { wid: 3, count: K, taskIds: ["task-3"] },
      ];
      await runAppenders(file, workers);

      const check = new BoardStore(file);
      // Shared task got both writers' appends, none lost.
      expect(check.getEvents("hot")).toHaveLength(2 * K);
      expect(check.getEvents("task-2")).toHaveLength(K);
      expect(check.getEvents("task-3")).toHaveLength(K);
      // On the hot task, both writers' full sequences survive intact.
      const hot = check.getEvents("hot");
      for (const wid of [0, 1]) {
        const mine = hot
          .filter((e) => (e.data as { wid: number }).wid === wid)
          .map((e) => (e.data as { i: number }).i);
        expect(mine).toEqual(Array.from({ length: K }, (_, i) => i));
      }
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
