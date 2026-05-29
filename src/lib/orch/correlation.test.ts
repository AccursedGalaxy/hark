import { describe, it, expect } from "vitest";
import {
  correlateAgentSessions,
  correlateHeadSessions,
  liveSessionIdSet,
  type LiveSessionRef,
} from "./correlation.js";
import {
  emptyAgentMetrics,
  type OrchAgent,
  type OrchHead,
  type Orchestration,
} from "../../shared/protocol.js";

function head(over: Partial<OrchHead>): OrchHead {
  return {
    sessionId: null,
    pid: null,
    worktreeDir: "/wt/head",
    branch: "hark/o/head",
    metrics: emptyAgentMetrics(),
    ...over,
  };
}

function agent(over: Partial<OrchAgent>): OrchAgent {
  return {
    id: "agent-1",
    orchestrationId: "orch-1",
    role: "coder",
    branch: "b",
    worktreeDir: "/wt",
    sessionId: null,
    pid: null,
    lifecycle: "spawning",
    createdAt: 0,
    updatedAt: 0,
    metrics: emptyAgentMetrics(),
    ...over,
  };
}

function orch(over: Partial<Orchestration>): Orchestration {
  return {
    id: "orch-1",
    name: "o",
    goal: "g",
    projectRoot: "/r",
    projectName: "r",
    baseRef: "main",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    agents: [],
    ...over,
  };
}

const live: LiveSessionRef[] = [
  { sessionId: "sess-aaa", pid: 100 },
  { sessionId: "sess-bbb", pid: 200 },
];

describe("correlateAgentSessions", () => {
  it("links agents to live sessions by pid when the id is missing", () => {
    const orchs = [
      orch({
        agents: [
          agent({ id: "a1", pid: 100, sessionId: null }),
          agent({ id: "a2", pid: 200, sessionId: null }),
        ],
      }),
    ];
    const links = correlateAgentSessions(orchs, live);
    expect(links).toEqual([
      { orchId: "orch-1", agentId: "a1", sessionId: "sess-aaa" },
      { orchId: "orch-1", agentId: "a2", sessionId: "sess-bbb" },
    ]);
  });

  it("skips agents that already have a session id", () => {
    const orchs = [
      orch({ agents: [agent({ id: "a1", pid: 100, sessionId: "sess-aaa" })] }),
    ];
    expect(correlateAgentSessions(orchs, live)).toEqual([]);
  });

  it("skips agents with no pid and pids with no live session", () => {
    const orchs = [
      orch({
        agents: [
          agent({ id: "a1", pid: null }),
          agent({ id: "a2", pid: 999 }),
        ],
      }),
    ];
    expect(correlateAgentSessions(orchs, live)).toEqual([]);
  });

  it("ignores non-active orchestrations", () => {
    const orchs = [
      orch({
        status: "archived",
        agents: [agent({ id: "a1", pid: 100, sessionId: null })],
      }),
    ];
    expect(correlateAgentSessions(orchs, live)).toEqual([]);
  });
});

describe("correlateHeadSessions", () => {
  it("links a head to its live session by pid", () => {
    const orchs = [orch({ head: head({ pid: 100 }) })];
    expect(correlateHeadSessions(orchs, live)).toEqual([
      { orchId: "orch-1", sessionId: "sess-aaa" },
    ]);
  });

  it("skips heads already linked, headless orchs, and inactive orchs", () => {
    expect(
      correlateHeadSessions([orch({ head: head({ pid: 100, sessionId: "sess-aaa" }) })], live),
    ).toEqual([]);
    expect(correlateHeadSessions([orch({})], live)).toEqual([]);
    expect(
      correlateHeadSessions(
        [orch({ status: "archived", head: head({ pid: 100 }) })],
        live,
      ),
    ).toEqual([]);
  });
});

describe("liveSessionIdSet", () => {
  it("collects the live session ids", () => {
    const s = liveSessionIdSet(live);
    expect(s.has("sess-aaa")).toBe(true);
    expect(s.has("sess-bbb")).toBe(true);
    expect(s.has("nope")).toBe(false);
  });
});
