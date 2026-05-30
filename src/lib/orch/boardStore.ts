import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { defaultOrchDir } from "./store.js";

// The BOARD: a first-class, id-addressed task store — the PM's operational
// substrate. It replaces brittle PLAN.md prose surgery (long-bullet string-match
// edits) with atomic, keyed operations.
//
// CRITICAL difference from metrics.db: the board is a SOURCE OF TRUTH, not a
// derived/rebuildable projection. A metrics wipe/rebuild must NOT touch it — so
// it lives in its OWN file (board.db) beside metrics.db, never inside it.
//
// Reuses the node:sqlite layer shipped for metrics (PR #24): same dependency,
// same shape — pure builders + a thin runtime wrapper. No new dependency, no
// daemon, offline + self-contained (the design doc's "native SoT, GH is a
// projection").
//
// TWO load-bearing correctness properties drive every design choice here; they
// are the reason the board exists, not optional polish:
//   1. `setTask` (keyed upsert) is IDEMPOTENT. Re-applying the same field=value
//      converges to the same row — a `set` whose result you didn't see (flaky
//      IO) is SAFE to re-run. A set that changes nothing writes nothing: it
//      does NOT bump updated_at and does NOT append an event, so N repeated
//      applications are byte-identical to one.
//   2. `task_events` is APPEND-ONLY and lossless under concurrent writers.
//      AUTOINCREMENT ids + WAL + a busy_timeout mean two writers never lose an
//      append and never overwrite each other.

// Bumped when the schema changes shape. Stored in PRAGMA user_version. UNLIKE
// metrics.db, a mismatch here is NOT a licence to wipe — the board is the source
// of truth, so a future change must MIGRATE, not rebuild.
export const SCHEMA_VERSION = 2;

// Task lifecycle at the *task* grain (mirrors the worker lifecycle, but a task
// is not an agent). inbox → backlog → ready → in-progress → review → done, plus
// blocked. `inbox` is the pre-triage capture state: anything the dashboard
// capture box or a quick `hark board add` drops in lands here until the PM
// triages it (promote → backlog/ready, or close as noise). It REPLACES the old
// PLAN.md `## Inbox` section — captures are keyed board rows now, not prose.
export const BOARD_STATUSES = [
  "inbox",
  "backlog",
  "ready",
  "in-progress",
  "review",
  "done",
  "blocked",
] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export const DEFAULT_STATUS: BoardStatus = "backlog";

// The columns a caller may set via `set <id> field=value`. id + the timestamps +
// closed_at are managed internally and are NOT settable.
export const SETTABLE_FIELDS = [
  "title",
  "body",
  "status",
  "assignee",
  "workstream",
  "priority",
  "depends_on",
  "orch_id",
  "agent_id",
] as const;
export type SettableField = (typeof SETTABLE_FIELDS)[number];

export const SCHEMA_DDL: readonly string[] = [
  // The board itself. `assignee` = role | agentId | workstream; `depends_on` =
  // task id(s) (comma-joined). orch_id/agent_id link a task to the worker once
  // it's dispatched — the join key to metrics.db.
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    body TEXT,
    status TEXT,
    assignee TEXT,
    workstream TEXT,
    priority TEXT,
    depends_on TEXT,
    orch_id TEXT,
    agent_id TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    closed_at INTEGER
  )`,
  // APPEND-ONLY history. Never overwritten — the integer PK auto-increments, so
  // concurrent appends never collide. This is the audit trail a later
  // reconciliation / silent-drop-detection layer reads.
  `CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    ts INTEGER,
    kind TEXT,
    message TEXT,
    data_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_events_task_ts ON task_events (task_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)`,
];

// ---- Schema migrations ------------------------------------------------------
//
// The board is a SOURCE OF TRUTH, so a schema bump must EVOLVE the existing
// file, never rebuild it (that's the durability promise that separates it from
// the rebuildable metrics.db). Each migration carries the target version it
// produces and an `up` that takes a db FROM the previous version TO `to`. They
// run in ascending order, each inside its own transaction, and `user_version`
// is stamped only after the body succeeds — so a half-applied migration rolls
// back cleanly and the version never runs ahead of the data.
//
// To add a schema change: append a new entry with `to: <prev + 1>` whose `up`
// ALTERs the existing tables, and bump SCHEMA_VERSION to match. NEVER edit an
// already-shipped migration in place — a db in the field has already run it.
export interface Migration {
  readonly to: number;
  readonly up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  // v1 — the initial schema. On a fresh db this creates every table/index; on a
  // db already at v1 (stamped by an earlier build) it is skipped entirely.
  {
    to: 1,
    up: (db) => {
      for (const ddl of SCHEMA_DDL) db.exec(ddl);
    },
  },
  // v2 — shipped-log attribution. `closed_by` records WHO closed a task (the PM
  // session / agent id) alongside the existing `closed_at` (WHEN), so the set of
  // done tasks is a self-describing shipped log — no PLAN.md `## Shipped` prose
  // needed. ALTER (never rebuild): a board in the field has real tasks.
  {
    to: 2,
    up: (db) => {
      db.exec("ALTER TABLE tasks ADD COLUMN closed_by TEXT");
    },
  },
];

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  return Number(row?.user_version ?? 0);
}

// PURE-of-class migration runner (exported so the migration path is testable
// with a synthetic migration list, not just the shipped one). Reads the current
// user_version, runs every migration whose target is newer, in ascending order,
// each in its own transaction; stamps user_version only after a migration body
// commits. A db whose version is AHEAD of the newest migration is a hard error:
// the board is the source of truth, so an older build must refuse to open a
// newer file rather than silently mangle it.
export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
): void {
  const ordered = [...migrations].sort((a, b) => a.to - b.to);
  const target = ordered.length ? ordered[ordered.length - 1].to : 0;
  const current = readUserVersion(db);
  if (current > target) {
    throw new Error(
      `board.db is at schema v${current} but this build only understands up to v${target}; ` +
        `refusing to open (the board is a source of truth — never downgrade it)`,
    );
  }
  for (const m of ordered) {
    if (m.to <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      m.up(db);
      // user_version writes to the db header transactionally, so it rolls back
      // with the body if anything below throws — version never leads the data.
      db.exec(`PRAGMA user_version = ${m.to}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

// ~/.hark/board.db — sibling of metrics.db under the same base dir, so a
// HARK_ORCH_DIR override (e.g. an isolated dogfood instance) carries the board
// into the same sandbox. A SEPARATE FILE from metrics.db on purpose: wiping the
// rebuildable metrics read-model must never clear the board source of truth.
// LEGACY global board path (~/.hark/board.db). The board was originally a single
// global file; it is now per-project (board-plan.md Part 5: the cell is
// cross-workstream concurrency under ONE PM context, so the board must scope to
// the project the PM holds context across, not to the host). This path survives
// only as (a) the back-compat constructor default and (b) the one-time migration
// SOURCE — `ensureProjectBoardDb` lifts it into the project's own `.hark/`.
export function defaultBoardDbPath(): string {
  const orchDir = defaultOrchDir();
  return path.join(path.dirname(orchDir) || os.homedir(), "board.db");
}

// The per-project board lives beside the project's other `.hark/` coordination
// files — one board per project root, the granularity the design doc requires.
export function boardDbPathForProject(projectRoot: string): string {
  return path.join(projectRoot, ".hark", "board.db");
}

// Resolve (and prepare) the board.db path for a project root: ensure `.hark/`
// exists, and on the FIRST open migrate a legacy global ~/.hark/board.db into
// place so the PM keeps its existing tasks across the per-project cutover. Idempotent
// — once the project's board exists, the legacy file is never consulted again.
export function ensureProjectBoardDb(projectRoot: string): string {
  const target = boardDbPathForProject(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    const legacy = defaultBoardDbPath();
    if (path.resolve(legacy) !== path.resolve(target) && fs.existsSync(legacy)) {
      migrateLegacyBoard(legacy, target);
    }
  }
  return target;
}

// Best-effort one-time lift of the legacy global board into a project board.
// Uses SQLite's `VACUUM INTO` rather than a raw filesystem copy: it takes a read
// snapshot and writes a fresh, consistent db at the target, so a writer on the
// legacy file (e.g. a still-running old server) can't tear the copy the way
// copyFileSync could (a half-written page set / a missed WAL frame). A failure
// here must never block opening a fresh board at the target — so it swallows
// errors and leaves the target absent (open then creates an empty board).
function migrateLegacyBoard(legacy: string, target: string): void {
  try {
    const src = new DatabaseSync(legacy);
    try {
      src.exec("PRAGMA busy_timeout = 5000");
      // VACUUM INTO needs a string literal; single-quote-escape the path. The
      // target is guaranteed absent by the caller (VACUUM INTO refuses to
      // overwrite), so a torn/partial target can never be left behind.
      src.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
  } catch {
    // Leave target absent — a fresh project board is created on open.
  }
}

// Walk up from `startDir` to the nearest enclosing project root (a directory
// holding a `.git`), falling back to `startDir` itself. Used by the `hark board`
// CLI to scope to the project the PM is sitting in, mirroring how the board's
// per-project granularity is defined.
//
// NOTE on worktrees: a linked git worktree has its own toplevel (its `.git` is a
// file), so this resolves it to that worktree's own `.hark/board.db`, NOT the
// main tree's. That is acceptable because the board is the PM-HEAD's tool, and
// the PM-head runs at the main project root — workers in worktrees don't drive
// the board. If that ever changes, resolve worktrees to their shared root via
// `git rev-parse --git-common-dir`.
export function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

// Short, time-sortable, collision-resistant task id (mirrors store.ts genId).
export function newTaskId(): string {
  const t = Date.now().toString(36);
  const r = randomBytes(3).toString("hex");
  return `task-${t}-${r}`;
}

// ---- Row shapes -------------------------------------------------------------

export interface TaskRow {
  id: string;
  title: string | null;
  body: string | null;
  status: string | null;
  assignee: string | null;
  workstream: string | null;
  priority: string | null;
  dependsOn: string | null;
  orchId: string | null;
  agentId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  closedAt: number | null;
  closedBy: string | null;
}

export interface TaskEventRow {
  id: number;
  taskId: string;
  ts: number;
  kind: string;
  message: string | null;
  data: unknown;
}

// A partial set of settable fields, in the store's own camelCase. Undefined
// means "leave untouched"; null clears the column.
export interface TaskFields {
  title?: string | null;
  body?: string | null;
  status?: string | null;
  assignee?: string | null;
  workstream?: string | null;
  priority?: string | null;
  dependsOn?: string | null;
  orchId?: string | null;
  agentId?: string | null;
  // Managed, not a generic settable field: `closed_by` is stamped only on a
  // transition INTO done (and cleared when leaving done), so it always tracks
  // the live close. The `close` verb passes it; the generic `set` CLI does not.
  closedBy?: string | null;
}

// Column name (snake_case, as the CLI accepts it) → TaskFields key (camelCase).
const FIELD_TO_KEY: Record<SettableField, keyof TaskFields> = {
  title: "title",
  body: "body",
  status: "status",
  assignee: "assignee",
  workstream: "workstream",
  priority: "priority",
  depends_on: "dependsOn",
  orch_id: "orchId",
  agent_id: "agentId",
};

// PURE. Map a TaskFields key back to its db column (for SET clauses + diffing).
const KEY_TO_COLUMN: Record<keyof TaskFields, string> = {
  title: "title",
  body: "body",
  status: "status",
  assignee: "assignee",
  workstream: "workstream",
  priority: "priority",
  dependsOn: "depends_on",
  orchId: "orch_id",
  agentId: "agent_id",
  closedBy: "closed_by",
};

// PURE. Validate + collect a list of `field=value` tokens into a TaskFields.
// Returns either the parsed fields or the first offending token's error. Shared
// by add/set so the CLI parser stays pure + unit-testable without a DB.
export function parseFieldAssignments(
  tokens: string[],
): { fields: TaskFields } | { error: string } {
  const fields: TaskFields = {};
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq <= 0) {
      return { error: `expected field=value, got "${tok}"` };
    }
    const rawField = tok.slice(0, eq);
    const value = tok.slice(eq + 1);
    // Accept either snake_case columns or the camelCase keys, normalising to
    // the column name so unknown fields are rejected.
    const field = normaliseField(rawField);
    if (!field) {
      return {
        error: `unknown field "${rawField}" (settable: ${SETTABLE_FIELDS.join(", ")})`,
      };
    }
    const key = FIELD_TO_KEY[field];
    if (key === "status" && value !== "" && !isBoardStatus(value)) {
      return {
        error: `invalid status "${value}" (one of: ${BOARD_STATUSES.join(", ")})`,
      };
    }
    // Empty value clears the column (null); otherwise the literal string.
    fields[key] = value === "" ? null : value;
  }
  return { fields };
}

function normaliseField(raw: string): SettableField | null {
  if ((SETTABLE_FIELDS as readonly string[]).includes(raw)) {
    return raw as SettableField;
  }
  // Allow camelCase aliases (dependsOn, orchId, agentId).
  const alias: Record<string, SettableField> = {
    dependson: "depends_on",
    orchid: "orch_id",
    agentid: "agent_id",
  };
  return alias[raw.toLowerCase()] ?? null;
}

export function isBoardStatus(s: string): s is BoardStatus {
  return (BOARD_STATUSES as readonly string[]).includes(s);
}

// PURE. Map a raw sqlite row (snake_case) onto a TaskRow (camelCase). Exported
// so the row shape is testable without a live DB.
export function toTaskRow(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id),
    title: (r.title as string) ?? null,
    body: (r.body as string) ?? null,
    status: (r.status as string) ?? null,
    assignee: (r.assignee as string) ?? null,
    workstream: (r.workstream as string) ?? null,
    priority: (r.priority as string) ?? null,
    dependsOn: (r.depends_on as string) ?? null,
    orchId: (r.orch_id as string) ?? null,
    agentId: (r.agent_id as string) ?? null,
    createdAt: r.created_at == null ? null : Number(r.created_at),
    updatedAt: r.updated_at == null ? null : Number(r.updated_at),
    closedAt: r.closed_at == null ? null : Number(r.closed_at),
    closedBy: (r.closed_by as string) ?? null,
  };
}

export interface ListFilter {
  status?: string;
  assignee?: string;
  workstream?: string;
  orchId?: string;
}

// ---- Runtime wrapper --------------------------------------------------------

export class BoardStore {
  private readonly db: DatabaseSync;
  // Injectable clock keeps timestamps deterministic in tests. Defaults to the
  // wall clock — fine in the Node runtime (bin/hark, server).
  private readonly now: () => number;
  // Reentrancy guard for `transaction`: a nested call joins the outer tx rather
  // than issuing a second BEGIN (sqlite forbids nested transactions). Lets
  // `link` compose `setTask` while both stay atomic.
  private inTransaction = false;

  constructor(dbPath: string = defaultBoardDbPath(), now: () => number = Date.now) {
    this.db = new DatabaseSync(dbPath);
    this.now = now;
    // busy_timeout FIRST, before any other statement: concurrent writers WAIT
    // for the lock rather than failing with SQLITE_BUSY. This must precede the
    // `journal_mode = WAL` switch — flipping the journal mode needs a momentary
    // lock, so a connection opened while another holds a write tx would fail at
    // that pragma if the timeout weren't already armed. (Half of the
    // append-integrity property: surviving two processes/threads at once.)
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = OFF");
    // Evolve the file forward to the current schema (never rebuild it). Must run
    // AFTER journal_mode is set (WAL can't be switched inside a transaction).
    runMigrations(this.db, MIGRATIONS);
  }

  // Run `fn` inside a write transaction so a read-modify-write can't lose an
  // update to a concurrent writer. BEGIN IMMEDIATE takes the write lock up
  // front, so a second writer's BEGIN IMMEDIATE blocks (up to busy_timeout)
  // until this one commits — it then reads the post-commit state instead of a
  // stale snapshot. Reentrant: a nested call runs inside the existing tx.
  private transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    return Number(row?.user_version ?? 0);
  }

  getTask(id: string): TaskRow | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toTaskRow(row) : null;
  }

  listTasks(filter: ListFilter = {}): TaskRow[] {
    const where: string[] = [];
    const binds: string[] = [];
    if (filter.status) {
      where.push("status = ?");
      binds.push(filter.status);
    }
    if (filter.assignee) {
      where.push("assignee = ?");
      binds.push(filter.assignee);
    }
    if (filter.workstream) {
      where.push("workstream = ?");
      binds.push(filter.workstream);
    }
    if (filter.orchId) {
      where.push("orch_id = ?");
      binds.push(filter.orchId);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${clause} ORDER BY created_at, id`)
      .all(...binds) as Record<string, unknown>[];
    return rows.map(toTaskRow);
  }

  // The keyed UPSERT — the headline primitive. IDEMPOTENT by construction:
  //   - new id  → INSERT (created_at = updated_at = now), append a `created`
  //               event, changed = true.
  //   - exists, some field differs → UPDATE only the differing columns, bump
  //               updated_at, append ONE `set` event recording the diff,
  //               changed = true.
  //   - exists, NOTHING differs → NO-OP: write nothing, no updated_at bump, no
  //               event. changed = false.
  // Because an unchanged set writes nothing, applying the same set N times is
  // byte-identical to applying it once. A set whose result you didn't see is
  // therefore safe to re-run under flaky IO.
  setTask(id: string, fields: TaskFields): { task: TaskRow; changed: boolean } {
    // The read (getTask) and the write below are one atomic read-modify-write:
    // wrapped in a transaction so a concurrent writer can't slip an update
    // between our read and our write and have it silently overwritten.
    return this.transaction(() => this.setTaskInTx(id, fields));
  }

  private setTaskInTx(
    id: string,
    fields: TaskFields,
  ): { task: TaskRow; changed: boolean } {
    const existing = this.getTask(id);
    const ts = this.now();

    if (!existing) {
      const columns = ["id", "status", "created_at", "updated_at"];
      const values: (string | number | null)[] = [
        id,
        statusOf(fields),
        ts,
        ts,
      ];
      // Closing on creation also stamps closed_at + closed_by (who closed it).
      if (statusOf(fields) === "done") {
        columns.push("closed_at", "closed_by");
        values.push(ts, fields.closedBy ?? null);
      }
      for (const key of Object.keys(fields) as (keyof TaskFields)[]) {
        // status is placed above; closedBy is managed by the done-transition
        // (handled above / below), never a free column.
        if (key === "status" || key === "closedBy") continue;
        const col = KEY_TO_COLUMN[key];
        columns.push(col);
        values.push(fields[key] ?? null);
      }
      const placeholders = columns.map(() => "?").join(", ");
      this.db
        .prepare(
          `INSERT INTO tasks (${columns.join(", ")}) VALUES (${placeholders})`,
        )
        .run(...values);
      this.appendEvent(id, "created", "task created", fieldsForEvent(fields));
      return { task: this.getTask(id)!, changed: true };
    }

    // Existing row: compute the genuine diff. closedBy is excluded — it is not a
    // free column; the done-transition below stamps/clears it.
    const diff: Partial<Record<keyof TaskFields, string | null>> = {};
    for (const key of Object.keys(fields) as (keyof TaskFields)[]) {
      if (key === "closedBy") continue;
      const next = fields[key] ?? null;
      // Every TaskFields key is also a TaskRow key (same camelCase names).
      const current = (existing[key as keyof TaskRow] as string | null) ?? null;
      if (next !== current) diff[key] = next;
    }

    // Attribution can be CORRECTED on a task that is (and stays) done: an
    // explicit, non-null closedBy that differs from the stored one. A bare close
    // (closedBy null/omitted) never overwrites or clears it — omission means
    // "leave as-is", which keeps a re-close idempotent. Only relevant when the
    // status is NOT changing (a done-transition below already sets closed_by).
    const nextStatus = diff.status !== undefined ? diff.status : existing.status;
    const correctClosedBy =
      diff.status === undefined &&
      nextStatus === "done" &&
      fields.closedBy != null &&
      fields.closedBy !== existing.closedBy;

    if (Object.keys(diff).length === 0 && !correctClosedBy) {
      // True no-op — the idempotency guarantee. Touch nothing.
      return { task: existing, changed: false };
    }

    const setCols: string[] = [];
    const setVals: (string | number | null)[] = [];
    for (const key of Object.keys(diff) as (keyof TaskFields)[]) {
      setCols.push(`${KEY_TO_COLUMN[key]} = ?`);
      setVals.push(diff[key] ?? null);
    }
    setCols.push("updated_at = ?");
    setVals.push(ts);
    // Transition INTO done stamps closed_at + closed_by; moving back out clears
    // both, so the pair always tracks the live close (the shipped-log record).
    const eventDiff: Partial<Record<keyof TaskFields, string | null>> = { ...diff };
    if (diff.status !== undefined) {
      if (diff.status === "done") {
        setCols.push("closed_at = ?", "closed_by = ?");
        setVals.push(ts, fields.closedBy ?? null);
      } else {
        setCols.push("closed_at = ?", "closed_by = ?");
        setVals.push(null, null);
      }
    } else if (correctClosedBy) {
      // Re-attribute an already-done task without re-opening it.
      setCols.push("closed_by = ?");
      setVals.push(fields.closedBy ?? null);
      eventDiff.closedBy = fields.closedBy ?? null;
    }
    this.db
      .prepare(`UPDATE tasks SET ${setCols.join(", ")} WHERE id = ?`)
      .run(...setVals, id);
    this.appendEvent(id, "set", "task updated", eventDiff);
    return { task: this.getTask(id)!, changed: true };
  }

  // Add a depends_on edge, idempotently. Read-modify-write (read the current
  // edges, merge, write back) — so it runs in a transaction for the same reason
  // setTask does. The nested setTask joins this transaction (reentrant), so the
  // read of the edges and their rewrite are atomic against a concurrent linker.
  link(id: string, dependsOn: string): { task: TaskRow; changed: boolean } {
    return this.transaction(() => {
      const current = this.getTask(id);
      const edges = splitEdges(current?.dependsOn ?? null);
      if (!edges.includes(dependsOn)) edges.push(dependsOn);
      return this.setTaskInTx(id, { dependsOn: edges.join(",") });
    });
  }

  // APPEND a history event. Never updates — the integer PK auto-increments, so
  // two writers (processes / worker threads) appending at once never collide
  // and never overwrite. The lossless-under-concurrency property.
  appendEvent(
    taskId: string,
    kind: string,
    message?: string,
    data?: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO task_events (task_id, ts, kind, message, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        this.now(),
        kind,
        message ?? null,
        data === undefined ? null : JSON.stringify(data),
      );
  }

  getEvents(taskId: string): TaskEventRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM task_events WHERE task_id = ? ORDER BY id",
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: String(r.task_id),
      ts: Number(r.ts),
      kind: String(r.kind),
      message: (r.message as string) ?? null,
      data: r.data_json == null ? null : JSON.parse(String(r.data_json)),
    }));
  }

  close(): void {
    this.db.close();
  }
}

// PURE helpers ----------------------------------------------------------------

function statusOf(fields: TaskFields): string {
  return fields.status ?? DEFAULT_STATUS;
}

// PURE. Parse a comma-joined depends_on column into a clean list of edge ids
// (trimmed, no empties). Shared by `link` and the CLI renderer.
export function splitEdges(deps: string | null): string[] {
  if (!deps) return [];
  return deps
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Strip undefined → a plain object for the event payload (null is kept: it
// records an explicit clear).
function fieldsForEvent(fields: TaskFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields) as (keyof TaskFields)[]) {
    out[KEY_TO_COLUMN[key]] = fields[key] ?? null;
  }
  return out;
}
