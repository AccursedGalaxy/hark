import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costForTokens, costOfUsage, pricingForModel } from "../../shared/pricing.js";
import {
  emptyAgentMetrics,
  type ContentBlock,
  type OrchAgent,
  type Orchestration,
  type TranscriptEvent,
} from "../../shared/protocol.js";
import {
  MetricsDb,
  SCHEMA_VERSION,
  analyzeCostPerTurn,
  captureTurns,
  classifyToolCalls,
  costOutlierKey,
  headAgentId,
  missingColumnAlters,
  newCostOutlierAlerts,
  tokenSampleRow,
  type AgentCostPerTurn,
  type CapturedTurn,
  type ClassifiedToolCall,
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

// ---- Transport instrumentation: tool-call capture --------------------------

// Build an assistant transcript turn carrying the given tool_use blocks. The
// uuid/ts identify the turn (its batch); each tool_use block is one call.
function asstTurn(
  uuid: string,
  ts: string,
  tools: Array<{ id: string; name: string }>,
  extra: {
    model?: string;
    stopReason?: string;
    isApiError?: boolean;
    retryAttempt?: number;
  } = {},
): TranscriptEvent {
  const blocks: ContentBlock[] = tools.map((t) => ({
    type: "tool_use",
    id: t.id,
    name: t.name,
    input: { stub: true },
  }));
  return {
    kind: "assistant",
    uuid,
    ts,
    blocks,
    model: extra.model,
    stopReason: extra.stopReason,
    isApiError: extra.isApiError,
    retryAttempt: extra.retryAttempt,
  };
}

// Build a tool_result event pairing back to a tool_use block by its id. Absence
// of one of these for a given tool_use id is the dropped/in-flight signal.
function toolResult(
  toolUseId: string,
  opts: { isError?: boolean; ts?: string } = {},
): TranscriptEvent {
  return {
    kind: "tool_result",
    uuid: `res-${toolUseId}`,
    ts: opts.ts ?? "2026-05-29T10:00:01.500Z",
    toolUseId,
    output: "ok",
    isError: opts.isError ?? false,
  };
}

describe("captureTurns (intent extraction)", () => {
  it("projects assistant turns + their tool_use blocks with batch membership", () => {
    const events: TranscriptEvent[] = [
      { kind: "user", uuid: "u0", ts: "2026-05-29T10:00:00.000Z", text: "go" },
      asstTurn(
        "a1",
        "2026-05-29T10:00:01.000Z",
        [
          { id: "toolu_1", name: "Bash" },
          { id: "toolu_2", name: "Edit" },
        ],
        { model: "claude-opus-4-8", stopReason: "tool_use" },
      ),
      asstTurn("a2", "2026-05-29T10:00:02.000Z", [{ id: "toolu_3", name: "Write" }]),
    ];
    const turns = captureTurns(events);
    expect(turns).toHaveLength(2);
    // Turn 0: a batch of two — Bash + Edit, issued together.
    expect(turns[0].turnIndex).toBe(0);
    expect(turns[0].uuid).toBe("a1");
    expect(turns[0].ts).toBe(Date.parse("2026-05-29T10:00:01.000Z"));
    expect(turns[0].model).toBe("claude-opus-4-8");
    expect(turns[0].stopReason).toBe("tool_use");
    // No tool_result events in this stream → every call shows resultSeen=false.
    expect(turns[0].toolCalls).toEqual([
      { callId: "toolu_1", channel: "Bash", batchPosition: 0, resultSeen: false, isError: false, resultTs: null },
      { callId: "toolu_2", channel: "Edit", batchPosition: 1, resultSeen: false, isError: false, resultTs: null },
    ]);
    // Turn index advances per assistant turn (matches the token-metrics count).
    expect(turns[1].turnIndex).toBe(1);
    expect(turns[1].toolCalls).toEqual([
      { callId: "toolu_3", channel: "Write", batchPosition: 0, resultSeen: false, isError: false, resultTs: null },
    ]);
  });

  it("records a turn that issued no tool call (batch size 0) and keeps the index", () => {
    const events: TranscriptEvent[] = [
      {
        kind: "assistant",
        uuid: "a1",
        ts: "2026-05-29T10:00:01.000Z",
        blocks: [{ type: "text", text: "thinking out loud" }],
      },
      asstTurn("a2", "2026-05-29T10:00:02.000Z", [{ id: "toolu_9", name: "Bash" }]),
    ];
    const turns = captureTurns(events);
    expect(turns).toHaveLength(2);
    expect(turns[0].toolCalls).toEqual([]);
    expect(turns[1].turnIndex).toBe(1); // the no-tool turn still consumed index 0
  });

  it("yields a null ts for an unparseable timestamp", () => {
    const turns = captureTurns([asstTurn("a1", "", [{ id: "t1", name: "Bash" }])]);
    expect(turns[0].ts).toBeNull();
  });

  it("pairs each tool_use with its tool_result outcome (seen / error / ts)", () => {
    const events: TranscriptEvent[] = [
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [
        { id: "ok1", name: "Bash" }, // clean result
        { id: "err1", name: "Bash" }, // error result
        { id: "drop1", name: "Edit" }, // NO result (dropped)
      ]),
      toolResult("ok1", { ts: "2026-05-29T10:00:01.500Z" }),
      toolResult("err1", { isError: true }),
    ];
    const [t] = captureTurns(events);
    expect(t.toolCalls[0]).toMatchObject({ callId: "ok1", resultSeen: true, isError: false });
    expect(t.toolCalls[0].resultTs).toBe(Date.parse("2026-05-29T10:00:01.500Z"));
    expect(t.toolCalls[1]).toMatchObject({ callId: "err1", resultSeen: true, isError: true });
    expect(t.toolCalls[2]).toMatchObject({ callId: "drop1", resultSeen: false, isError: false, resultTs: null });
  });

  it("captures the turn's platform self-reports (isApiError / retryAttempt)", () => {
    const events: TranscriptEvent[] = [
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [{ id: "t1", name: "Bash" }], {
        isApiError: true,
        retryAttempt: 2,
      }),
      asstTurn("a2", "2026-05-29T10:00:02.000Z", [{ id: "t2", name: "Bash" }]),
    ];
    const turns = captureTurns(events);
    expect(turns[0]).toMatchObject({ isApiError: true, retryAttempt: 2 });
    expect(turns[1]).toMatchObject({ isApiError: false, retryAttempt: null });
  });
});

describe("MetricsDb.ingestTurns", () => {
  it("INVARIANT: captures tool-call intent with NO tool_result present", () => {
    // The load-bearing guard. This transcript carries assistant tool_use blocks
    // but ZERO tool_result events — i.e. every result was dropped/absent.
    // Intent must still be recorded: it is sourced from the assistant-side
    // tool_use stream, NEVER from a result transport that can drop.
    const db = new MetricsDb(":memory:");
    const events: TranscriptEvent[] = [
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [
        { id: "toolu_a", name: "Bash" },
        { id: "toolu_b", name: "Write" },
      ]),
    ];
    // Sanity: there is genuinely no result event in the stream.
    expect(events.some((e) => e.kind === "tool_result")).toBe(false);
    db.ingestTurns("agent-1", "orch-1", "sess-1", captureTurns(events));
    const calls = readAll(
      db,
      "SELECT call_id, channel, batch_size, batch_position, turn_index, turn_uuid FROM tool_calls ORDER BY batch_position",
    );
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.call_id)).toEqual(["toolu_a", "toolu_b"]);
    expect(calls.map((c) => c.channel)).toEqual(["Bash", "Write"]);
    expect(calls.every((c) => c.batch_size === 2)).toBe(true);
    expect(calls.every((c) => c.turn_uuid === "a1")).toBe(true);
    const turns = readAll(db, "SELECT tool_call_count FROM turns");
    expect(turns).toHaveLength(1);
    expect(turns[0].tool_call_count).toBe(2);
    db.close();
  });

  it("INVARIANT: a dropped result persists result_seen=0 with the intent row intact", () => {
    // The PR-1 guard: a tool_use whose result was dropped must still land an
    // intent row — only its OUTCOME columns reflect the loss (result_seen=0).
    const db = new MetricsDb(":memory:");
    const events: TranscriptEvent[] = [
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [
        { id: "seen", name: "Bash" },
        { id: "dropped", name: "Edit" },
      ]),
      toolResult("seen"), // only the first call's result came back
    ];
    db.ingestTurns("agent-1", "orch-1", "sess-1", captureTurns(events));
    const rows = readAll(
      db,
      "SELECT call_id, result_seen, is_error FROM tool_calls ORDER BY batch_position",
    );
    expect(rows).toHaveLength(2); // BOTH intent rows exist
    expect(rows[0]).toMatchObject({ call_id: "seen", result_seen: 1 });
    expect(rows[1]).toMatchObject({ call_id: "dropped", result_seen: 0 });
    db.close();
  });

  it("is idempotent across re-ingests and only appends genuinely new turns", () => {
    const db = new MetricsDb(":memory:");
    const t1 = asstTurn("a1", "2026-05-29T10:00:01.000Z", [
      { id: "toolu_1", name: "Bash" },
    ]);
    const t2 = asstTurn("a2", "2026-05-29T10:00:02.000Z", [
      { id: "toolu_2", name: "Edit" },
    ]);
    // First tick: one turn.
    expect(db.ingestTurns("agent-1", "orch-1", "sess-1", captureTurns([t1]))).toBe(1);
    // Re-read the SAME transcript next tick: cursor skips it, nothing new.
    expect(db.ingestTurns("agent-1", "orch-1", "sess-1", captureTurns([t1]))).toBe(0);
    // Transcript grew by one turn: only the new turn is ingested.
    expect(db.ingestTurns("agent-1", "orch-1", "sess-1", captureTurns([t1, t2]))).toBe(1);
    expect(db.getTurnsIngested("agent-1")).toBe(2);
    const calls = readAll(db, "SELECT call_id FROM tool_calls ORDER BY call_id");
    expect(calls.map((c) => c.call_id)).toEqual(["toolu_1", "toolu_2"]);
    // call_id is the idempotency backstop: even a full re-scan can't dupe.
    db.setTurnsIngested("agent-1", 0);
    db.ingestTurns("agent-1", "orch-1", "sess-1", captureTurns([t1, t2]));
    expect(readAll(db, "SELECT call_id FROM tool_calls")).toHaveLength(2);
    db.close();
  });

  it("tolerates a null session id (uncorrelated agent) and partitions per agent", () => {
    const db = new MetricsDb(":memory:");
    db.ingestTurns(
      "agent-1",
      "orch-1",
      null,
      captureTurns([asstTurn("a1", "2026-05-29T10:00:01.000Z", [{ id: "x1", name: "Bash" }])]),
    );
    db.ingestTurns(
      "agent-2",
      "orch-1",
      "sess-2",
      captureTurns([asstTurn("b1", "2026-05-29T10:00:01.000Z", [{ id: "y1", name: "Edit" }])]),
    );
    // Same turn_index=0 on two different agents must NOT collide (key is
    // (agent_id, turn_index)).
    const rows = readAll(db, "SELECT agent_id, session_id FROM turns ORDER BY agent_id");
    expect(rows).toHaveLength(2);
    expect(rows[0].session_id).toBeNull();
    expect(rows[1].session_id).toBe("sess-2");
    db.close();
  });
});

// ---- Transport detector: classifyToolCalls --------------------------------

// Map each classified call by id for compact assertions.
function classOf(events: TranscriptEvent[]) {
  const out: Record<string, { outcomeClass: string; cascade: boolean }> = {};
  for (const c of classifyToolCalls(events)) {
    out[c.callId] = { outcomeClass: c.outcomeClass, cascade: c.cascade };
  }
  return out;
}

describe("classifyToolCalls (transport discriminator)", () => {
  it("clean result → ok", () => {
    const events: TranscriptEvent[] = [
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [{ id: "ok1", name: "Bash" }]),
      toolResult("ok1"),
      asstTurn("a2", "2026-05-29T10:00:02.000Z", []),
    ];
    expect(classOf(events).ok1.outcomeClass).toBe("ok");
  });

  it("result absent + session moved on → hark_drop", () => {
    const events: TranscriptEvent[] = [
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [{ id: "drop1", name: "Bash" }]),
      // no result for drop1, but a LATER turn exists → the session moved past it
      asstTurn("a2", "2026-05-29T10:00:02.000Z", []),
    ];
    expect(classOf(events).drop1.outcomeClass).toBe("hark_drop");
  });

  it("result absent BUT the issuing turn self-reported an API error → platform_transient", () => {
    const events: TranscriptEvent[] = [
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [{ id: "p1", name: "Bash" }], {
        isApiError: true,
      }),
      asstTurn("a2", "2026-05-29T10:00:02.000Z", []),
    ];
    // Platform self-report wins over a hark-drop attribution.
    expect(classOf(events).p1.outcomeClass).toBe("platform_transient");
  });

  it("result absent + a platform stop_reason → platform_transient", () => {
    const events: TranscriptEvent[] = [
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [{ id: "p2", name: "Bash" }], {
        stopReason: "max_tokens",
      }),
      asstTurn("a2", "2026-05-29T10:00:02.000Z", []),
    ];
    expect(classOf(events).p2.outcomeClass).toBe("platform_transient");
  });

  it("error result the worker proceeds past → worker_misread_candidate", () => {
    const events: TranscriptEvent[] = [
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [{ id: "e1", name: "Bash" }]),
      toolResult("e1", { isError: true }),
      asstTurn("a2", "2026-05-29T10:00:02.000Z", []),
    ];
    expect(classOf(events).e1.outcomeClass).toBe("worker_misread_candidate");
  });

  it("TAIL GUARD: an in-flight call (no result, no later turn) is NOT a drop", () => {
    const events: TranscriptEvent[] = [
      // a1 is the LAST turn; its result hasn't arrived yet — still in flight.
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [{ id: "tail1", name: "Bash" }]),
    ];
    const cls = classOf(events).tail1.outcomeClass;
    expect(cls).not.toBe("hark_drop");
    expect(cls).toBe("ok"); // pending; re-classified once a result/later turn lands
  });

  it("CASCADE: a trailing run of >=2 missing results in a batch is flagged", () => {
    const events: TranscriptEvent[] = [
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [
        { id: "c0", name: "Bash" }, // clean
        { id: "c1", name: "Bash" }, // dropped — cancel cascade starts
        { id: "c2", name: "Edit" }, // dropped — cancelled by the cascade
      ]),
      toolResult("c0"),
      asstTurn("a2", "2026-05-29T10:00:02.000Z", []),
    ];
    const m = classOf(events);
    expect(m.c0).toEqual({ outcomeClass: "ok", cascade: false });
    expect(m.c1).toEqual({ outcomeClass: "hark_drop", cascade: true });
    expect(m.c2).toEqual({ outcomeClass: "hark_drop", cascade: true });
  });

  it("a single random drop in a batch is NOT flagged as a cascade", () => {
    const events: TranscriptEvent[] = [
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [
        { id: "s0", name: "Bash" }, // dropped (mid-batch, isolated)
        { id: "s1", name: "Bash" }, // clean — breaks the trailing run
      ]),
      toolResult("s1"),
      asstTurn("a2", "2026-05-29T10:00:02.000Z", []),
    ];
    const m = classOf(events);
    expect(m.s0).toEqual({ outcomeClass: "hark_drop", cascade: false });
    expect(m.s1.outcomeClass).toBe("ok");
  });
});

describe("MetricsDb outcome persistence + query API (re-entrant)", () => {
  it("flips an in-flight call's verdict across ticks, then exposes it via the query API", () => {
    const db = new MetricsDb(":memory:");
    const a1 = asstTurn("a1", "2026-05-29T10:00:01.000Z", [{ id: "x1", name: "Bash" }]);
    const a2 = asstTurn("a2", "2026-05-29T10:00:02.000Z", []);

    // Tick 1: only a1 exists, no result → in flight → ok, result_seen=0.
    let events: TranscriptEvent[] = [a1];
    db.ingestTurns("agent-1", "orch-1", "sess-1", captureTurns(events));
    db.applyToolCallOutcomes(classifyToolCalls(events));
    let row = db.getToolCallOutcomes({ agentId: "agent-1" })[0];
    expect(row).toMatchObject({ callId: "x1", resultSeen: false, outcomeClass: "ok" });

    // Tick 2: the session moved on (a2) but the result never came → hark_drop.
    events = [a1, a2];
    db.ingestTurns("agent-1", "orch-1", "sess-1", captureTurns(events));
    db.applyToolCallOutcomes(classifyToolCalls(events));
    row = db.getToolCallOutcomes({ agentId: "agent-1" })[0];
    expect(row).toMatchObject({ resultSeen: false, outcomeClass: "hark_drop" });

    // Tick 3: the result finally lands → result_seen flips 0->1, verdict → ok.
    // (The cursor has long passed a1's turn — only the mutable UPDATE path can
    // do this, which is the whole point of an outcome column over an append log.)
    events = [a1, toolResult("x1"), a2];
    db.applyToolCallOutcomes(classifyToolCalls(events));
    row = db.getToolCallOutcomes({ agentId: "agent-1" })[0];
    expect(row).toMatchObject({ resultSeen: true, outcomeClass: "ok" });
    db.close();
  });

  it("filters by outcome class and surfaces the cascade sub-class", () => {
    const db = new MetricsDb(":memory:");
    const events: TranscriptEvent[] = [
      asstTurn("a1", "2026-05-29T10:00:01.000Z", [
        { id: "c0", name: "Bash" },
        { id: "c1", name: "Bash" },
        { id: "c2", name: "Edit" },
      ]),
      toolResult("c0"),
      asstTurn("a2", "2026-05-29T10:00:02.000Z", []),
    ];
    db.ingestTurns("agent-1", "orch-1", "sess-1", captureTurns(events));
    db.applyToolCallOutcomes(classifyToolCalls(events));
    const drops = db.getToolCallOutcomes({ agentId: "agent-1", outcomeClass: "hark_drop" });
    expect(drops.map((d) => d.callId)).toEqual(["c1", "c2"]);
    expect(drops.every((d) => d.cascade)).toBe(true);
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

function columnNames(db: MetricsDb, table: string): string[] {
  return readAll(db, `PRAGMA table_info(${table})`).map((r) => String(r.name));
}

// ---- Additive migration (the lying-version repair) -------------------------

describe("missingColumnAlters", () => {
  it("emits ADD COLUMN only for columns the table lacks", () => {
    // A v2-shape tool_calls (none of the v3 result-side columns present).
    const v2ToolCalls = [
      "id", "call_id", "agent_id", "orch_id", "session_id", "turn_index",
      "turn_uuid", "batch_size", "batch_position", "channel", "ts",
    ];
    expect(missingColumnAlters("tool_calls", v2ToolCalls)).toEqual([
      "ALTER TABLE tool_calls ADD COLUMN result_seen INTEGER",
      "ALTER TABLE tool_calls ADD COLUMN is_error INTEGER",
      "ALTER TABLE tool_calls ADD COLUMN result_ts INTEGER",
      "ALTER TABLE tool_calls ADD COLUMN outcome_class TEXT",
      "ALTER TABLE tool_calls ADD COLUMN cascade INTEGER",
    ]);
  });

  it("is idempotent — a fully-migrated table needs no ALTERs", () => {
    const v3ToolCalls = [
      "id", "call_id", "channel", "ts",
      "result_seen", "is_error", "result_ts", "outcome_class", "cascade",
    ];
    expect(missingColumnAlters("tool_calls", v3ToolCalls)).toEqual([]);
  });

  it("emits only the still-missing columns for a half-applied migration", () => {
    // Crashed after adding result_seen + is_error; the rest must still come.
    const partial = ["id", "call_id", "channel", "result_seen", "is_error"];
    expect(missingColumnAlters("tool_calls", partial)).toEqual([
      "ALTER TABLE tool_calls ADD COLUMN result_ts INTEGER",
      "ALTER TABLE tool_calls ADD COLUMN outcome_class TEXT",
      "ALTER TABLE tool_calls ADD COLUMN cascade INTEGER",
    ]);
  });

  it("scopes to the requested table (turns gets its own additive columns)", () => {
    const v2Turns = [
      "id", "agent_id", "orch_id", "session_id", "turn_index", "uuid", "ts",
      "model", "tool_call_count", "stop_reason",
    ];
    expect(missingColumnAlters("turns", v2Turns)).toEqual([
      "ALTER TABLE turns ADD COLUMN is_api_error INTEGER",
      "ALTER TABLE turns ADD COLUMN retry_attempt INTEGER",
    ]);
  });
});

describe("MetricsDb migration — repairs the lying-version DB", () => {
  // Reproduce the production bug: a DB whose turns/tool_calls are at the v2
  // shape but whose user_version was already stamped 3 (the version lies). Open
  // MetricsDb on it and prove the v3 columns are added, prior rows survive, and
  // the outcome write/read path works — without ever trusting user_version.
  it("adds the v3 columns to a pre-existing v2 DB whose version already claims 3", () => {
    const dir = mkdtempSync(join(tmpdir(), "hark-metrics-mig-"));
    const file = join(dir, "metrics.db");
    try {
      // Hand-build the v2 shape (no result-side / no platform-self-report cols).
      const raw = new DatabaseSync(file);
      raw.exec(`CREATE TABLE tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, agent_id TEXT,
        orch_id TEXT, session_id TEXT, turn_index INTEGER, turn_uuid TEXT,
        batch_size INTEGER, batch_position INTEGER, channel TEXT, ts INTEGER)`);
      raw.exec("CREATE UNIQUE INDEX idx_tool_calls_call_id ON tool_calls (call_id)");
      raw.exec(`CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, orch_id TEXT,
        session_id TEXT, turn_index INTEGER, uuid TEXT, ts INTEGER, model TEXT,
        tool_call_count INTEGER, stop_reason TEXT)`);
      raw.exec("CREATE UNIQUE INDEX idx_turns_agent_index ON turns (agent_id, turn_index)");
      // A pre-existing v2 row that must survive the migration.
      raw
        .prepare(
          `INSERT INTO tool_calls
             (call_id, agent_id, orch_id, turn_index, batch_size, batch_position, channel, ts)
           VALUES ('old-call', 'ag-old', 'orch-1', 0, 1, 0, 'Bash', 1)`,
        )
        .run();
      raw.exec("PRAGMA user_version = 3"); // the lie: version says 3, columns are v2
      raw.close();

      const db = new MetricsDb(file);

      // The v3 columns now exist on both tables.
      for (const col of ["result_seen", "is_error", "result_ts", "outcome_class", "cascade"]) {
        expect(columnNames(db, "tool_calls")).toContain(col);
      }
      for (const col of ["is_api_error", "retry_attempt"]) {
        expect(columnNames(db, "turns")).toContain(col);
      }

      // Historical row preserved; its new columns are null (attribute forward,
      // never backfill).
      const old = readAll(db, "SELECT call_id, outcome_class, result_seen FROM tool_calls WHERE call_id='old-call'");
      expect(old).toHaveLength(1);
      expect(old[0].outcome_class).toBeNull();
      expect(old[0].result_seen).toBeNull();

      // The previously-dead write path now works end-to-end.
      const turn: CapturedTurn = {
        turnIndex: 0,
        uuid: "u0",
        ts: 10,
        model: "claude-opus-4-8",
        stopReason: "tool_use",
        isApiError: false,
        retryAttempt: null,
        toolCalls: [
          { callId: "c-new", channel: "Bash", batchPosition: 0, resultSeen: true, isError: true, resultTs: 11 },
        ],
      };
      db.ingestTurns("ag-new", "orch-1", "sess-1", [turn]);
      const classified: ClassifiedToolCall[] = [
        {
          callId: "c-new", turnIndex: 0, channel: "Bash", batchPosition: 0,
          batchSize: 1, resultSeen: true, isError: true, resultTs: 11,
          outcomeClass: "worker_misread_candidate", cascade: false,
        },
      ];
      expect(db.applyToolCallOutcomes(classified)).toBe(1);
      const outcomes = db.getToolCallOutcomes({ agentId: "ag-new" });
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].outcomeClass).toBe("worker_misread_candidate");
      expect(outcomes[0].isError).toBe(true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- Cost-per-turn outlier proxy (live wedge detector) ---------------------

describe("analyzeCostPerTurn", () => {
  const mk = (agentId: string, costUsd: number, turns: number): AgentCostPerTurn => ({
    agentId, role: null, costUsd, turns, costPerTurn: turns > 0 ? costUsd / turns : 0,
  });

  it("flags the cost-per-turn outlier (the mprai81x shape) and not the healthy peers", () => {
    // Head + 4 healthy workers cluster near $0.9–1.3/turn; one wedged worker at
    // $3.82/turn. The wedged one trips; nobody else does.
    const rows = [
      mk("head", 297, 338), // ~0.88/turn
      mk("w1", 195, 152), // ~1.28
      mk("w2", 54, 145), // ~0.37
      mk("w3", 41, 123), // ~0.33
      mk("w4", 33, 115), // ~0.29
      mk("wedged", 630, 165), // ~3.82
    ];
    const report = analyzeCostPerTurn(rows);
    expect(report.outliers.map((o) => o.agentId)).toEqual(["wedged"]);
    expect(report.outliers[0].z).toBeGreaterThan(2);
    // Sorted desc by cost/turn, wedged on top.
    expect(report.agents[0].agentId).toBe("wedged");
  });

  it("ignores agents below minTurns — a 2-turn agent can't be a stable outlier", () => {
    const rows = [
      mk("a", 10, 100), mk("b", 11, 100), mk("c", 12, 100),
      mk("spike", 8, 2), // $4/turn but only 2 turns — noise, excluded
    ];
    const report = analyzeCostPerTurn(rows, { minTurns: 5 });
    expect(report.agents.map((a) => a.agentId)).not.toContain("spike");
    expect(report.outliers).toEqual([]);
  });

  it("returns no outliers when the cohort is too small for a stable distribution", () => {
    const rows = [mk("a", 100, 10), mk("b", 1, 10)]; // 2 agents < minAgents default 3
    const report = analyzeCostPerTurn(rows);
    expect(report.outliers).toEqual([]);
  });

  it("returns no outliers when every agent costs the same per turn (mad 0, meanAd 0)", () => {
    const rows = [mk("a", 10, 10), mk("b", 20, 20), mk("c", 30, 30)]; // all $1/turn
    const report = analyzeCostPerTurn(rows);
    expect(report.mad).toBe(0);
    expect(report.outliers).toEqual([]);
  });
});

describe("MetricsDb.costPerTurnReport", () => {
  it("computes per-agent cost/turn from token_samples and flags the outlier", () => {
    const db = new MetricsDb(":memory:");
    // Cumulative token_samples (the table appends; MAX = final standing). Model
    // the head + healthy workers + one wedged worker burning input every turn.
    const sample = (agentId: string, turns: number, inputTokens: number) =>
      db.insertTokenSample({
        sessionId: null, agentId, orchId: "orch-1", ts: turns,
        inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        turns, model: "claude-opus-4-8",
      });
    // cost is priced from tokens; pick input so cost/turn separates clearly.
    sample("head", 300, 300 * 60_000); // ~uniform
    sample("w1", 150, 150 * 60_000);
    sample("w2", 140, 140 * 55_000);
    sample("w3", 120, 120 * 58_000);
    // wedged: same turns as w1 but ~5x the input/turn → a clear cost/turn spike.
    sample("wedged", 150, 150 * 300_000);

    const report = db.costPerTurnReport("orch-1");
    expect(report.outliers.map((o) => o.agentId)).toEqual(["wedged"]);
    expect(report.agents[0].agentId).toBe("wedged");
    expect(report.agents.find((a) => a.agentId === "wedged")!.costPerTurn).toBeGreaterThan(
      report.agents.find((a) => a.agentId === "head")!.costPerTurn,
    );
    db.close();
  });

  it("scopes to one orchestration", () => {
    const db = new MetricsDb(":memory:");
    db.insertTokenSample({
      sessionId: null, agentId: "other", orchId: "orch-2", ts: 1,
      inputTokens: 999_000_000, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, turns: 1, model: "claude-opus-4-8",
    });
    const report = db.costPerTurnReport("orch-1");
    expect(report.agents).toEqual([]);
    db.close();
  });
});

describe("newCostOutlierAlerts (fire-once live flag)", () => {
  const report = {
    agents: [],
    median: 0.9,
    mad: 0.05,
    outliers: [
      { agentId: "wedged", role: "coder", costUsd: 630, turns: 165, costPerTurn: 3.82, z: 54.6 },
    ],
  };

  it("emits an alert for an unflagged outlier with a review-framed message", () => {
    const alerts = newCostOutlierAlerts("orch-1", report, new Set());
    expect(alerts).toHaveLength(1);
    expect(alerts[0].agentId).toBe("wedged");
    expect(alerts[0].message).toContain("$3.82/turn");
    expect(alerts[0].message).toContain("modz 54.6");
    expect(alerts[0].message).toContain("review");
  });

  it("suppresses an outlier already flagged this lifetime (no re-emit each tick)", () => {
    const flagged = new Set([costOutlierKey("orch-1", "wedged")]);
    expect(newCostOutlierAlerts("orch-1", report, flagged)).toEqual([]);
  });

  it("keys are scoped per-orchestration — same agentId in another orch still fires", () => {
    const flagged = new Set([costOutlierKey("orch-1", "wedged")]);
    const alerts = newCostOutlierAlerts("orch-2", report, flagged);
    expect(alerts).toHaveLength(1);
  });
});
