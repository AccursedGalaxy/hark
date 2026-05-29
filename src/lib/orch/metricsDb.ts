import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultOrchDir } from "./store.js";
import { costForTokens } from "../../shared/pricing.js";
import type {
  OrchAgent,
  OrchEvent,
  OrchHead,
  Orchestration,
} from "../../shared/protocol.js";

// Central metrics datastore (Phase 0). A DERIVED, rebuildable read-model in
// SQLite that AUGMENTS — never replaces — the JSON store. The JSON files stay
// the source of truth (the live server, head, and CLI read them); this DB is
// the queryable time-series the JSON snapshots can't be: it APPENDS a
// token_samples row each ingest tick (the JSON record overwrites per tick, so
// the token/cost history was being lost) and computes `cost_usd` (always 0 in
// the JSON record today). Delete the file and re-ingest from events.jsonl +
// transcripts and nothing is lost — nothing here is authoritative.
//
// Pattern mirrors worktree.ts: pure builders up top (the schema DDL, the row
// mappers, the cost calc via shared/pricing), a thin runtime wrapper (the
// MetricsDb class) below. Zero new deps — Node's built-in node:sqlite.

// Bumped when the schema changes shape. Stored in PRAGMA user_version; a
// mismatch is the signal to drop + rebuild (Phase 0 just records it — the DB
// is rebuildable, so a future migration can wipe rather than migrate).
export const SCHEMA_VERSION = 1;

// CREATE TABLE IF NOT EXISTS statements, applied idempotently on open. Phase 1
// tables (turns/tool_calls) are intentionally absent.
export const SCHEMA_DDL: readonly string[] = [
  // Upserted snapshot of each orchestration record.
  `CREATE TABLE IF NOT EXISTS orchestrations (
    id TEXT PRIMARY KEY,
    name TEXT,
    goal TEXT,
    project_root TEXT,
    project_name TEXT,
    base_ref TEXT,
    status TEXT,
    managed INTEGER,
    autonomy_level TEXT,
    created_at INTEGER,
    updated_at INTEGER
  )`,
  // Upserted snapshot of each agent. The head is modelled as an agent row with
  // role='head' (id = "<orchId>#head") so consumers query one table.
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    orch_id TEXT,
    role TEXT,
    branch TEXT,
    worktree_dir TEXT,
    session_id TEXT,
    pid INTEGER,
    lifecycle TEXT,
    task TEXT,
    depends_on TEXT,
    blocked_reason TEXT,
    summary TEXT,
    briefed_at INTEGER,
    killed_at INTEGER,
    head_woke_at INTEGER,
    created_at INTEGER,
    updated_at INTEGER
  )`,
  // Append-only 1:1 mirror of events.jsonl, tailed from a stored byte offset.
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER,
    orch_id TEXT,
    agent_id TEXT,
    kind TEXT,
    message TEXT,
    data_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_orch_ts ON events (orch_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind)`,
  // The time-series fix: a NEW ROW each ingest tick (never an overwrite), so
  // the token/cost history is preserved. cost_usd computed at ingest.
  `CREATE TABLE IF NOT EXISTS token_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    agent_id TEXT,
    orch_id TEXT,
    ts INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read INTEGER,
    cache_creation INTEGER,
    turns INTEGER,
    cost_usd REAL,
    model TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_token_samples_session_ts ON token_samples (session_id, ts)`,
  // Every PR attempt outcome — created AND the dropped statuses (no_remote /
  // no_base / no_gh / error). merged/conflict are gh-side, left for later.
  `CREATE TABLE IF NOT EXISTS pr_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orch_id TEXT,
    agent_id TEXT,
    ts INTEGER,
    status TEXT,
    url TEXT,
    base_ref TEXT,
    branch TEXT,
    message TEXT
  )`,
  // Per-orchestration tail cursor into events.jsonl (byte offset). Lives in the
  // DB so a restart doesn't re-ingest; a DB wipe resets it to 0 → full rebuild.
  `CREATE TABLE IF NOT EXISTS ingest_state (
    orch_id TEXT PRIMARY KEY,
    events_offset INTEGER
  )`,
];

// ~/.hark/metrics.db, mirroring store.ts's base-dir logic: the DB sits beside
// the orchestrations dir, so a HARK_ORCH_DIR override (e.g. an isolated
// dogfood instance) carries the metrics DB into the same sandbox.
export function defaultMetricsDbPath(): string {
  const orchDir = defaultOrchDir();
  // defaultOrchDir() is "<base>/orchestrations" (or a HARK_ORCH_DIR override);
  // the metrics DB is its sibling under the same base.
  return path.join(path.dirname(orchDir) || os.homedir(), "metrics.db");
}

// ---- Pure row mappers -------------------------------------------------------
//
// Map the JSON record shapes onto positional SQL bind arrays. Bind values must
// be null | number | bigint | string | Uint8Array — booleans and undefined are
// coerced (undefined → null, boolean → 0/1). Kept pure + exported so the row
// shape is unit-testable without a DB.

type Bind = string | number | bigint | null;

function nv(x: string | number | null | undefined): Bind {
  return x ?? null;
}
function bit(x: boolean | undefined): Bind {
  return x ? 1 : 0;
}

export function orchestrationRow(o: Orchestration): Bind[] {
  return [
    o.id,
    nv(o.name),
    nv(o.goal),
    nv(o.projectRoot),
    nv(o.projectName),
    nv(o.baseRef),
    nv(o.status),
    bit(o.managed),
    nv(o.autonomyLevel),
    nv(o.createdAt),
    nv(o.updatedAt),
  ];
}

export function agentRow(orchId: string, a: OrchAgent): Bind[] {
  return [
    a.id,
    orchId,
    nv(a.role),
    nv(a.branch),
    nv(a.worktreeDir),
    nv(a.sessionId),
    nv(a.pid),
    nv(a.lifecycle),
    nv(a.task),
    nv(a.dependsOn),
    nv(a.blockedReason),
    nv(a.summary),
    nv(a.briefedAt),
    nv(a.killedAt),
    nv(a.headWokeAt),
    nv(a.createdAt),
    nv(a.updatedAt),
  ];
}

// Stable synthetic id for the head's agent row (it has no id of its own).
export function headAgentId(orchId: string): string {
  return `${orchId}#head`;
}

// Project the head onto the agents-table row shape (role='head'). The head
// carries no lifecycle/task — those columns are null.
export function headRow(orchId: string, h: OrchHead): Bind[] {
  return [
    headAgentId(orchId),
    orchId,
    "head",
    nv(h.branch),
    nv(h.worktreeDir),
    nv(h.sessionId),
    nv(h.pid),
    null, // lifecycle
    null, // task
    null, // depends_on
    null, // blocked_reason
    null, // summary
    nv(h.briefedAt),
    null, // killed_at
    null, // head_woke_at
    null, // created_at
    null, // updated_at
  ];
}

// One token-counts time-series sample. Token totals come from the transcript
// metrics the reconcile loop already computed; cost is priced here at ingest.
export interface TokenSampleInput {
  sessionId: string | null;
  agentId: string;
  orchId: string;
  ts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
  model: string | undefined;
}

export function tokenSampleRow(s: TokenSampleInput): Bind[] {
  const costUsd = costForTokens(
    {
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheReadTokens: s.cacheReadTokens,
      cacheCreationTokens: s.cacheCreationTokens,
    },
    s.model,
  );
  return [
    nv(s.sessionId),
    s.agentId,
    s.orchId,
    s.ts,
    s.inputTokens,
    s.outputTokens,
    s.cacheReadTokens,
    s.cacheCreationTokens,
    s.turns,
    costUsd,
    nv(s.model),
  ];
}

export interface PrOutcomeInput {
  orchId: string;
  agentId: string;
  ts: number;
  status: string;
  url?: string;
  baseRef: string;
  branch: string;
  message?: string;
}

export function prOutcomeRow(p: PrOutcomeInput): Bind[] {
  return [
    p.orchId,
    p.agentId,
    p.ts,
    p.status,
    nv(p.url),
    nv(p.baseRef),
    nv(p.branch),
    nv(p.message),
  ];
}

export function eventRow(e: OrchEvent): Bind[] {
  return [
    nv(e.ts),
    nv(e.orchestrationId),
    nv(e.agentId),
    nv(e.kind),
    nv(e.message),
    e.data === undefined ? null : JSON.stringify(e.data),
  ];
}

// ---- Runtime wrapper --------------------------------------------------------

export class MetricsDb {
  private readonly db: DatabaseSync;

  // Opened once, handle reused. Defaults to ~/.hark/metrics.db; pass ":memory:"
  // or a tmpdir path in tests. Applies the schema idempotently on open.
  constructor(dbPath: string = defaultMetricsDbPath()) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
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

  upsertOrchestration(o: Orchestration): void {
    this.db
      .prepare(
        `INSERT INTO orchestrations
           (id, name, goal, project_root, project_name, base_ref, status,
            managed, autonomy_level, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, goal=excluded.goal,
           project_root=excluded.project_root, project_name=excluded.project_name,
           base_ref=excluded.base_ref, status=excluded.status,
           managed=excluded.managed, autonomy_level=excluded.autonomy_level,
           created_at=excluded.created_at, updated_at=excluded.updated_at`,
      )
      .run(...orchestrationRow(o));
  }

  // Upsert an agent-shaped row. Shared by real agents and the head projection.
  private upsertAgentRow(row: Bind[]): void {
    this.db
      .prepare(
        `INSERT INTO agents
           (id, orch_id, role, branch, worktree_dir, session_id, pid, lifecycle,
            task, depends_on, blocked_reason, summary, briefed_at, killed_at,
            head_woke_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           orch_id=excluded.orch_id, role=excluded.role, branch=excluded.branch,
           worktree_dir=excluded.worktree_dir, session_id=excluded.session_id,
           pid=excluded.pid, lifecycle=excluded.lifecycle, task=excluded.task,
           depends_on=excluded.depends_on, blocked_reason=excluded.blocked_reason,
           summary=excluded.summary, briefed_at=excluded.briefed_at,
           killed_at=excluded.killed_at, head_woke_at=excluded.head_woke_at,
           created_at=excluded.created_at, updated_at=excluded.updated_at`,
      )
      .run(...row);
  }

  upsertAgent(orchId: string, a: OrchAgent): void {
    this.upsertAgentRow(agentRow(orchId, a));
  }

  upsertHead(orchId: string, h: OrchHead): void {
    this.upsertAgentRow(headRow(orchId, h));
  }

  // APPEND a token-counts sample. Never an update — this is the time-series.
  // Tolerates a null session_id (an agent whose session hasn't been correlated
  // yet); the row still records agent_id/orch_id.
  insertTokenSample(s: TokenSampleInput): void {
    this.db
      .prepare(
        `INSERT INTO token_samples
           (session_id, agent_id, orch_id, ts, input_tokens, output_tokens,
            cache_read, cache_creation, turns, cost_usd, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...tokenSampleRow(s));
  }

  insertPrOutcome(p: PrOutcomeInput): void {
    this.db
      .prepare(
        `INSERT INTO pr_outcomes
           (orch_id, agent_id, ts, status, url, base_ref, branch, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...prOutcomeRow(p));
  }

  // Append events tailed from events.jsonl. Caller passes only the new lines
  // (read from the stored offset), so this is a straight append.
  appendEvents(events: OrchEvent[]): void {
    if (events.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO events (ts, orch_id, agent_id, kind, message, data_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const e of events) stmt.run(...eventRow(e));
  }

  getEventsOffset(orchId: string): number {
    const row = this.db
      .prepare("SELECT events_offset FROM ingest_state WHERE orch_id = ?")
      .get(orchId) as { events_offset?: number } | undefined;
    return Number(row?.events_offset ?? 0);
  }

  setEventsOffset(orchId: string, offset: number): void {
    this.db
      .prepare(
        `INSERT INTO ingest_state (orch_id, events_offset)
         VALUES (?, ?)
         ON CONFLICT(orch_id) DO UPDATE SET events_offset=excluded.events_offset`,
      )
      .run(orchId, offset);
  }

  close(): void {
    this.db.close();
  }
}
