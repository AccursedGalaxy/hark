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
export const SCHEMA_VERSION = 1;

// Task lifecycle at the *task* grain (mirrors the worker lifecycle, but a task
// is not an agent). backlog → ready → in-progress → review → done, plus blocked.
export const BOARD_STATUSES = [
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

// ~/.hark/board.db — sibling of metrics.db under the same base dir, so a
// HARK_ORCH_DIR override (e.g. an isolated dogfood instance) carries the board
// into the same sandbox. A SEPARATE FILE from metrics.db on purpose: wiping the
// rebuildable metrics read-model must never clear the board source of truth.
export function defaultBoardDbPath(): string {
  const orchDir = defaultOrchDir();
  return path.join(path.dirname(orchDir) || os.homedir(), "board.db");
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

  constructor(dbPath: string = defaultBoardDbPath(), now: () => number = Date.now) {
    this.db = new DatabaseSync(dbPath);
    this.now = now;
    this.db.exec("PRAGMA journal_mode = WAL");
    // Concurrent writers WAIT for the lock rather than failing with
    // SQLITE_BUSY — the half of the append-integrity property that survives two
    // processes (or worker threads) appending at once.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = OFF");
    for (const ddl of SCHEMA_DDL) this.db.exec(ddl);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
      // Closing on creation also stamps closed_at.
      if (statusOf(fields) === "done") {
        columns.push("closed_at");
        values.push(ts);
      }
      for (const key of Object.keys(fields) as (keyof TaskFields)[]) {
        if (key === "status") continue; // already placed
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

    // Existing row: compute the genuine diff.
    const diff: Partial<Record<keyof TaskFields, string | null>> = {};
    for (const key of Object.keys(fields) as (keyof TaskFields)[]) {
      const next = fields[key] ?? null;
      // Every TaskFields key is also a TaskRow key (same camelCase names).
      const current = (existing[key as keyof TaskRow] as string | null) ?? null;
      if (next !== current) diff[key] = next;
    }

    if (Object.keys(diff).length === 0) {
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
    // Transition INTO done stamps closed_at (only if not already closed);
    // moving back out clears it, so the field tracks the live status.
    if (diff.status !== undefined) {
      if (diff.status === "done") {
        setCols.push("closed_at = ?");
        setVals.push(ts);
      } else {
        setCols.push("closed_at = ?");
        setVals.push(null);
      }
    }
    this.db
      .prepare(`UPDATE tasks SET ${setCols.join(", ")} WHERE id = ?`)
      .run(...setVals, id);
    this.appendEvent(id, "set", "task updated", diff);
    return { task: this.getTask(id)!, changed: true };
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

// Strip undefined → a plain object for the event payload (null is kept: it
// records an explicit clear).
function fieldsForEvent(fields: TaskFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields) as (keyof TaskFields)[]) {
    out[KEY_TO_COLUMN[key]] = fields[key] ?? null;
  }
  return out;
}
