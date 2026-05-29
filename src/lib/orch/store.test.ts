import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OrchStore } from "./store.js";

let dir: string;
let store: OrchStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-orch-"));
  store = new OrchStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const baseInput = {
  name: "Ship login",
  goal: "Add OAuth login",
  projectRoot: "/home/u/app",
  projectName: "app",
  baseRef: "main",
};

describe("OrchStore lifecycle", () => {
  it("creates, reads back, and lists orchestrations", async () => {
    const o = await store.createOrchestration(baseInput);
    expect(o.id).toMatch(/^orch-/);
    expect(o.status).toBe("active");
    expect(o.agents).toEqual([]);

    const got = await store.getOrchestration(o.id);
    expect(got).not.toBeNull();
    expect(got!.name).toBe("Ship login");
    expect(got!.baseRef).toBe("main");

    const list = await store.listOrchestrations();
    expect(list.map((x) => x.id)).toContain(o.id);
  });

  it("logs an orchestration_created event on create", async () => {
    const o = await store.createOrchestration(baseInput);
    const events = await store.readEvents(o.id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("orchestration_created");
    expect(events[0].orchestrationId).toBe(o.id);
  });

  it("returns null for an unknown orchestration", async () => {
    expect(await store.getOrchestration("orch-nope")).toBeNull();
    expect(await store.readEvents("orch-nope")).toEqual([]);
  });

  it("adds agents with empty metrics and logs the spawn", async () => {
    const o = await store.createOrchestration(baseInput);
    const agent = await store.addAgent(o.id, {
      role: "coder",
      branch: "hark/ship-login/coder-1",
      worktreeDir: "/wt/coder",
      pid: 1234,
    });
    expect(agent).not.toBeNull();
    expect(agent!.id).toMatch(/^agent-/);
    expect(agent!.lifecycle).toBe("pending");
    expect(agent!.metrics.inputTokens).toBe(0);
    expect(agent!.pid).toBe(1234);

    const got = await store.getOrchestration(o.id);
    expect(got!.agents).toHaveLength(1);

    const events = await store.readEvents(o.id);
    expect(events.some((e) => e.kind === "agent_spawned")).toBe(true);
  });

  it("transitions agent lifecycle and records a blocked reason", async () => {
    const o = await store.createOrchestration(baseInput);
    const agent = await store.addAgent(o.id, {
      role: "tester",
      branch: "b",
      worktreeDir: "/wt/tester",
    });

    await store.setAgentLifecycle(o.id, agent!.id, "running");
    let got = await store.getOrchestration(o.id);
    expect(got!.agents[0].lifecycle).toBe("running");

    await store.setAgentLifecycle(o.id, agent!.id, "blocked", {
      reason: "needs a DB password",
    });
    got = await store.getOrchestration(o.id);
    expect(got!.agents[0].lifecycle).toBe("blocked");
    expect(got!.agents[0].blockedReason).toBe("needs a DB password");

    // Leaving blocked clears the reason.
    await store.setAgentLifecycle(o.id, agent!.id, "running");
    got = await store.getOrchestration(o.id);
    expect(got!.agents[0].blockedReason).toBeUndefined();

    const events = await store.readEvents(o.id);
    const lifecycleEvents = events.filter((e) => e.kind === "agent_lifecycle");
    expect(lifecycleEvents).toHaveLength(3);
  });

  it("updates orchestration status with an event", async () => {
    const o = await store.createOrchestration(baseInput);
    await store.setStatus(o.id, "completed");
    const got = await store.getOrchestration(o.id);
    expect(got!.status).toBe("completed");
    const events = await store.readEvents(o.id);
    expect(events.some((e) => e.kind === "orchestration_status")).toBe(true);
  });

  it("accumulates agent metrics via updateAgent", async () => {
    const o = await store.createOrchestration(baseInput);
    const agent = await store.addAgent(o.id, {
      role: "coder",
      branch: "b",
      worktreeDir: "/wt",
    });
    await store.updateAgent(o.id, agent!.id, (a) => {
      a.metrics.inputTokens += 1000;
      a.metrics.outputTokens += 250;
      a.metrics.turns += 1;
    });
    const got = await store.getOrchestration(o.id);
    expect(got!.agents[0].metrics.inputTokens).toBe(1000);
    expect(got!.agents[0].metrics.turns).toBe(1);
  });
});

describe("OrchStore concurrency", () => {
  it("serializes concurrent agent additions without losing any", async () => {
    const o = await store.createOrchestration(baseInput);
    // Fire many addAgent calls at once; the per-id lock must keep every push
    // (a naive read-modify-write would drop all but the last).
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.addAgent(o.id, {
          role: "coder",
          branch: `b-${i}`,
          worktreeDir: `/wt/${i}`,
        }),
      ),
    );
    const got = await store.getOrchestration(o.id);
    expect(got!.agents).toHaveLength(10);
  });
});

describe("readEventsFromOffset (incremental tail)", () => {
  it("returns [] and offset 0 for a log that doesn't exist yet", async () => {
    const r = await store.readEventsFromOffset("orch-nope", 0);
    expect(r.events).toEqual([]);
    expect(r.offset).toBe(0);
  });

  it("tails only the bytes appended since the prior offset", async () => {
    const o = await store.createOrchestration(baseInput); // appends 1 event
    const first = await store.readEventsFromOffset(o.id, 0);
    expect(first.events).toHaveLength(1);
    expect(first.offset).toBeGreaterThan(0);

    // Nothing new since `first.offset`.
    const none = await store.readEventsFromOffset(o.id, first.offset);
    expect(none.events).toEqual([]);
    expect(none.offset).toBe(first.offset);

    // Append two more, then tail from the saved offset → exactly the new two.
    await store.appendEvent({
      ts: 1,
      orchestrationId: o.id,
      kind: "note",
      message: "one",
    });
    await store.appendEvent({
      ts: 2,
      orchestrationId: o.id,
      kind: "note",
      message: "two",
    });
    const next = await store.readEventsFromOffset(o.id, first.offset);
    expect(next.events.map((e) => e.message)).toEqual(["one", "two"]);
    expect(next.offset).toBeGreaterThan(first.offset);
  });

  it("restarts from 0 when the file shrank below the offset (rotation/truncation)", async () => {
    const o = await store.createOrchestration(baseInput);
    const all = await store.readEventsFromOffset(o.id, 0);
    // Offset past EOF (file was rotated smaller) → re-read from the start.
    const r = await store.readEventsFromOffset(o.id, all.offset + 10_000);
    expect(r.events).toHaveLength(1);
    expect(r.offset).toBe(all.offset);
  });
});
