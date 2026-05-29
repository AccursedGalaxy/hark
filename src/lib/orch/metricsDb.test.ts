import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costForTokens, costOfUsage, pricingForModel } from "../../shared/pricing.js";
import { emptyAgentMetrics, type OrchAgent, type Orchestration } from "../../shared/protocol.js";
import {
  MetricsDb,
  SCHEMA_VERSION,
  headAgentId,
  tokenSampleRow,
} from "./metricsDb.js";

// ---- Cost calculator (the pricing shared with the web bundle) --------------

describe("costForTokens", () => {
  // Rates per 1M: Opus 15/75/1.5/18.75, Sonnet 3/15/0.3/3.75, Haiku 1/5/0.1/1.25.
  // Unknown/undefined falls back to Opus (pessimistic).
  const cases: Array<{
    name: string;
    model: string | undefined;
    tokens: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    };
    expected: number;
  }> = [
    {
      name: "opus, input only",
      model: "claude-opus-4-7",
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      expected: 15,
    },
    {
      name: "opus, all four categories incl. cache rates",
      model: "claude-opus-4-8[1m]",
      tokens: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
      },
      expected: 15 + 75 + 1.5 + 18.75,
    },
    {
      name: "sonnet mixed",
      model: "claude-sonnet-4-6",
      tokens: { inputTokens: 500_000, outputTokens: 200_000, cacheReadTokens: 4_000_000, cacheCreationTokens: 100_000 },
      expected: (500_000 * 3 + 200_000 * 15 + 4_000_000 * 0.3 + 100_000 * 3.75) / 1_000_000,
    },
    {
      name: "haiku mixed",
      model: "claude-haiku-4-5",
      tokens: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      expected: 6,
    },
    {
      name: "unknown model → opus family rate",
      model: "some-future-model",
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      expected: 15,
    },
    {
      name: "undefined model → opus family rate",
      model: undefined,
      tokens: { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      expected: 75,
    },
    {
      name: "zero tokens → zero cost",
      model: "claude-opus-4-7",
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      expected: 0,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(costForTokens(c.tokens, c.model)).toBeCloseTo(c.expected, 6);
    });
  }

  it("matches per-turn costOfUsage for the same totals (single model)", () => {
    const model = "claude-sonnet-4-6";
    const tokens = {
      inputTokens: 123_456,
      outputTokens: 7_890,
      cacheReadTokens: 2_000_000,
      cacheCreationTokens: 50_000,
    };
    const viaUsage = costOfUsage(
      {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadInputTokens: tokens.cacheReadTokens,
        cacheCreationInputTokens: tokens.cacheCreationTokens,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
      pricingForModel(model),
    );
    expect(costForTokens(tokens, model)).toBeCloseTo(viaUsage, 9);
  });
});

// ---- Schema + DB behaviour (in-memory) -------------------------------------

function mkOrch(id: string): Orchestration {
  return {
    id,
    name: "test",
    goal: "ship phase 0",
    projectRoot: "/repo",
    projectName: "hark",
    baseRef: "main",
    status: "active",
    createdAt: 1,
    updatedAt: 2,
    agents: [],
    managed: true,
    autonomyLevel: "L2",
  };
}

function mkAgent(id: string, overrides: Partial<OrchAgent> = {}): OrchAgent {
  return {
    id,
    orchestrationId: "orch-1",
    role: "coder",
    branch: "feat/x",
    worktreeDir: "/wt",
    sessionId: "sess-1",
    pid: 123,
    lifecycle: "running",
    createdAt: 1,
    updatedAt: 2,
    metrics: emptyAgentMetrics(),
    ...overrides,
  };
}

describe("MetricsDb schema", () => {
  it("applies idempotently and records the schema version", () => {
    const path = ":memory:";
    const db = new MetricsDb(path);
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("re-opening an existing DB re-applies the schema without throwing or losing data", () => {
    const dir = mkdtempSync(join(tmpdir(), "hark-metrics-"));
    const file = join(dir, "metrics.db");
    try {
      const a = new MetricsDb(file);
      a.upsertOrchestration(mkOrch("orch-1"));
      a.close();
      // Re-opening the SAME file re-runs every CREATE TABLE IF NOT EXISTS —
      // must not throw, must keep the version, must preserve the prior row.
      const b = new MetricsDb(file);
      expect(b.schemaVersion()).toBe(SCHEMA_VERSION);
      const rows = readAll(b, "SELECT id FROM orchestrations");
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("orch-1");
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MetricsDb upserts", () => {
  it("upserts an orchestration snapshot (insert then update by id)", () => {
    const db = new MetricsDb(":memory:");
    db.upsertOrchestration(mkOrch("orch-1"));
    db.upsertOrchestration({ ...mkOrch("orch-1"), status: "completed" });
    const rows = readAll(db, "SELECT id, status, managed FROM orchestrations");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].managed).toBe(1); // boolean coerced to 0/1
    db.close();
  });

  it("models the head as an agent row with role='head'", () => {
    const db = new MetricsDb(":memory:");
    db.upsertHead("orch-1", {
      sessionId: "head-sess",
      pid: 9,
      worktreeDir: "/repo",
      branch: "main",
      metrics: emptyAgentMetrics(),
    });
    const rows = readAll(db, "SELECT id, role FROM agents WHERE role='head'");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(headAgentId("orch-1"));
    db.close();
  });
});

describe("token_samples", () => {
  it("APPENDS a new row each ingest — two ingests of the same session = two rows", () => {
    const db = new MetricsDb(":memory:");
    const base = {
      sessionId: "sess-1",
      agentId: "agent-1",
      orchId: "orch-1",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheCreationTokens: 10,
      turns: 3,
      model: "claude-opus-4-7",
    };
    db.insertTokenSample({ ...base, ts: 1000 });
    db.insertTokenSample({ ...base, ts: 2000, turns: 5 });
    const rows = readAll(
      db,
      "SELECT ts, turns, cost_usd FROM token_samples WHERE session_id='sess-1' ORDER BY ts",
    );
    expect(rows).toHaveLength(2); // append, not overwrite
    expect(rows[0].ts).toBe(1000);
    expect(rows[1].ts).toBe(2000);
    expect((rows[0].cost_usd as number)).toBeGreaterThan(0); // cost computed at ingest
    db.close();
  });

  it("tolerates a null session_id (uncorrelated agent)", () => {
    const db = new MetricsDb(":memory:");
    expect(() =>
      db.insertTokenSample({
        sessionId: null,
        agentId: "agent-2",
        orchId: "orch-1",
        ts: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        turns: 0,
        model: undefined,
      }),
    ).not.toThrow();
    const rows = readAll(db, "SELECT session_id, agent_id FROM token_samples");
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBeNull();
    expect(rows[0].agent_id).toBe("agent-2");
    db.close();
  });

  it("tokenSampleRow prices cost from model + token counts", () => {
    const row = tokenSampleRow({
      sessionId: "s",
      agentId: "a",
      orchId: "o",
      ts: 1,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 1,
      model: "claude-opus-4-7",
    });
    // cost_usd is the 10th positional value (index 9).
    expect(row[9]).toBeCloseTo(15, 6);
  });
});

describe("pr_outcomes", () => {
  it("records a non-created status (the previously-dropped path)", () => {
    const db = new MetricsDb(":memory:");
    db.insertPrOutcome({
      orchId: "orch-1",
      agentId: "agent-1",
      ts: 5,
      status: "no_base",
      baseRef: "main",
      branch: "feat/x",
      message: "base not on origin",
    });
    const rows = readAll(db, "SELECT status, url, message FROM pr_outcomes");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("no_base");
    expect(rows[0].url).toBeNull();
    expect(rows[0].message).toBe("base not on origin");
    db.close();
  });

  it("records a created status with a url", () => {
    const db = new MetricsDb(":memory:");
    db.insertPrOutcome({
      orchId: "orch-1",
      agentId: "agent-1",
      ts: 6,
      status: "created",
      url: "https://example/pr/1",
      baseRef: "main",
      branch: "feat/x",
    });
    const rows = readAll(db, "SELECT status, url FROM pr_outcomes");
    expect(rows[0].url).toBe("https://example/pr/1");
    db.close();
  });
});

describe("events tail offset", () => {
  it("defaults to 0 and round-trips a stored offset", () => {
    const db = new MetricsDb(":memory:");
    expect(db.getEventsOffset("orch-1")).toBe(0);
    db.setEventsOffset("orch-1", 4096);
    expect(db.getEventsOffset("orch-1")).toBe(4096);
    db.setEventsOffset("orch-1", 8192);
    expect(db.getEventsOffset("orch-1")).toBe(8192); // upsert, not duplicate
    db.close();
  });

  it("appends events 1:1 and decodes data_json", () => {
    const db = new MetricsDb(":memory:");
    db.appendEvents([
      {
        ts: 10,
        orchestrationId: "orch-1",
        agentId: "agent-1",
        kind: "agent_lifecycle",
        message: "coder → done",
        data: { lifecycle: "done" },
      },
      {
        ts: 11,
        orchestrationId: "orch-1",
        kind: "note",
        message: "base ref → main",
      },
    ]);
    const rows = readAll(
      db,
      "SELECT ts, kind, agent_id, data_json FROM events ORDER BY ts",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].data_json).toBe(JSON.stringify({ lifecycle: "done" }));
    expect(rows[1].agent_id).toBeNull();
    expect(rows[1].data_json).toBeNull();
    db.close();
  });
});

// The MetricsDb wrapper is write-only (the DB is a derived read-model queried
// out-of-band by analysis tools, not the server). Tests reach into the
// underlying handle to assert the rows landed as expected.
function readAll(db: MetricsDb, sql: string): Record<string, unknown>[] {
  const handle = (db as unknown as { db: DatabaseSync }).db;
  return handle.prepare(sql).all() as Record<string, unknown>[];
}
