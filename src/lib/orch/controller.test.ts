import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OrchStore } from "./store.js";
import { Orchestrator } from "./orchestrator.js";
import {
  AutonomyController,
  buildAdvancePush,
  buildHeadNotification,
  buildNudge,
  decideAutonomyAction,
  decideCircuitBreaker,
  decideHeadRouting,
  DEFAULT_RUNAWAY_LIMIT,
  DEFAULT_NO_PROGRESS_TURNS,
  DEFAULT_NO_PROGRESS_TOOL_CALLS,
  DEFAULT_HARD_TURN_CEILING,
  DEFAULT_HARD_TOKEN_CEILING,
  buildJudgeActivityView,
  buildStuckJudgePrompt,
  parseJudgeVerdict,
  summarizeToolCall,
  finalMarkerText,
  leanSummary,
  markerForLifecycle,
  metricsFromTranscript,
  scanMarkers,
  toolUseSignature,
  toolUseSignatures,
  trailingRepeat,
  transcriptText,
  type AutonomyState,
  type HeadNotification,
} from "./controller.js";
import {
  BLOCKED_MARKER,
  DONE_MARKER,
  HANDOFF_MARKER,
} from "./roles.js";
import type { OrchAgent, TranscriptEvent } from "../../shared/protocol.js";

// ---- pure helpers ----------------------------------------------------------

describe("scanMarkers", () => {
  it("detects each marker and extracts the preceding summary", () => {
    const done = scanMarkers(`Implemented the feature.\nTests pass.\n${DONE_MARKER}`);
    expect(done.kind).toBe("done");
    expect(done.summary).toContain("Tests pass.");

    expect(scanMarkers(`Need a DB password.\n${BLOCKED_MARKER}`).kind).toBe(
      "blocked",
    );
    expect(scanMarkers(`Handoff to tester.\n${HANDOFF_MARKER}`).kind).toBe(
      "handoff",
    );
  });

  it("returns null when no marker is present", () => {
    expect(scanMarkers("just some prose").kind).toBeNull();
  });

  it("the last marker wins (a stale earlier one is ignored)", () => {
    const text = `${BLOCKED_MARKER}\n...later...\nall good\n${DONE_MARKER}`;
    expect(scanMarkers(text).kind).toBe("done");
  });
});

describe("decideHeadRouting (managed PM-head, §3.5/§3.6)", () => {
  const at = (over: Partial<Parameters<typeof decideHeadRouting>[0]>) =>
    decideHeadRouting({
      managed: true,
      marker: "done",
      autonomyLevel: "L2",
      idle: false,
      ...over,
    });

  it("escalates a blocker to the human regardless of mode or dial", () => {
    expect(at({ marker: "blocked", idle: false, autonomyLevel: "L0" }).type).toBe(
      "escalate",
    );
    expect(at({ marker: "blocked", idle: true, autonomyLevel: "L3" }).type).toBe(
      "escalate",
    );
  });

  it("pulls an advance while the conversation is active (no push)", () => {
    expect(at({ marker: "done", idle: false }).type).toBe("pull");
    expect(at({ marker: "handoff", idle: false }).type).toBe("pull");
  });

  it("pushes an advance when idle and the dial is L2/L3", () => {
    expect(at({ marker: "done", idle: true, autonomyLevel: "L2" }).type).toBe("push");
    expect(at({ marker: "handoff", idle: true, autonomyLevel: "L3" }).type).toBe(
      "push",
    );
  });

  it("waits (none) when idle but the dial is L0/L1", () => {
    expect(at({ marker: "done", idle: true, autonomyLevel: "L0" }).type).toBe("none");
    expect(at({ marker: "done", idle: true, autonomyLevel: "L1" }).type).toBe("none");
  });

  it("does nothing for a non-managed (executor) head", () => {
    expect(
      decideHeadRouting({ managed: false, marker: "blocked", autonomyLevel: "L2", idle: true }).type,
    ).toBe("none");
  });
});

describe("buildAdvancePush", () => {
  it("renders an idle-advance turn citing the dial + the event", () => {
    const text = buildAdvancePush(
      {
        role: "coder",
        agentId: "a1",
        branch: "feat",
        marker: "done",
        summary: "added parser",
        diffstat: "2 files +30/-4",
        commitCount: 2,
      },
      "L2",
    );
    expect(text).toContain("L2");
    expect(text).toContain("coder");
    expect(text).toContain("feat");
    expect(text.toLowerCase()).toContain("advance");
    expect(text.toLowerCase()).toContain("never land");
  });
});

describe("transcriptText", () => {
  it("concatenates only assistant text blocks", () => {
    const events: TranscriptEvent[] = [
      { kind: "user", uuid: "u", ts: "t", text: "do it" },
      {
        kind: "assistant",
        uuid: "a",
        ts: "t",
        blocks: [
          { type: "thinking", text: "hmm" },
          { type: "text", text: "done thinking" },
          { type: "tool_use", id: "x", name: "Bash", input: {} },
        ],
      },
    ];
    expect(transcriptText(events)).toBe("done thinking");
  });
});

describe("metricsFromTranscript", () => {
  it("sums usage and counts assistant turns", () => {
    const mkAssistant = (i: number, o: number): TranscriptEvent => ({
      kind: "assistant",
      uuid: "a",
      ts: "t",
      blocks: [{ type: "text", text: "x" }],
      usage: {
        inputTokens: i,
        outputTokens: o,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 5,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    });
    const m = metricsFromTranscript([
      { kind: "user", uuid: "u", ts: "t", text: "hi" },
      mkAssistant(100, 20),
      mkAssistant(200, 30),
    ]);
    expect(m.turns).toBe(2);
    expect(m.inputTokens).toBe(300);
    expect(m.outputTokens).toBe(50);
    expect(m.cacheReadTokens).toBe(10);
  });

  it("computes costUsd per-turn and captures the last-seen model", () => {
    const assistant = (
      model: string,
      input: number,
      output: number,
    ): TranscriptEvent => ({
      kind: "assistant",
      uuid: "a",
      ts: "t",
      blocks: [{ type: "text", text: "x" }],
      model,
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    });
    // 1M opus input ($15) + 1M sonnet output ($15) = $30; model = last seen.
    const m = metricsFromTranscript([
      assistant("claude-opus-4-7", 1_000_000, 0),
      assistant("claude-sonnet-4-6", 0, 1_000_000),
    ]);
    expect(m.costUsd).toBeCloseTo(30, 6);
    expect(m.model).toBe("claude-sonnet-4-6");
  });
});

describe("decideAutonomyAction", () => {
  const base: AutonomyState = {
    lifecycle: "running",
    sessionReady: true,
    briefingDelivered: true,
    stopped: false,
    scan: { kind: null, summary: "" },
    fullSummary: "",
    nudges: 0,
    maxNudges: 3,
  };

  it("does nothing for terminal lifecycles", () => {
    expect(
      decideAutonomyAction({ ...base, lifecycle: "done" }).type,
    ).toBe("none");
  });

  it("delivers the briefing once the session is ready", () => {
    expect(
      decideAutonomyAction({
        ...base,
        briefingDelivered: false,
        lifecycle: "spawning",
      }).type,
    ).toBe("deliver_briefing");
  });

  it("waits (none) when not briefed and session not ready", () => {
    expect(
      decideAutonomyAction({
        ...base,
        briefingDelivered: false,
        sessionReady: false,
        lifecycle: "spawning",
      }).type,
    ).toBe("none");
  });

  it("advances to done/blocked/review on markers", () => {
    expect(
      decideAutonomyAction({ ...base, scan: { kind: "done", summary: "" } }),
    ).toMatchObject({ type: "set_lifecycle", lifecycle: "done" });
    expect(
      decideAutonomyAction({ ...base, scan: { kind: "blocked", summary: "why" } }),
    ).toMatchObject({ type: "set_lifecycle", lifecycle: "blocked", reason: "why" });
    expect(
      decideAutonomyAction({ ...base, scan: { kind: "handoff", summary: "h" } }),
    ).toMatchObject({ type: "set_lifecycle", lifecycle: "review" });
  });

  it("nudges when the agent stops silently, up to the bound", () => {
    expect(
      decideAutonomyAction({ ...base, stopped: true, nudges: 0 }).type,
    ).toBe("nudge");
    expect(
      decideAutonomyAction({ ...base, stopped: true, nudges: 2 }).type,
    ).toBe("nudge");
  });

  it("escalates to blocked once nudges are exhausted", () => {
    expect(
      decideAutonomyAction({ ...base, stopped: true, nudges: 3 }),
    ).toMatchObject({ type: "set_lifecycle", lifecycle: "blocked" });
  });

  it("does nothing when stopped but not in running state", () => {
    expect(
      decideAutonomyAction({ ...base, stopped: true, lifecycle: "review" }).type,
    ).toBe("none");
  });
});

describe("buildNudge", () => {
  it("references the done and blocked markers", () => {
    const n = buildNudge();
    expect(n).toContain(DONE_MARKER);
    expect(n).toContain(BLOCKED_MARKER);
  });
});

describe("buildHeadNotification", () => {
  it("carries role, agentId, branch, marker, diffstat, commits, summary", () => {
    const note: HeadNotification = {
      role: "coder",
      agentId: "agent-2",
      branch: "hark/ship/coder-a",
      marker: "done",
      summary: "Implemented the parser; tests green.",
      diffstat: "2 files +30/-4",
      commitCount: 3,
    };
    const text = buildHeadNotification(note);
    expect(text).toContain("coder");
    expect(text).toContain("agent-2");
    expect(text).toContain("hark/ship/coder-a");
    expect(text.toLowerCase()).toContain("done");
    expect(text).toContain("2 files +30/-4");
    expect(text).toContain("3");
    expect(text).toContain("Implemented the parser");
    // It must NOT instruct the head to read the transcript (context discipline).
    expect(text.toLowerCase()).not.toContain("transcript");
  });
});

// ---- controller integration (real store, fake IO) -------------------------

let dir: string;
let store: OrchStore;
let orchestrator: Orchestrator;

interface Sent {
  agentId: string;
  text: string;
}

function makeController(opts: {
  ready: boolean;
  transcript?: TranscriptEvent[];
  maxNudges?: number;
}) {
  const sent: Sent[] = [];
  const controller = new AutonomyController({
    store,
    orchestrator,
    readTranscript: async () => opts.transcript ?? [],
    sendText: async (agent, text) => {
      sent.push({ agentId: agent.id, text });
    },
    sessionReady: async () => opts.ready,
    now: () => 1_000_000,
    maxNudges: opts.maxNudges ?? 3,
  });
  return { controller, sent };
}

async function makeAgent(
  sessionId: string | null,
  lifecycle: OrchAgent["lifecycle"],
): Promise<{ orchId: string; agentId: string }> {
  const o = await store.createOrchestration({
    name: "Ship login",
    goal: "Add OAuth",
    projectRoot: "/home/u/app",
    projectName: "app",
    baseRef: "main",
  });
  const agent = await store.addAgent(o.id, {
    role: "coder",
    branch: "hark/ship-login/coder-1",
    worktreeDir: "/wt/coder",
    sessionId,
    lifecycle,
  });
  return { orchId: o.id, agentId: agent!.id };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-ctrl-"));
  store = new OrchStore(dir);
  orchestrator = new Orchestrator({
    store,
    addWorktree: async () => {},
    removeWorktree: async () => {},
    spawnSession: async () => ({ pid: 1 }),
  });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("AutonomyController.onAgentSignal", () => {
  it("delivers the briefing once ready, then marks the agent running", async () => {
    const { orchId, agentId } = await makeAgent("sess-1", "spawning");
    const { controller, sent } = makeController({ ready: true });

    const action = await controller.onAgentSignal(orchId, agentId, {
      stopped: false,
    });
    expect(action.type).toBe("deliver_briefing");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("**Coder**");

    const o = await store.getOrchestration(orchId);
    expect(o!.agents[0].lifecycle).toBe("running");
    expect(o!.agents[0].briefedAt).toBe(1_000_000);
  });

  it("does not deliver the briefing while the session isn't ready", async () => {
    const { orchId, agentId } = await makeAgent("sess-1", "spawning");
    const { controller, sent } = makeController({ ready: false });
    const action = await controller.onAgentSignal(orchId, agentId, {
      stopped: false,
    });
    expect(action.type).toBe("none");
    expect(sent).toHaveLength(0);
  });

  it("nudges a running agent that stops without a marker, then blocks it", async () => {
    const { orchId, agentId } = await makeAgent("sess-1", "running");
    // Already briefed.
    await store.updateAgent(orchId, agentId, (a) => (a.briefedAt = 1));
    const { controller, sent } = makeController({
      ready: true,
      transcript: [
        { kind: "assistant", uuid: "a", ts: "t", blocks: [{ type: "text", text: "still going" }] },
      ],
      maxNudges: 2,
    });

    // Two nudges, then escalation.
    expect((await controller.onAgentSignal(orchId, agentId, { stopped: true })).type).toBe("nudge");
    expect((await controller.onAgentSignal(orchId, agentId, { stopped: true })).type).toBe("nudge");
    const third = await controller.onAgentSignal(orchId, agentId, { stopped: true });
    expect(third).toMatchObject({ type: "set_lifecycle", lifecycle: "blocked" });

    expect(sent.filter((s) => s.text.includes(DONE_MARKER))).toHaveLength(2);
    const o = await store.getOrchestration(orchId);
    expect(o!.agents[0].lifecycle).toBe("blocked");
    expect(o!.agents[0].metrics.interventions).toBe(1);
  });

  it("marks done when the transcript carries the DONE marker", async () => {
    const { orchId, agentId } = await makeAgent("sess-1", "running");
    await store.updateAgent(orchId, agentId, (a) => (a.briefedAt = 1));
    const { controller } = makeController({
      ready: true,
      transcript: [
        {
          kind: "assistant",
          uuid: "a",
          ts: "t",
          blocks: [{ type: "text", text: `All done.\n${DONE_MARKER}` }],
        },
      ],
    });
    const action = await controller.onAgentSignal(orchId, agentId, { stopped: true });
    expect(action).toMatchObject({ type: "set_lifecycle", lifecycle: "done" });
    const o = await store.getOrchestration(orchId);
    expect(o!.agents[0].lifecycle).toBe("done");
  });

  it("accumulates token metrics from the transcript", async () => {
    const { orchId, agentId } = await makeAgent("sess-1", "running");
    await store.updateAgent(orchId, agentId, (a) => (a.briefedAt = 1));
    const { controller } = makeController({
      ready: true,
      transcript: [
        {
          kind: "assistant",
          uuid: "a",
          ts: "t",
          blocks: [{ type: "text", text: "working" }],
          usage: {
            inputTokens: 500,
            outputTokens: 120,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            webSearchRequests: 0,
            webFetchRequests: 0,
          },
        },
      ],
    });
    await controller.onAgentSignal(orchId, agentId, { stopped: true });
    const o = await store.getOrchestration(orchId);
    expect(o!.agents[0].metrics.inputTokens).toBe(500);
    expect(o!.agents[0].metrics.turns).toBe(1);
  });
});

// ---- head-session model ----------------------------------------------------

interface HeadSend {
  text: string;
}

function makeHeadAwareController(opts: {
  ready: boolean;
  transcript?: TranscriptEvent[];
  headTranscript?: TranscriptEvent[];
  headReady?: boolean;
}) {
  const sent: Sent[] = [];
  const headSent: HeadSend[] = [];
  const controller = new AutonomyController({
    store,
    orchestrator,
    readTranscript: async (sessionId) =>
      (sessionId === "sess-head" ? opts.headTranscript : opts.transcript) ?? [],
    sendText: async (agent, text) => {
      sent.push({ agentId: agent.id, text });
    },
    sessionReady: async () => opts.ready,
    headReady: async () => opts.headReady ?? opts.ready,
    sendToHead: async (_orch, text) => {
      headSent.push({ text });
    },
    agentGitSummary: async () => ({ diffstat: "1 file +5/-0", commitCount: 2 }),
    now: () => 1_000_000,
  });
  return { controller, sent, headSent };
}

async function makeOrchWithHead(): Promise<string> {
  const o = await store.createOrchestration({
    name: "Ship login",
    goal: "Add OAuth",
    projectRoot: "/home/u/app",
    projectName: "app",
    baseRef: "main",
  });
  await store.setHead(o.id, {
    sessionId: "sess-head",
    pid: 999,
    worktreeDir: "/wt/head",
    branch: "hark/ship-login/head",
  });
  return o.id;
}

describe("AutonomyController head notifications", () => {
  it("notifies the head when a worker hits a marker", async () => {
    const orchId = await makeOrchWithHead();
    const agent = await store.addAgent(orchId, {
      role: "coder",
      branch: "hark/ship-login/coder-1",
      worktreeDir: "/wt/coder",
      sessionId: "sess-coder",
      lifecycle: "running",
    });
    await store.updateAgent(orchId, agent!.id, (a) => (a.briefedAt = 1));

    const { controller, headSent } = makeHeadAwareController({
      ready: true,
      transcript: [
        {
          kind: "assistant",
          uuid: "a",
          ts: "t",
          blocks: [{ type: "text", text: `Implemented it.\n${DONE_MARKER}` }],
        },
      ],
    });

    await controller.onAgentSignal(orchId, agent!.id, { stopped: true });

    expect(headSent).toHaveLength(1);
    expect(headSent[0].text).toContain("coder");
    expect(headSent[0].text.toLowerCase()).toContain("done");
    expect(headSent[0].text).toContain("1 file +5/-0");

    const events = await store.readEvents(orchId);
    expect(events.some((e) => e.kind === "head_notified")).toBe(true);
  });

  it("does not re-notify the head on a stable (non-transition) tick", async () => {
    const orchId = await makeOrchWithHead();
    const agent = await store.addAgent(orchId, {
      role: "coder",
      branch: "hark/ship-login/coder-1",
      worktreeDir: "/wt/coder",
      sessionId: "sess-coder",
      lifecycle: "done", // already terminal
    });
    await store.updateAgent(orchId, agent!.id, (a) => (a.briefedAt = 1));
    const { controller, headSent } = makeHeadAwareController({
      ready: true,
      transcript: [
        {
          kind: "assistant",
          uuid: "a",
          ts: "t",
          blocks: [{ type: "text", text: `done.\n${DONE_MARKER}` }],
        },
      ],
    });
    await controller.onAgentSignal(orchId, agent!.id, { stopped: false });
    expect(headSent).toHaveLength(0);
  });
});

describe("AutonomyController managed PM-head routing", () => {
  interface Escalation {
    role: string;
    reason: string;
  }
  async function setup(opts: {
    marker: string;
    lastHumanAt: number;
    autonomyLevel?: "L0" | "L1" | "L2" | "L3";
    withPush?: boolean;
  }) {
    const o = await store.createManagedHead({
      name: "PM: app",
      goal: "g",
      projectRoot: "/home/u/app",
      projectName: "app",
      baseRef: "main",
      sessionId: "sess-head",
      branch: "main",
      autonomyLevel: opts.autonomyLevel ?? "L2",
    });
    await store.updateOrchestration(o.id, (x) => {
      x.lastHumanAt = opts.lastHumanAt;
    });
    const agent = await store.addAgent(o.id, {
      role: "coder",
      branch: "hark/app/coder-1",
      worktreeDir: "/wt/coder",
      sessionId: "sess-coder",
      lifecycle: "running",
    });
    await store.updateAgent(o.id, agent!.id, (a) => (a.briefedAt = 1));

    const escalations: Escalation[] = [];
    const pushes: string[] = [];
    const headSent: string[] = [];
    const controller = new AutonomyController({
      store,
      orchestrator,
      readTranscript: async () => [
        {
          kind: "assistant",
          uuid: "a",
          ts: "t",
          blocks: [{ type: "text", text: `summary line\n${opts.marker}` }],
        },
      ],
      sendText: async () => {},
      sessionReady: async () => true,
      sendToHead: async (_o, text) => {
        headSent.push(text);
      },
      agentGitSummary: async () => ({ diffstat: "1 file +5/-0", commitCount: 1 }),
      escalateToHuman: async (_o, a, reason) => {
        escalations.push({ role: a.role, reason });
      },
      pushHeadTurn: opts.withPush
        ? async (_o, text) => {
            pushes.push(text);
          }
        : undefined,
      idleThresholdMs: 1000,
      now: () => 1_000_000,
    });
    return { controller, orchId: o.id, agentId: agent!.id, escalations, pushes, headSent };
  }

  it("escalates a worker BLOCKED to the human, never pushing into the live pane", async () => {
    const { controller, orchId, agentId, escalations, pushes, headSent } = await setup({
      marker: BLOCKED_MARKER,
      lastHumanAt: 1_000_000, // active
      withPush: true,
    });
    await controller.onAgentSignal(orchId, agentId, { stopped: true });
    expect(escalations).toHaveLength(1);
    expect(escalations[0].role).toBe("coder");
    expect(pushes).toHaveLength(0);
    // A managed head never gets a routine worker update pushed into its pane.
    expect(headSent).toHaveLength(0);
  });

  it("pushes an advance turn when the head is idle and the dial is L2", async () => {
    const { controller, orchId, agentId, escalations, pushes } = await setup({
      marker: DONE_MARKER,
      lastHumanAt: 0, // idle (now=1_000_000, threshold 1000)
      autonomyLevel: "L2",
      withPush: true,
    });
    await controller.onAgentSignal(orchId, agentId, { stopped: true });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("L2");
    expect(pushes[0].toLowerCase()).toContain("advance");
    expect(escalations).toHaveLength(0);
  });

  it("pulls (no push) when a worker finishes while the conversation is active", async () => {
    const { controller, orchId, agentId, pushes, headSent } = await setup({
      marker: DONE_MARKER,
      lastHumanAt: 1_000_000, // active
      autonomyLevel: "L2",
      withPush: true,
    });
    await controller.onAgentSignal(orchId, agentId, { stopped: true });
    expect(pushes).toHaveLength(0);
    expect(headSent).toHaveLength(0);
    // The transition is still recorded for the newsroom to pull.
    const events = await store.readEvents(orchId);
    expect(events.some((e) => e.kind === "head_notified")).toBe(true);
  });

  it("does not push at L1 even when idle (waits for the human's nod)", async () => {
    const { controller, orchId, agentId, pushes } = await setup({
      marker: DONE_MARKER,
      lastHumanAt: 0,
      autonomyLevel: "L1",
      withPush: true,
    });
    await controller.onAgentSignal(orchId, agentId, { stopped: true });
    expect(pushes).toHaveLength(0);
  });
});

describe("AutonomyController.onHeadSignal", () => {
  it("delivers the head briefing once, when the head session is ready", async () => {
    const orchId = await makeOrchWithHead();
    const { controller, headSent } = makeHeadAwareController({
      ready: true,
      headTranscript: [],
    });
    await controller.onHeadSignal(orchId, { stopped: false });
    expect(headSent).toHaveLength(1);
    expect(headSent[0].text.toLowerCase()).toContain("head");

    const o = await store.getOrchestration(orchId);
    expect(o!.head!.briefedAt).toBe(1_000_000);

    // Idempotent — a second tick doesn't re-brief.
    await controller.onHeadSignal(orchId, { stopped: false });
    expect(headSent).toHaveLength(1);
  });

  it("completes the orchestration when the head emits DONE", async () => {
    const orchId = await makeOrchWithHead();
    await store.updateHead(orchId, (h) => (h.briefedAt = 1));
    const { controller } = makeHeadAwareController({
      ready: true,
      headTranscript: [
        {
          kind: "assistant",
          uuid: "a",
          ts: "t",
          blocks: [{ type: "text", text: `Mission accomplished.\n${DONE_MARKER}` }],
        },
      ],
    });
    await controller.onHeadSignal(orchId, { stopped: true });
    const o = await store.getOrchestration(orchId);
    expect(o!.status).toBe("completed");
  });

  it("refreshes head metrics from its transcript", async () => {
    const orchId = await makeOrchWithHead();
    await store.updateHead(orchId, (h) => (h.briefedAt = 1));
    const { controller } = makeHeadAwareController({
      ready: true,
      headTranscript: [
        {
          kind: "assistant",
          uuid: "a",
          ts: "t",
          blocks: [{ type: "text", text: "coordinating" }],
          usage: {
            inputTokens: 800,
            outputTokens: 60,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            webSearchRequests: 0,
            webFetchRequests: 0,
          },
        },
      ],
    });
    await controller.onHeadSignal(orchId, { stopped: false });
    const o = await store.getOrchestration(orchId);
    expect(o!.head!.metrics.inputTokens).toBe(800);
    expect(o!.head!.metrics.turns).toBe(1);
  });
});

// ---- runaway circuit-breaker ------------------------------------------------

// Build an assistant turn that issues a single Bash command (the runaway
// vector). Counter-suffixed commands normalise to one signature.
const bashTurn = (command: string): TranscriptEvent => ({
  kind: "assistant",
  uuid: "u",
  ts: "t",
  blocks: [{ type: "tool_use", id: "x", name: "Bash", input: { command } }],
});

describe("toolUseSignature", () => {
  it("normalises a Bash command, collapsing digit runs (counter-suffixed spam)", () => {
    expect(toolUseSignature({ type: "tool_use", id: "1", name: "Bash", input: { command: "recover-check-1" } })).toBe(
      toolUseSignature({ type: "tool_use", id: "2", name: "Bash", input: { command: "recover-check-2" } }),
    );
    expect(
      toolUseSignature({ type: "tool_use", id: "1", name: "Bash", input: { command: "  ls   -la " } }),
    ).toBe("bash:ls -la");
  });

  it("returns null for non-tool blocks", () => {
    expect(toolUseSignature({ type: "text", text: "hi" })).toBeNull();
    expect(toolUseSignature({ type: "thinking", text: "hmm" })).toBeNull();
  });

  it("distinguishes different tools so genuine varied work breaks the run", () => {
    const edit = toolUseSignature({ type: "tool_use", id: "1", name: "Edit", input: { file_path: "a.ts" } });
    const bash = toolUseSignature({ type: "tool_use", id: "2", name: "Bash", input: { command: "npm test" } });
    expect(edit).not.toBe(bash);
  });
});

describe("toolUseSignatures + trailingRepeat", () => {
  it("collects tool-call signatures oldest→newest, ignoring text", () => {
    const sigs = toolUseSignatures([
      { kind: "user", uuid: "u", ts: "t", text: "go" },
      bashTurn("a"),
      { kind: "assistant", uuid: "u2", ts: "t", blocks: [{ type: "text", text: "thinking" }] },
      bashTurn("b"),
    ]);
    expect(sigs).toEqual(["bash:a", "bash:b"]);
  });

  it("counts the trailing run of the last signature", () => {
    expect(trailingRepeat(["a", "a", "b", "b", "b"])).toEqual({ signature: "b", count: 3 });
    expect(trailingRepeat(["a"])).toEqual({ signature: "a", count: 1 });
    expect(trailingRepeat([])).toEqual({ signature: null, count: 0 });
  });
});

describe("decideCircuitBreaker", () => {
  // Non-tripping defaults for the two NEW triggers, so a test that exercises
  // the signature trigger isn't perturbed by them: huge ceilings, huge
  // no-progress allowance, and zero activity counters.
  const base = {
    signature: "bash:probe",
    progressKey: "0:",
    diffKey: "",
    turns: 0,
    toolCalls: 0,
    tokens: 0,
    limit: 5,
    noProgressTurns: 10_000,
    noProgressToolCalls: 10_000,
    hardTurnCeiling: 1_000_000,
    hardTokenCeiling: 1_000_000_000,
  };

  it("trips once the no-progress run reaches the limit", () => {
    const d = decideCircuitBreaker({
      ...base,
      repeatCount: 5,
      prior: { signature: "bash:probe", progressKey: "0:", baseline: 0 },
    });
    expect(d.tripped).toBe(true);
    expect(d.reason).toContain("circuit-breaker");
    expect(d.reason).toContain("5 consecutive");
  });

  it("does NOT trip when the branch advanced (progressKey changed), even mid-run", () => {
    const d = decideCircuitBreaker({
      ...base,
      signature: "bash:probe",
      progressKey: "1:2 files +9/-0", // diff advanced since the window opened
      repeatCount: 9,
      prior: { signature: "bash:probe", progressKey: "0:", baseline: 0 },
    });
    expect(d.tripped).toBe(false);
    // window reopened against the new progress baseline
    expect(d.snapshot.baseline).toBe(9);
    expect(d.snapshot.progressKey).toBe("1:2 files +9/-0");
  });

  it("never trips on the first observation of a window (no prior)", () => {
    const d = decideCircuitBreaker({ ...base, repeatCount: 100 });
    expect(d.tripped).toBe(false);
    expect(d.snapshot.baseline).toBe(100);
  });

  it("resets the window when the repeated command changes", () => {
    const d = decideCircuitBreaker({
      ...base,
      signature: "bash:other",
      progressKey: "0:",
      repeatCount: 3,
      prior: { signature: "bash:probe", progressKey: "0:", baseline: 0 },
    });
    expect(d.tripped).toBe(false);
    expect(d.snapshot.baseline).toBe(3);
  });

  it("no-ops with no tool calls to judge", () => {
    expect(decideCircuitBreaker({ ...base, signature: null, repeatCount: 0 }).tripped).toBe(false);
  });

  // --- Trigger 2: signature-independent no-progress (the 7.6M scenario) ---

  it("TRIPS a varied-probe spiral: no diff progress past the turn limit, even though the command differs every turn", () => {
    // signature changes every turn (repeatCount 1) → the signature trigger can
    // NEVER fire. diffKey is frozen since the window opened, and turns have
    // grown past the no-progress limit.
    const d = decideCircuitBreaker({
      ...base,
      signature: "bash:grep-something-different",
      repeatCount: 1, // never an identical run
      diffKey: "", // no committed diff, unchanged since the window opened
      turns: 50,
      noProgressTurns: 40,
      prior: {
        signature: "bash:earlier-probe",
        progressKey: "0:",
        baseline: 1,
        diffKey: "",
        progressTurns: 5, // window opened at turn 5; 50-5 = 45 ≥ 40
        progressToolCalls: 5,
      },
    });
    expect(d.tripped).toBe(true);
    expect(d.reason).toContain("no committed-diff progress");
  });

  it("TRIPS a no-progress spiral on the tool-call count too", () => {
    const d = decideCircuitBreaker({
      ...base,
      signature: "bash:vary",
      repeatCount: 1,
      diffKey: "1 file +2/-0",
      turns: 5, // well under the turn limit
      toolCalls: 120,
      noProgressToolCalls: 80,
      prior: {
        signature: "bash:vary",
        progressKey: "0:1 file +2/-0",
        baseline: 1,
        diffKey: "1 file +2/-0",
        progressTurns: 0,
        progressToolCalls: 20, // 120-20 = 100 ≥ 80
      },
    });
    expect(d.tripped).toBe(true);
    expect(d.reason).toContain("tool calls");
  });

  it("does NOT trip a worker making real progress: diff advances so the no-progress window keeps resetting", () => {
    // The diff moved since the prior observation → window reopens at the
    // current turn count, streak resets to 0, nothing trips even though many
    // turns/tool-calls have elapsed in total.
    const d = decideCircuitBreaker({
      ...base,
      signature: "bash:vary",
      repeatCount: 1,
      diffKey: "3 files +40/-2", // advanced from the prior diff
      turns: 200,
      toolCalls: 400,
      noProgressTurns: 40,
      noProgressToolCalls: 80,
      prior: {
        signature: "bash:vary",
        progressKey: "5:2 files +30/-1",
        baseline: 1,
        diffKey: "2 files +30/-1", // older diff
        progressTurns: 150,
        progressToolCalls: 300,
      },
    });
    expect(d.tripped).toBe(false);
    // window reopened against the fresh diff baseline
    expect(d.snapshot.diffKey).toBe("3 files +40/-2");
    expect(d.snapshot.progressTurns).toBe(200);
    expect(d.snapshot.progressToolCalls).toBe(400);
  });

  it("does NOT trip a no-op COMMIT that bumps commitCount but not the diff (anti-laundering)", () => {
    // progressKey changed (commitCount 5→6) but diffKey is identical — an empty
    // / no-op commit. The no-progress window must NOT reset on that, or a worker
    // could launder a spiral by committing nothing every N turns.
    const d = decideCircuitBreaker({
      ...base,
      signature: "bash:vary",
      repeatCount: 1,
      progressKey: "6:1 file +2/-0", // commitCount advanced…
      diffKey: "1 file +2/-0", // …but the diff did NOT
      turns: 60,
      noProgressTurns: 40,
      prior: {
        signature: "bash:vary",
        progressKey: "5:1 file +2/-0", // prior commitCount 5
        baseline: 1,
        diffKey: "1 file +2/-0",
        progressTurns: 5, // 60-5 = 55 ≥ 40 → trips despite the no-op commit
        progressToolCalls: 5,
      },
    });
    expect(d.tripped).toBe(true);
    expect(d.reason).toContain("no committed-diff progress");
  });

  // --- Trigger 3: hard ceiling (absolute, progress-immune) ---

  it("TRIPS on the hard turn ceiling even while the worker IS making progress", () => {
    // Every progress-based window is reset this tick (diff just advanced), and
    // the signature is non-repeating — yet the absolute turn ceiling still
    // trips. This is the laundering backstop.
    const d = decideCircuitBreaker({
      ...base,
      signature: "bash:vary",
      repeatCount: 1,
      diffKey: "9 files +900/-3", // fresh progress this tick
      turns: 120,
      hardTurnCeiling: 120,
      prior: {
        signature: "bash:vary",
        progressKey: "1:1 file",
        baseline: 1,
        diffKey: "1 file", // different → progress window resets
        progressTurns: 119,
        progressToolCalls: 1,
      },
    });
    expect(d.tripped).toBe(true);
    expect(d.reason).toContain("hard ceiling");
    expect(d.reason).toContain("turns");
  });

  it("TRIPS on the hard token ceiling regardless of turns/progress", () => {
    const d = decideCircuitBreaker({
      ...base,
      turns: 3, // tiny turn count
      tokens: 5_000_000,
      hardTokenCeiling: 4_000_000,
      diffKey: "1 file +1/-0",
      prior: {
        signature: "bash:probe",
        progressKey: "0:",
        baseline: 0,
        diffKey: "1 file +1/-0",
        progressTurns: 0,
        progressToolCalls: 0,
      },
    });
    expect(d.tripped).toBe(true);
    expect(d.reason).toContain("hard ceiling");
    expect(d.reason).toContain("tokens");
  });
});

function makeBreakerController(opts: {
  transcript: () => TranscriptEvent[];
  git: () => { diffstat: string; commitCount: number };
  limit?: number;
  noProgressTurns?: number;
  noProgressToolCalls?: number;
  hardTurnCeiling?: number;
  hardTokenCeiling?: number;
  // The stuck-judge stub: given the prompt, return raw stdout. Omit to leave the
  // judge unwired (no-progress keeps its immediate-block behavior). Throw to
  // simulate a subprocess error/timeout.
  judge?: (prompt: string) => Promise<string> | string;
}) {
  const escalations: { agentId: string; reason: string }[] = [];
  const judgePrompts: string[] = [];
  const controller = new AutonomyController({
    store,
    orchestrator,
    readTranscript: async () => opts.transcript(),
    sendText: async () => {},
    sessionReady: async () => true,
    agentGitSummary: async () => opts.git(),
    escalateToHuman: async (_o, a, reason) => {
      escalations.push({ agentId: a.id, reason });
    },
    runStuckJudge: opts.judge
      ? async (prompt) => {
          judgePrompts.push(prompt);
          return await opts.judge!(prompt);
        }
      : undefined,
    runawayLimit: opts.limit,
    noProgressTurns: opts.noProgressTurns,
    noProgressToolCalls: opts.noProgressToolCalls,
    hardTurnCeiling: opts.hardTurnCeiling,
    hardTokenCeiling: opts.hardTokenCeiling,
    now: () => 1_000_000,
  });
  return { controller, escalations, judgePrompts };
}

describe("AutonomyController.checkCircuitBreaker", () => {
  it("trips a worker spiralling on identical no-op commands → blocked with a reason", async () => {
    const { orchId, agentId } = await makeAgent("sess-run", "running");
    const probes: TranscriptEvent[] = [];
    const { controller } = makeBreakerController({
      transcript: () => probes,
      git: () => ({ diffstat: "", commitCount: 0 }), // never advances
      limit: 3,
    });

    // First sighting opens the window (baseline), can't trip yet.
    probes.push(bashTurn("recover-check-1"), bashTurn("recover-check-2"));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false);

    // Worker keeps spamming the same (counter-suffixed) probe — no commits/diff.
    for (let n = 3; n <= 8; n++) probes.push(bashTurn(`recover-check-${n}`));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(true);

    const o = await store.getOrchestration(orchId);
    const a = o!.agents.find((x) => x.id === agentId)!;
    expect(a.lifecycle).toBe("blocked");
    expect(a.blockedReason).toContain("circuit-breaker");
  });

  it("does NOT trip a worker that repeats a command while its branch advances", async () => {
    const { orchId, agentId } = await makeAgent("sess-run", "running");
    const probes: TranscriptEvent[] = [];
    let commits = 0;
    const { controller } = makeBreakerController({
      transcript: () => probes,
      git: () => ({ diffstat: `${commits} files`, commitCount: commits }),
      limit: 3,
    });

    // Same command every time, but a commit lands between each observation.
    for (let tick = 0; tick < 6; tick++) {
      probes.push(bashTurn("npm test"));
      commits++; // progress advances → window resets every tick
      expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false);
    }
    const o = await store.getOrchestration(orchId);
    expect(o!.agents.find((x) => x.id === agentId)!.lifecycle).toBe("running");
  });

  it("TRIPS a VARIED-probe spiral: distinct commands every turn, no diff progress (the 7.6M scenario)", async () => {
    const { orchId, agentId } = await makeAgent("sess-run", "running");
    const probes: TranscriptEvent[] = [];
    const { controller } = makeBreakerController({
      transcript: () => probes,
      git: () => ({ diffstat: "", commitCount: 0 }), // never advances
      limit: 1000, // signature trigger effectively disabled
      noProgressTurns: 5,
    });

    // Open the no-progress window at 2 turns (first observation never trips).
    probes.push(bashTurn("grep alpha src"), bashTurn("echo checking"));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false);

    // Each subsequent turn is a DIFFERENT probe — the identical-run heuristic
    // can never fire — yet nothing lands on the branch.
    for (const w of ["beta", "gamma", "delta", "epsilon", "zeta", "eta"]) {
      probes.push(bashTurn(`grep ${w} src`));
    }
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(true);

    const a = (await store.getOrchestration(orchId))!.agents.find(
      (x) => x.id === agentId,
    )!;
    expect(a.lifecycle).toBe("blocked");
    expect(a.blockedReason).toContain("no committed-diff progress");
  });

  it("does NOT trip varied commands while the committed diff keeps advancing (no false positive)", async () => {
    const { orchId, agentId } = await makeAgent("sess-run", "running");
    const probes: TranscriptEvent[] = [];
    let commits = 0;
    const { controller } = makeBreakerController({
      transcript: () => probes,
      // Real progress: diff grows every tick.
      git: () => ({ diffstat: `${commits} files +${commits * 10}/-0`, commitCount: commits }),
      limit: 1000,
      noProgressTurns: 5,
      noProgressToolCalls: 5,
    });

    const cmds = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff", "ggggggg", "hh"];
    for (const c of cmds) {
      probes.push(bashTurn(`grep ${c} src`)); // distinct each time
      commits++; // committed diff advances → both windows reset every tick
      expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false);
    }
    expect(
      (await store.getOrchestration(orchId))!.agents.find((x) => x.id === agentId)!
        .lifecycle,
    ).toBe("running");
  });

  it("hard ceiling trips a worker sitting just under every other threshold", async () => {
    const { orchId, agentId } = await makeAgent("sess-run", "running");
    const probes: TranscriptEvent[] = [];
    let commits = 0;
    const { controller } = makeBreakerController({
      transcript: () => probes,
      // Diff advances every tick → signature + no-progress windows perpetually
      // reset, so neither of those triggers can ever fire.
      git: () => ({ diffstat: `${commits} files +${commits}/-0`, commitCount: commits }),
      limit: 1000, // signature trigger off
      noProgressTurns: 1000, // no-progress (turns) off
      noProgressToolCalls: 100000, // no-progress (tool calls) off
      hardTurnCeiling: 6, // the ONLY live bound
    });

    // The worker commits real diff on every turn — it fools BOTH progress-based
    // triggers — but the absolute turn ceiling is immune to progress and trips.
    let tripped = false;
    for (let t = 1; t <= 6; t++) {
      probes.push(bashTurn(`work-step-${String.fromCharCode(96 + t)}`));
      commits++;
      tripped = await controller.checkCircuitBreaker(orchId, agentId);
    }
    expect(tripped).toBe(true);
    const a = (await store.getOrchestration(orchId))!.agents.find(
      (x) => x.id === agentId,
    )!;
    expect(a.lifecycle).toBe("blocked");
    expect(a.blockedReason).toContain("hard ceiling");
  });

  it("ignores a worker that isn't running (terminal / no session)", async () => {
    const { orchId, agentId } = await makeAgent(null, "running"); // no session id
    const { controller } = makeBreakerController({
      transcript: () => [bashTurn("x"), bashTurn("x"), bashTurn("x")],
      git: () => ({ diffstat: "", commitCount: 0 }),
      limit: 1,
    });
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false);
  });

  it("uses DEFAULT_RUNAWAY_LIMIT when no override is given", () => {
    expect(DEFAULT_RUNAWAY_LIMIT).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_RUNAWAY_LIMIT).toBeLessThanOrEqual(5);
  });

  it("ships sane defaults for the new triggers (catch the spiral, leave headroom)", () => {
    // No-progress bounds well below the observed 147-turn spiral. The bounds
    // were deliberately relaxed (turns→100) to give the stuck-judge ample
    // runway; the turns and tool-calls bounds are now tuned independently (no
    // calls≥turns coupling), so each is just checked for a sane standalone range.
    expect(DEFAULT_NO_PROGRESS_TURNS).toBeLessThan(147);
    expect(DEFAULT_NO_PROGRESS_TURNS).toBeGreaterThanOrEqual(20);
    expect(DEFAULT_NO_PROGRESS_TOOL_CALLS).toBeLessThan(147);
    expect(DEFAULT_NO_PROGRESS_TOOL_CALLS).toBeGreaterThanOrEqual(20);
    // Hard ceiling above the no-progress bound (so the no-progress trigger
    // normally fires first) but below the observed 7.6M-token miss.
    expect(DEFAULT_HARD_TURN_CEILING).toBeGreaterThan(DEFAULT_NO_PROGRESS_TURNS);
    expect(DEFAULT_HARD_TOKEN_CEILING).toBeLessThan(7_600_000);
    expect(DEFAULT_HARD_TOKEN_CEILING).toBeGreaterThan(1_000_000);
  });

  it("persists the breaker reason as the summary + sets headWokeAt (no double-wake)", async () => {
    const { orchId, agentId } = await makeAgent("sess-run", "running");
    const probes: TranscriptEvent[] = [];
    const { controller } = makeBreakerController({
      transcript: () => probes,
      git: () => ({ diffstat: "", commitCount: 0 }),
      limit: 3,
    });
    // Open the window (baseline), then spam past the limit to trip it.
    probes.push(bashTurn("recover-check-1"), bashTurn("recover-check-2"));
    await controller.checkCircuitBreaker(orchId, agentId);
    for (let n = 3; n <= 8; n++) probes.push(bashTurn(`recover-check-${n}`));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(true);

    const a = (await store.getOrchestration(orchId))!.agents.find(
      (x) => x.id === agentId,
    )!;
    // The breaker has no marker prose, so its reason IS the persisted summary.
    expect(a.summary).toContain("circuit-breaker");
    expect(a.summary).toBe(a.blockedReason);
    // The breaker escalation IS the wake — the guard is set so the reconcile
    // loop's generic wake-up won't escalate the same trip a second time.
    expect(a.headWokeAt).toBe(1_000_000);
  });
});

// ---- Stuck-judge (Trigger-2 gating) ----------------------------------------

const readTurn = (file: string): TranscriptEvent => ({
  kind: "assistant",
  uuid: "u",
  ts: "t",
  blocks: [
    { type: "tool_use", id: "x", name: "Read", input: { file_path: file } },
  ],
});

describe("summarizeToolCall", () => {
  it("renders Bash as its command, file/search tools as their target", () => {
    expect(
      summarizeToolCall({ type: "tool_use", id: "1", name: "Bash", input: { command: "npm test" } }),
    ).toBe("Bash(npm test)");
    expect(
      summarizeToolCall({ type: "tool_use", id: "1", name: "Read", input: { file_path: "src/a.ts" } }),
    ).toBe("Read(src/a.ts)");
    expect(
      summarizeToolCall({ type: "tool_use", id: "1", name: "Grep", input: { pattern: "foo" } }),
    ).toBe("Grep(foo)");
  });

  it("falls back to the tool name when there's no recognised target; empty for non-tool", () => {
    expect(
      summarizeToolCall({ type: "tool_use", id: "1", name: "Weird", input: {} }),
    ).toBe("Weird");
    expect(summarizeToolCall({ type: "text", text: "hi" })).toBe("");
  });
});

describe("buildJudgeActivityView", () => {
  it("renders one line per recent turn: tool calls + a text snippet", () => {
    const events: TranscriptEvent[] = [
      readTurn("src/a.ts"),
      {
        kind: "assistant",
        uuid: "u",
        ts: "t",
        blocks: [
          { type: "text", text: "Now editing the controller." },
          { type: "tool_use", id: "y", name: "Edit", input: { file_path: "src/b.ts" } },
        ],
      },
    ];
    const view = buildJudgeActivityView(events);
    expect(view).toContain("Read(src/a.ts)");
    expect(view).toContain("Edit(src/b.ts)");
    expect(view).toContain("Now editing the controller.");
  });

  it("keeps only the last maxTurns turns (bounded — never the whole transcript)", () => {
    const events: TranscriptEvent[] = Array.from({ length: 30 }, (_, i) =>
      readTurn(`src/f${i}.ts`),
    );
    const view = buildJudgeActivityView(events, { maxTurns: 5 });
    expect(view).toContain("src/f29.ts");
    expect(view).not.toContain("src/f10.ts");
    expect(view.split("\n")).toHaveLength(5);
  });
});

describe("parseJudgeVerdict", () => {
  it("parses a bare JSON line", () => {
    expect(
      parseJudgeVerdict('{"verdict":"progressing","reason":"reading new files"}'),
    ).toEqual({ verdict: "progressing", reason: "reading new files" });
  });

  it("parses JSON wrapped in prose / a code fence", () => {
    const out =
      'Here is my answer:\n```json\n{"verdict": "stuck", "reason": "re-running greps"}\n```\n';
    expect(parseJudgeVerdict(out)).toEqual({
      verdict: "stuck",
      reason: "re-running greps",
    });
  });

  it("returns null on no JSON, an unknown verdict, or empty stdout", () => {
    expect(parseJudgeVerdict("no json here")).toBeNull();
    expect(parseJudgeVerdict('{"verdict":"confused"}')).toBeNull();
    expect(parseJudgeVerdict("")).toBeNull();
  });
});

describe("decideCircuitBreaker: trigger tag + flagged window", () => {
  const base = {
    signature: null,
    repeatCount: 0,
    progressKey: "1:x",
    diffKey: "x",
    turns: 50,
    toolCalls: 50,
    tokens: 0,
    limit: 1000,
    noProgressTurns: 1000,
    noProgressToolCalls: 1000,
    hardTurnCeiling: 10_000,
    hardTokenCeiling: 9_000_000_000,
  };
  const flaggedPrior = {
    signature: "",
    progressKey: "1:x",
    baseline: 0,
    diffKey: "x",
    progressTurns: 0,
    progressToolCalls: 0,
    flaggedAt: 123,
    flaggedReason: "spin",
  };

  it("carries flaggedAt/Reason forward while the committed diff is unchanged", () => {
    const d = decideCircuitBreaker({ ...base, prior: flaggedPrior });
    expect(d.snapshot.flaggedAt).toBe(123);
    expect(d.snapshot.flaggedReason).toBe("spin");
  });

  it("drops the flag the moment the committed diff moves (window reset = recovery)", () => {
    const d = decideCircuitBreaker({ ...base, diffKey: "y", prior: flaggedPrior });
    expect(d.snapshot.flaggedAt).toBeUndefined();
    expect(d.snapshot.flaggedReason).toBeUndefined();
  });

  it("tags the hard-ceiling trigger", () => {
    const d = decideCircuitBreaker({ ...base, turns: 99_999, prior: undefined });
    expect(d.tripped).toBe(true);
    expect(d.trigger).toBe("hard_ceiling");
  });
});

describe("AutonomyController.checkCircuitBreaker stuck-judge", () => {
  // The motivating regression: a worker reading distinct files for many turns
  // with no commit must be judged progressing and NOT killed.
  it("no-progress + judge says progressing → NOT killed, window re-armed", async () => {
    const { orchId, agentId } = await makeAgent("sess-run", "running");
    const probes: TranscriptEvent[] = [];
    const { controller, judgePrompts } = makeBreakerController({
      transcript: () => probes,
      git: () => ({ diffstat: "", commitCount: 0 }), // never commits
      limit: 1000, // signature trigger off
      noProgressTurns: 5,
      judge: () =>
        '{"verdict":"progressing","reason":"reading 7 distinct files toward the task"}',
    });

    probes.push(readTurn("a.ts"), readTurn("b.ts"));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false); // opens window
    for (const f of ["c", "d", "e", "f", "g", "h"]) probes.push(readTurn(`${f}.ts`));
    // Trigger-2 fires, but the judge says progressing → not killed.
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false);
    expect(judgePrompts).toHaveLength(1);
    expect(judgePrompts[0]).toContain("Read(a.ts)");

    const a = (await store.getOrchestration(orchId))!.agents.find((x) => x.id === agentId)!;
    expect(a.lifecycle).toBe("running");
    expect(a.breaker?.flaggedReason).toBeUndefined();
    // Window re-armed to the current turn count (8 turns observed).
    expect(a.breaker?.progressTurns).toBe(8);
  });

  it("no-progress + judge says stuck → flagged (still running), PM woken once", async () => {
    const { orchId, agentId } = await makeAgent("sess-run", "running");
    await store.setHead(orchId, {
      sessionId: "sess-head",
      pid: 9,
      worktreeDir: "/wt/head",
      branch: "head",
    });
    const probes: TranscriptEvent[] = [];
    const { controller, escalations, judgePrompts } = makeBreakerController({
      transcript: () => probes,
      git: () => ({ diffstat: "", commitCount: 0 }),
      limit: 1000,
      noProgressTurns: 5,
      judge: () => '{"verdict":"stuck","reason":"re-running varied greps, no new info"}',
    });

    probes.push(bashTurn("grep a src"), bashTurn("grep b src"));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false); // opens window
    for (const w of ["c", "d", "e", "f", "g", "h"]) probes.push(bashTurn(`grep ${w} src`));
    // Trigger-2 fires; judge says stuck → flag, NOT kill.
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false);

    let a = (await store.getOrchestration(orchId))!.agents.find((x) => x.id === agentId)!;
    expect(a.lifecycle).toBe("running"); // NOT blocked — kept alive for the PM
    expect(a.breaker?.flaggedReason).toContain("re-running varied greps");
    expect(a.breaker?.flaggedAt).toBe(1_000_000);
    expect(escalations).toHaveLength(1); // PM woken (see statusView.test for the surfaced flag)

    // A subsequent tick (still no diff) must NOT re-judge or kill — once per window.
    probes.push(bashTurn("grep i src"));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false);
    expect(judgePrompts).toHaveLength(1); // not re-judged
    a = (await store.getOrchestration(orchId))!.agents.find((x) => x.id === agentId)!;
    expect(a.lifecycle).toBe("running");
  });

  it("no-progress + judge error/timeout → blocks (fail safe)", async () => {
    const { orchId, agentId } = await makeAgent("sess-run", "running");
    const probes: TranscriptEvent[] = [];
    const { controller } = makeBreakerController({
      transcript: () => probes,
      git: () => ({ diffstat: "", commitCount: 0 }),
      limit: 1000,
      noProgressTurns: 5,
      judge: () => {
        throw new Error("judge timed out");
      },
    });

    probes.push(bashTurn("grep a src"), bashTurn("grep b src"));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false);
    for (const w of ["c", "d", "e", "f", "g", "h"]) probes.push(bashTurn(`grep ${w} src`));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(true); // blocked

    const a = (await store.getOrchestration(orchId))!.agents.find((x) => x.id === agentId)!;
    expect(a.lifecycle).toBe("blocked");
    expect(a.blockedReason).toContain("no committed-diff progress");
  });

  it("no-progress + unparseable judge answer → blocks (fail safe)", async () => {
    const { orchId, agentId } = await makeAgent("sess-run", "running");
    const probes: TranscriptEvent[] = [];
    const { controller } = makeBreakerController({
      transcript: () => probes,
      git: () => ({ diffstat: "", commitCount: 0 }),
      limit: 1000,
      noProgressTurns: 5,
      judge: () => "I cannot decide.",
    });

    probes.push(bashTurn("grep a src"), bashTurn("grep b src"));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false);
    for (const w of ["c", "d", "e", "f", "g", "h"]) probes.push(bashTurn(`grep ${w} src`));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(true);
    expect(
      (await store.getOrchestration(orchId))!.agents.find((x) => x.id === agentId)!.lifecycle,
    ).toBe("blocked");
  });

  it("the SIGNATURE trigger is NEVER gated on the judge (immediate kill)", async () => {
    const { orchId, agentId } = await makeAgent("sess-run", "running");
    const probes: TranscriptEvent[] = [];
    const { controller, judgePrompts } = makeBreakerController({
      transcript: () => probes,
      git: () => ({ diffstat: "", commitCount: 0 }),
      limit: 3, // signature trigger live
      noProgressTurns: 1000, // no-progress off
      // Judge wired, but a signature trip must not consult it.
      judge: () => '{"verdict":"progressing","reason":"should be ignored"}',
    });

    probes.push(bashTurn("recover-check-1"), bashTurn("recover-check-2"));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(false);
    for (let n = 3; n <= 8; n++) probes.push(bashTurn(`recover-check-${n}`));
    expect(await controller.checkCircuitBreaker(orchId, agentId)).toBe(true);
    expect(judgePrompts).toHaveLength(0); // judge never consulted
    expect(
      (await store.getOrchestration(orchId))!.agents.find((x) => x.id === agentId)!.lifecycle,
    ).toBe("blocked");
  });

  it("the HARD CEILING is NEVER gated on the judge (immediate kill)", async () => {
    const { orchId, agentId } = await makeAgent("sess-run", "running");
    const probes: TranscriptEvent[] = [];
    let commits = 0;
    const { controller, judgePrompts } = makeBreakerController({
      transcript: () => probes,
      git: () => ({ diffstat: `${commits} files`, commitCount: commits }),
      limit: 1000,
      noProgressTurns: 1000,
      noProgressToolCalls: 100000,
      hardTurnCeiling: 4,
      judge: () => '{"verdict":"progressing","reason":"should be ignored"}',
    });

    let tripped = false;
    for (let t = 1; t <= 4; t++) {
      probes.push(bashTurn(`step-${String.fromCharCode(96 + t)}`));
      commits++;
      tripped = await controller.checkCircuitBreaker(orchId, agentId);
    }
    expect(tripped).toBe(true);
    expect(judgePrompts).toHaveLength(0);
    expect(
      (await store.getOrchestration(orchId))!.agents.find((x) => x.id === agentId)!.lifecycle,
    ).toBe("blocked");
  });
});

// ---- Stuck-judge: adversarial / gap coverage (Tester) ----------------------
//
// The coder's suite covers progressing/stuck/throw/unparseable + signature &
// hard-ceiling bypass. These target the branches that suite leaves thin:
//   - recovery THROUGH the controller (flag clears when the diff moves), not
//     just at the pure decideCircuitBreaker level;
//   - a flag is NOT immortality — the hard ceiling still kills a flagged worker;
//   - the `drifting` verdict (impl treats it like `stuck`, but it was untested);
//   - empty stdout + valid-JSON-unknown-verdict + async-reject fail-safes;
//   - the `progressing` audit note + that it never escalates.
// Each asserts a state transition that flips if the corresponding branch
// regresses (not a tautology).

// Open a no-progress window then drive it past the turn limit. Returns the
// agent ids and a `bump`/`tick` pair so each test composes its own trajectory.
async function makeStuckScenario(opts: {
  judge?: (prompt: string) => Promise<string> | string;
  noProgressTurns?: number;
  hardTurnCeiling?: number;
  withHead?: boolean;
}) {
  const { orchId, agentId } = await makeAgent("sess-run", "running");
  if (opts.withHead ?? true) {
    await store.setHead(orchId, {
      sessionId: "sess-head",
      pid: 9,
      worktreeDir: "/wt/head",
      branch: "head",
    });
  }
  const probes: TranscriptEvent[] = [];
  // Mutable git state so a test can "land a commit" mid-trajectory.
  const gitState = { diffstat: "", commitCount: 0 };
  const ctl = makeBreakerController({
    transcript: () => probes,
    git: () => ({ ...gitState }),
    limit: 1000, // signature trigger off — isolate Trigger 2
    noProgressTurns: opts.noProgressTurns ?? 5,
    hardTurnCeiling: opts.hardTurnCeiling,
    judge: opts.judge,
  });
  const agentNow = async () =>
    (await store.getOrchestration(orchId))!.agents.find((x) => x.id === agentId)!;
  return { ...ctl, orchId, agentId, probes, gitState, agentNow };
}

describe("AutonomyController.checkCircuitBreaker stuck-judge — adversarial", () => {
  it("RECOVERY (integration): a flagged worker whose committed diff then moves clears flaggedAt/Reason on the next tick", async () => {
    const s = await makeStuckScenario({
      judge: () => '{"verdict":"stuck","reason":"spinning on greps"}',
    });
    // Open the window, then spiral past the limit → flagged (not killed).
    s.probes.push(bashTurn("grep a src"), bashTurn("grep b src"));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false);
    for (const w of ["c", "d", "e", "f", "g", "h"]) s.probes.push(bashTurn(`grep ${w} src`));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false);
    let a = await s.agentNow();
    expect(a.lifecycle).toBe("running");
    expect(a.breaker?.flaggedAt).toBe(1_000_000);
    expect(a.breaker?.flaggedReason).toContain("spinning on greps");
    expect(s.escalations).toHaveLength(1);

    // The worker recovers: it lands a real committed diff. Next tick the
    // no-progress window resets, which must CLEAR the flag.
    s.gitState.diffstat = "2 files +40/-1";
    s.gitState.commitCount = 1;
    s.probes.push(bashTurn("grep i src"));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false);
    a = await s.agentNow();
    expect(a.lifecycle).toBe("running");
    expect(a.breaker?.flaggedAt).toBeUndefined();
    expect(a.breaker?.flaggedReason).toBeUndefined();
    // The recovery tick neither re-judged nor re-escalated.
    expect(s.judgePrompts).toHaveLength(1);
    expect(s.escalations).toHaveLength(1);
  });

  it("RECOVERY is not permanent suppression: after the flag clears, a fresh no-progress spiral is judged AGAIN", async () => {
    const s = await makeStuckScenario({
      judge: () => '{"verdict":"stuck","reason":"spinning"}',
    });
    s.probes.push(bashTurn("grep a src"), bashTurn("grep b src"));
    await s.controller.checkCircuitBreaker(s.orchId, s.agentId); // open
    for (const w of ["c", "d", "e", "f", "g", "h"]) s.probes.push(bashTurn(`grep ${w} src`));
    await s.controller.checkCircuitBreaker(s.orchId, s.agentId); // flag (judge #1)
    expect(s.judgePrompts).toHaveLength(1);

    // Recover (diff moves) → flag clears, new window opens at the current count.
    s.gitState.diffstat = "1 file +5/-0";
    s.gitState.commitCount = 1;
    s.probes.push(bashTurn("grep recover src"));
    await s.controller.checkCircuitBreaker(s.orchId, s.agentId);
    expect((await s.agentNow()).breaker?.flaggedAt).toBeUndefined();

    // Now freeze the diff again and spiral past the limit a SECOND time.
    for (const w of ["j", "k", "l", "m", "n", "o"]) s.probes.push(bashTurn(`grep ${w} src`));
    await s.controller.checkCircuitBreaker(s.orchId, s.agentId);
    // The judge is consulted again for the new window — recovery did not silence it.
    expect(s.judgePrompts).toHaveLength(2);
    expect((await s.agentNow()).breaker?.flaggedAt).toBe(1_000_000);
  });

  it("a FLAG is not immortality: a flagged worker that keeps burning is still killed by the hard ceiling (the leak bound)", async () => {
    // noProgress=5 so it flags early; hard ceiling 12 turns is the backstop.
    const s = await makeStuckScenario({
      judge: () => '{"verdict":"stuck","reason":"spinning forever"}',
      noProgressTurns: 5,
      hardTurnCeiling: 12,
    });
    s.probes.push(bashTurn("grep a src"), bashTurn("grep b src")); // 2 turns
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false);
    for (const w of ["c", "d", "e", "f", "g", "h"]) s.probes.push(bashTurn(`grep ${w} src`)); // 8 turns
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false); // flagged
    expect((await s.agentNow()).lifecycle).toBe("running");
    expect(s.judgePrompts).toHaveLength(1);

    // The flagged worker keeps spinning (still no diff) up to the hard ceiling.
    for (const w of ["i", "j", "k", "l"]) s.probes.push(bashTurn(`grep ${w} src`)); // 12 turns ≥ ceiling
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(true); // KILLED
    const a = await s.agentNow();
    expect(a.lifecycle).toBe("blocked");
    expect(a.blockedReason).toContain("hard ceiling");
    // The hard-ceiling kill is immune to the judge — it was never re-consulted.
    expect(s.judgePrompts).toHaveLength(1);
  });

  it("DRIFTING verdict → flagged (still running), PM woken once, reason surfaced — same as stuck", async () => {
    const s = await makeStuckScenario({
      judge: () => '{"verdict":"drifting","reason":"wandered onto unrelated refactors"}',
    });
    s.probes.push(bashTurn("grep a src"), bashTurn("grep b src"));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false);
    for (const w of ["c", "d", "e", "f", "g", "h"]) s.probes.push(bashTurn(`grep ${w} src`));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false);

    const a = await s.agentNow();
    expect(a.lifecycle).toBe("running"); // NOT killed
    expect(a.breaker?.flaggedReason).toContain("wandered onto unrelated refactors");
    expect(a.breaker?.flaggedAt).toBe(1_000_000);
    expect(s.escalations).toHaveLength(1);
    expect(s.escalations[0].reason).toContain("drifting");

    // Once-per-window: a subsequent no-diff tick neither re-judges nor re-escalates.
    s.probes.push(bashTurn("grep i src"));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false);
    expect(s.judgePrompts).toHaveLength(1);
    expect(s.escalations).toHaveLength(1);
  });

  it("FAIL-SAFE: empty stdout → blocked (never silently let-run)", async () => {
    const s = await makeStuckScenario({ judge: () => "" });
    s.probes.push(bashTurn("grep a src"), bashTurn("grep b src"));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false);
    for (const w of ["c", "d", "e", "f", "g", "h"]) s.probes.push(bashTurn(`grep ${w} src`));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(true);
    const a = await s.agentNow();
    expect(a.lifecycle).toBe("blocked");
    expect(a.blockedReason).toContain("no committed-diff progress");
  });

  it("FAIL-SAFE: valid JSON but an UNKNOWN verdict → blocked (parser rejects, controller blocks)", async () => {
    const s = await makeStuckScenario({
      judge: () => '{"verdict":"maybe","reason":"hedging"}',
    });
    s.probes.push(bashTurn("grep a src"), bashTurn("grep b src"));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false);
    for (const w of ["c", "d", "e", "f", "g", "h"]) s.probes.push(bashTurn(`grep ${w} src`));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(true);
    expect((await s.agentNow()).lifecycle).toBe("blocked");
  });

  it("FAIL-SAFE: an async rejection (subprocess timeout shape) → blocked", async () => {
    const s = await makeStuckScenario({
      judge: () => Promise.reject(new Error("claude -p timed out")),
    });
    s.probes.push(bashTurn("grep a src"), bashTurn("grep b src"));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false);
    for (const w of ["c", "d", "e", "f", "g", "h"]) s.probes.push(bashTurn(`grep ${w} src`));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(true);
    expect((await s.agentNow()).lifecycle).toBe("blocked");
  });

  it("PROGRESSING records an audit note and never escalates to the PM", async () => {
    const s = await makeStuckScenario({
      judge: () => '{"verdict":"progressing","reason":"reading 6 distinct files"}',
    });
    s.probes.push(readTurn("a.ts"), readTurn("b.ts"));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false);
    for (const f of ["c", "d", "e", "f", "g", "h"]) s.probes.push(readTurn(`${f}.ts`));
    expect(await s.controller.checkCircuitBreaker(s.orchId, s.agentId)).toBe(false);

    const a = await s.agentNow();
    expect(a.lifecycle).toBe("running");
    expect(a.breaker?.flaggedAt).toBeUndefined();
    // progressing is a coordination note, NOT a human-paging escalation.
    expect(s.escalations).toHaveLength(0);
    const events = await store.readEvents(s.orchId);
    const note = events.find(
      (e) => (e.data as { kind?: string } | undefined)?.kind === "stuck_judge",
    );
    expect(note).toBeTruthy();
    expect((note!.data as { verdict?: string }).verdict).toBe("progressing");
  });
});

// ---- finalMarkerText (full persisted summary) ------------------------------

describe("finalMarkerText", () => {
  it("returns the LAST assistant message in full, marker stripped", () => {
    const events: TranscriptEvent[] = [
      { kind: "assistant", uuid: "1", ts: "t", blocks: [{ type: "text", text: "early turn" }] },
      {
        kind: "assistant",
        uuid: "2",
        ts: "t",
        blocks: [
          {
            type: "text",
            text: `Changed foo.ts and bar.ts.\nAdded a guard.\n${DONE_MARKER}`,
          },
        ],
      },
    ];
    const full = finalMarkerText(events);
    expect(full).toContain("Changed foo.ts and bar.ts.");
    expect(full).toContain("Added a guard.");
    expect(full).not.toContain("early turn"); // only the final message
    expect(full).not.toContain(DONE_MARKER); // marker stripped
  });

  it("keeps lines the lean 8-line summary would truncate", () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const events: TranscriptEvent[] = [
      {
        kind: "assistant",
        uuid: "1",
        ts: "t",
        blocks: [{ type: "text", text: `${long}\n${DONE_MARKER}` }],
      },
    ];
    const full = finalMarkerText(events);
    // The lean summary drops the head of the block; the full text keeps it.
    expect(leanSummary(full)).not.toContain("line 1\n");
    expect(full).toContain("line 1");
    expect(full).toContain("line 12");
  });
});

describe("markerForLifecycle", () => {
  it("maps terminal lifecycles to a routing marker (null for cancelled)", () => {
    expect(markerForLifecycle("done")).toBe("done");
    expect(markerForLifecycle("stopped")).toBe("done");
    expect(markerForLifecycle("blocked")).toBe("blocked");
    expect(markerForLifecycle("failed")).toBe("blocked");
    expect(markerForLifecycle("cancelled")).toBeNull();
    expect(markerForLifecycle("running")).toBeNull();
  });
});

// ---- PART 1: summary persists + survives reaping ---------------------------

describe("AutonomyController summary persistence", () => {
  it("persists the FULL DONE marker text on the record, surviving a reap", async () => {
    const orchId = await makeOrchWithHead();
    const agent = await store.addAgent(orchId, {
      role: "coder",
      branch: "hark/ship-login/coder-1",
      worktreeDir: "/wt/coder",
      sessionId: "sess-coder",
      lifecycle: "running",
    });
    await store.updateAgent(orchId, agent!.id, (a) => (a.briefedAt = 1));

    // A summary longer than the lean 8-line notification cap.
    const lines = Array.from({ length: 11 }, (_, i) => `change ${i + 1}`);
    const summaryText = lines.join("\n");
    const { controller } = makeHeadAwareController({
      ready: true,
      transcript: [
        {
          kind: "assistant",
          uuid: "a",
          ts: "t",
          blocks: [{ type: "text", text: `${summaryText}\n${DONE_MARKER}` }],
        },
      ],
    });

    await controller.onAgentSignal(orchId, agent!.id, { stopped: true });

    const persisted = (await store.getOrchestration(orchId))!.agents.find(
      (a) => a.id === agent!.id,
    )!;
    expect(persisted.lifecycle).toBe("done");
    // FULL text — including the first line a lean truncation would drop — and
    // without the marker token.
    expect(persisted.summary).toContain("change 1");
    expect(persisted.summary).toContain("change 11");
    expect(persisted.summary).not.toContain(DONE_MARKER);

    // Simulate the reconcile loop reaping the finished worker: the live session
    // is gone (killedAt set), but the summary lives on the record.
    await orchestrator.killTerminalAgent(orchId, agent!.id);
    const afterReap = (await store.getOrchestration(orchId))!.agents.find(
      (a) => a.id === agent!.id,
    )!;
    expect(afterReap.killedAt).not.toBeNull();
    expect(afterReap.summary).toContain("change 1");
    expect(afterReap.summary).toContain("change 11");
  });

  it("persists the BLOCKED marker text too", async () => {
    const orchId = await makeOrchWithHead();
    const agent = await store.addAgent(orchId, {
      role: "coder",
      branch: "hark/ship-login/coder-1",
      worktreeDir: "/wt/coder",
      sessionId: "sess-coder",
      lifecycle: "running",
    });
    await store.updateAgent(orchId, agent!.id, (a) => (a.briefedAt = 1));
    const { controller } = makeHeadAwareController({
      ready: true,
      transcript: [
        {
          kind: "assistant",
          uuid: "a",
          ts: "t",
          blocks: [
            { type: "text", text: `Need a decision on the API shape.\n${BLOCKED_MARKER}` },
          ],
        },
      ],
    });
    await controller.onAgentSignal(orchId, agent!.id, { stopped: true });
    const a = (await store.getOrchestration(orchId))!.agents.find(
      (x) => x.id === agent!.id,
    )!;
    expect(a.lifecycle).toBe("blocked");
    expect(a.summary).toContain("Need a decision on the API shape.");
  });
});

// ---- PART 2: reliable worker-done wake-up (exactly once) -------------------

interface WakeRecord {
  escalations: { role: string; reason: string }[];
  pushes: string[];
  headSent: string[];
}

// A managed PM-head controller wired with all three routing deps (escalate /
// push / head-send) so we can assert exactly which fires — and how often.
function makeWakeController(opts: {
  transcript?: TranscriptEvent[];
  idleThresholdMs?: number;
}): { controller: AutonomyController } & WakeRecord {
  const rec: WakeRecord = { escalations: [], pushes: [], headSent: [] };
  const controller = new AutonomyController({
    store,
    orchestrator,
    readTranscript: async () => opts.transcript ?? [],
    sendText: async () => {},
    sessionReady: async () => true,
    sendToHead: async (_o, text) => {
      rec.headSent.push(text);
    },
    agentGitSummary: async () => ({ diffstat: "1 file +2/-0", commitCount: 1 }),
    escalateToHuman: async (_o, a, reason) => {
      rec.escalations.push({ role: a.role, reason });
    },
    pushHeadTurn: async (_o, text) => {
      rec.pushes.push(text);
    },
    idleThresholdMs: opts.idleThresholdMs ?? 1000,
    now: () => 1_000_000,
  });
  return { controller, ...rec };
}

async function makeManagedWithWorker(opts: {
  lifecycle: OrchAgent["lifecycle"];
  summary?: string;
  lastHumanAt?: number;
  autonomyLevel?: "L0" | "L1" | "L2" | "L3";
}): Promise<{ orchId: string; agentId: string }> {
  const o = await store.createManagedHead({
    name: "PM: app",
    goal: "g",
    projectRoot: "/home/u/app",
    projectName: "app",
    baseRef: "main",
    sessionId: "sess-head",
    branch: "main",
    autonomyLevel: opts.autonomyLevel ?? "L2",
  });
  await store.updateOrchestration(o.id, (x) => {
    x.lastHumanAt = opts.lastHumanAt ?? 0; // idle by default (now=1_000_000)
  });
  const agent = await store.addAgent(o.id, {
    role: "coder",
    branch: "hark/app/coder-1",
    worktreeDir: "/wt/coder",
    sessionId: "sess-coder",
    lifecycle: opts.lifecycle,
  });
  await store.updateAgent(o.id, agent!.id, (a) => {
    a.briefedAt = 1;
    if (opts.summary != null) a.summary = opts.summary;
  });
  return { orchId: o.id, agentId: agent!.id };
}

describe("AutonomyController.wakeHeadForTerminal (reliable wake-up)", () => {
  it("wakes the head exactly once, even across repeated calls", async () => {
    const { orchId, agentId } = await makeManagedWithWorker({
      lifecycle: "done",
      summary: "did the thing",
    });
    const { controller, pushes } = makeWakeController({});

    await controller.wakeHeadForTerminal(orchId, agentId);
    await controller.wakeHeadForTerminal(orchId, agentId);
    await controller.wakeHeadForTerminal(orchId, agentId);

    expect(pushes).toHaveLength(1); // fire-once guard (headWokeAt)
    const a = (await store.getOrchestration(orchId))!.agents.find(
      (x) => x.id === agentId,
    )!;
    expect(a.headWokeAt).toBe(1_000_000);
  });

  it("wakes for a worker that went terminal via the reconcile loop (stopped, NO marker)", async () => {
    // The exact bug: a worker reaches terminal WITHOUT ever emitting a marker
    // (here a `hark agent stop`). The wake must still fire, built from the
    // persisted record — not from a live transcript scan.
    const { orchId, agentId } = await makeManagedWithWorker({
      lifecycle: "stopped",
      summary: "halted by operator",
    });
    const { controller, pushes, escalations } = makeWakeController({});

    await controller.wakeHeadForTerminal(orchId, agentId);
    // `stopped` routes like `done` → idle advance push.
    expect(pushes).toHaveLength(1);
    expect(escalations).toHaveLength(0);
  });

  it("escalates a blocked worker exactly once (no double-page)", async () => {
    const { orchId, agentId } = await makeManagedWithWorker({
      lifecycle: "blocked",
      summary: "needs a human call",
    });
    const { controller, escalations, pushes } = makeWakeController({});
    await controller.wakeHeadForTerminal(orchId, agentId);
    await controller.wakeHeadForTerminal(orchId, agentId);
    expect(escalations).toHaveLength(1);
    expect(pushes).toHaveLength(0);
  });

  it("does nothing for a non-terminal worker", async () => {
    const { orchId, agentId } = await makeManagedWithWorker({
      lifecycle: "running",
    });
    const { controller, pushes, escalations } = makeWakeController({});
    await controller.wakeHeadForTerminal(orchId, agentId);
    expect(pushes).toHaveLength(0);
    expect(escalations).toHaveLength(0);
    const a = (await store.getOrchestration(orchId))!.agents.find(
      (x) => x.id === agentId,
    )!;
    expect(a.headWokeAt).toBeUndefined();
  });

  it("marker path + reconcile path together fire the wake exactly once", async () => {
    // onAgentSignal sees the DONE marker and wakes immediately; the reconcile
    // loop's safety-net wake then no-ops via the guard — exactly once total.
    const { orchId, agentId } = await makeManagedWithWorker({
      lifecycle: "running",
    });
    const { controller, pushes } = makeWakeController({
      transcript: [
        {
          kind: "assistant",
          uuid: "a",
          ts: "t",
          blocks: [{ type: "text", text: `all done\n${DONE_MARKER}` }],
        },
      ],
    });

    await controller.onAgentSignal(orchId, agentId, { stopped: true }); // marker path
    await controller.wakeHeadForTerminal(orchId, agentId); // reconcile safety net
    await controller.wakeHeadForTerminal(orchId, agentId);

    expect(pushes).toHaveLength(1);
  });
});
