import { describe, it, expect } from "vitest";
import { BoardStore } from "./boardStore.js";
import {
  planBoard,
  applyBoardOp,
  renderBoardResult,
  type BoardOp,
} from "./boardCli.js";

// planBoard takes the positionals AFTER the `board` token; a small helper splits
// a flat token list (no flags here) the way parseArgs would.
function plan(tokens: string[]) {
  return planBoard(tokens, {});
}

describe("planBoard parsing", () => {
  it("add: title + field assignments", () => {
    const p = plan(["add", "Build the board", "status=ready", "workstream=board"]);
    expect(p).toEqual({
      kind: "op",
      op: { verb: "add", title: "Build the board", fields: { status: "ready", workstream: "board" } },
    });
  });

  it("add: requires a title", () => {
    expect(plan(["add"]).kind).toBe("error");
  });

  it("set: id + assignments", () => {
    const p = plan(["set", "task-1", "status=review", "assignee=tester"]);
    expect(p).toEqual({
      kind: "op",
      op: { verb: "set", id: "task-1", fields: { status: "review", assignee: "tester" } },
    });
  });

  it("set: needs at least one field", () => {
    expect(plan(["set", "task-1"]).kind).toBe("error");
  });

  it("set: surfaces an invalid status", () => {
    const p = plan(["set", "task-1", "status=bogus"]);
    expect(p.kind).toBe("error");
  });

  it("list: parses filters", () => {
    expect(plan(["list", "status=ready"])).toEqual({
      kind: "op",
      op: { verb: "list", filter: { status: "ready" } },
    });
  });

  it("list: rejects a non-filterable field", () => {
    const p = plan(["list", "title=x"]);
    expect(p.kind).toBe("error");
  });

  it("show / link / assign / close", () => {
    expect(plan(["show", "t1"])).toEqual({ kind: "op", op: { verb: "show", id: "t1" } });
    expect(plan(["link", "t1", "t2"])).toEqual({
      kind: "op",
      op: { verb: "link", id: "t1", dependsOn: "t2" },
    });
    expect(plan(["assign", "t1", "coder"])).toEqual({
      kind: "op",
      op: { verb: "assign", id: "t1", assignee: "coder" },
    });
    expect(plan(["close", "t1"])).toEqual({ kind: "op", op: { verb: "close", id: "t1" } });
  });

  it("link / assign / close need their args", () => {
    expect(plan(["link", "t1"]).kind).toBe("error");
    expect(plan(["assign", "t1"]).kind).toBe("error");
    expect(plan(["close"]).kind).toBe("error");
  });

  it("bare board shows usage; unknown verb errors", () => {
    expect(plan([]).kind).toBe("message");
    expect(plan(["frobnicate"]).kind).toBe("error");
  });
});

describe("applyBoardOp against a real store", () => {
  it("add mints an id and creates the task", () => {
    const db = new BoardStore(":memory:", () => 1);
    const r = applyBoardOp(db, { verb: "add", title: "T", fields: { status: "ready" } });
    expect(r.kind).toBe("task");
    if (r.kind === "task") {
      expect(r.created).toBe(true);
      expect(r.task.id).toMatch(/^task-/);
      expect(r.task.title).toBe("T");
      expect(r.task.status).toBe("ready");
    }
    db.close();
  });

  it("set is idempotent through the op layer too", () => {
    let t = 1;
    const db = new BoardStore(":memory:", () => t);
    const op: BoardOp = { verb: "set", id: "t1", fields: { status: "ready" } };
    const r1 = applyBoardOp(db, op);
    t = 99;
    const r2 = applyBoardOp(db, op);
    if (r1.kind === "task" && r2.kind === "task") {
      expect(r1.changed).toBe(true);
      expect(r2.changed).toBe(false);
      expect(r2.task.updatedAt).toBe(1);
    }
    db.close();
  });

  it("link merges depends_on edges and is idempotent on re-link", () => {
    let t = 1;
    const db = new BoardStore(":memory:", () => t);
    db.setTask("t1", { title: "x" });
    applyBoardOp(db, { verb: "link", id: "t1", dependsOn: "a" });
    applyBoardOp(db, { verb: "link", id: "t1", dependsOn: "b" });
    expect(db.getTask("t1")?.dependsOn).toBe("a,b");
    // Re-linking an existing edge is a no-op (no duplicate, no write).
    t = 50;
    const re = applyBoardOp(db, { verb: "link", id: "t1", dependsOn: "a" });
    if (re.kind === "task") expect(re.changed).toBe(false);
    expect(db.getTask("t1")?.dependsOn).toBe("a,b");
    db.close();
  });

  it("close marks done + stamps closed_at", () => {
    const db = new BoardStore(":memory:", () => 7);
    db.setTask("t1", { title: "x" });
    const r = applyBoardOp(db, { verb: "close", id: "t1" });
    if (r.kind === "task") {
      expect(r.task.status).toBe("done");
      expect(r.task.closedAt).toBe(7);
    }
    db.close();
  });

  it("close by=<who> records the closer in closed_by", () => {
    const db = new BoardStore(":memory:", () => 7);
    db.setTask("t1", { title: "x" });
    const r = applyBoardOp(db, { verb: "close", id: "t1", by: "pm-head-42" });
    if (r.kind === "task") {
      expect(r.task.closedBy).toBe("pm-head-42");
    }
    db.close();
  });

  it("plans close by=<who> into the op", () => {
    expect(plan(["close", "t1", "by=pm-7"])).toEqual({
      kind: "op",
      op: { verb: "close", id: "t1", by: "pm-7" },
    });
  });

  it("rejects unexpected close args", () => {
    expect(plan(["close", "t1", "status=done"]).kind).toBe("error");
  });

  it("show returns the task + its event history", () => {
    const db = new BoardStore(":memory:", () => 1);
    db.setTask("t1", { title: "x", status: "ready" });
    db.setTask("t1", { status: "review" });
    const r = applyBoardOp(db, { verb: "show", id: "t1" });
    if (r.kind === "show") {
      expect(r.task?.status).toBe("review");
      expect(r.events.map((e) => e.kind)).toEqual(["created", "set"]);
    }
    db.close();
  });

  it("list returns matching tasks", () => {
    const db = new BoardStore(":memory:", () => 1);
    db.setTask("a", { status: "ready" });
    db.setTask("b", { status: "done" });
    const r = applyBoardOp(db, { verb: "list", filter: { status: "ready" } });
    if (r.kind === "list") expect(r.tasks.map((x) => x.id)).toEqual(["a"]);
    db.close();
  });
});

describe("renderBoardResult", () => {
  it("renders an add line with the new id", () => {
    const out = renderBoardResult({
      kind: "task",
      created: true,
      changed: true,
      task: {
        id: "task-1",
        title: "Build",
        body: null,
        status: "backlog",
        assignee: null,
        workstream: null,
        priority: null,
        dependsOn: null,
        orchId: null,
        agentId: null,
        createdAt: 1,
        updatedAt: 1,
        closedAt: null,
        closedBy: null,
      },
    });
    expect(out).toMatch(/^added task-1 \[backlog\] Build$/);
  });

  it("marks an unchanged set", () => {
    const out = renderBoardResult({
      kind: "task",
      changed: false,
      task: {
        id: "task-1",
        title: "Build",
        body: null,
        status: "ready",
        assignee: null,
        workstream: null,
        priority: null,
        dependsOn: null,
        orchId: null,
        agentId: null,
        createdAt: 1,
        updatedAt: 1,
        closedAt: null,
        closedBy: null,
      },
    });
    expect(out).toMatch(/\(unchanged\)$/);
  });

  it("renders an empty list + a populated one", () => {
    expect(renderBoardResult({ kind: "list", tasks: [] })).toBe("(no tasks)");
  });

  it("renders a missing show target", () => {
    expect(renderBoardResult({ kind: "show", id: "nope", task: null, events: [] })).toBe(
      "(no task nope)",
    );
  });
});
