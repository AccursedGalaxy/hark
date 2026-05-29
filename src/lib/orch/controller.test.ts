import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OrchStore } from "./store.js";
import { Orchestrator } from "./orchestrator.js";
import {
  AutonomyController,
  buildNudge,
  decideAutonomyAction,
  metricsFromTranscript,
  scanMarkers,
  transcriptText,
  type AutonomyState,
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
});

describe("decideAutonomyAction", () => {
  const base: AutonomyState = {
    lifecycle: "running",
    sessionReady: true,
    briefingDelivered: true,
    stopped: false,
    scan: { kind: null, summary: "" },
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
