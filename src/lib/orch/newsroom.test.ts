import { describe, it, expect } from "vitest";
import {
  buildNewsroom,
  renderNewsForInjection,
  type OrchEventsInput,
} from "./newsroom.js";
import type { OrchEvent, Orchestration } from "../../shared/protocol.js";

function orch(id: string, name: string): Orchestration {
  return {
    id,
    name,
    goal: "g",
    projectRoot: "/p",
    projectName: "p",
    baseRef: "main",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    agents: [],
  };
}

function lifecycle(
  ts: number,
  orchId: string,
  agentId: string,
  lc: string,
  extra: Record<string, unknown> = {},
): OrchEvent {
  return {
    ts,
    orchestrationId: orchId,
    agentId,
    kind: "agent_lifecycle",
    message: `coder → ${lc}`,
    data: { lifecycle: lc, role: "coder", branch: `b-${agentId}`, ...extra },
  };
}

describe("buildNewsroom", () => {
  const o = orch("orch-1", "Ship login");

  it("includes only head-relevant lifecycle transitions", () => {
    const events: OrchEvent[] = [
      lifecycle(10, "orch-1", "a1", "spawning"),
      lifecycle(20, "orch-1", "a1", "running"),
      lifecycle(30, "orch-1", "a1", "done"),
      lifecycle(40, "orch-1", "a2", "blocked", { reason: "needs API key" }),
      lifecycle(50, "orch-1", "a3", "cancelled"),
    ];
    const { items } = buildNewsroom([{ orch: o, events }]);
    expect(items.map((i) => i.kind)).toEqual(["done", "blocked"]);
    expect(items[1].summary).toBe("needs API key");
    expect(items[0].branch).toBe("b-a1");
  });

  it("maps review→handoff and failed, and completed from orchestration_status", () => {
    const events: OrchEvent[] = [
      lifecycle(10, "orch-1", "a1", "review"),
      lifecycle(20, "orch-1", "a2", "failed"),
      {
        ts: 30,
        orchestrationId: "orch-1",
        kind: "orchestration_status",
        message: "Orchestration status → completed",
        data: { status: "completed" },
      },
      {
        ts: 25,
        orchestrationId: "orch-1",
        kind: "orchestration_status",
        message: "Orchestration status → archived",
        data: { status: "archived" },
      },
    ];
    const { items } = buildNewsroom([{ orch: o, events }]);
    expect(items.map((i) => i.kind)).toEqual(["handoff", "failed", "completed"]);
  });

  it("respects the since cursor and advances past irrelevant events", () => {
    const events: OrchEvent[] = [
      lifecycle(10, "orch-1", "a1", "done"),
      lifecycle(20, "orch-1", "a1", "running"), // irrelevant
      lifecycle(30, "orch-1", "a2", "blocked"),
    ];
    const { items, cursor } = buildNewsroom([{ orch: o, events }], 15);
    // Only events after ts=15.
    expect(items.map((i) => i.ts)).toEqual([30]);
    // Cursor advances past the irrelevant ts=20 event too.
    expect(cursor).toBe(30);
  });

  it("returns the input cursor when nothing is new", () => {
    const events: OrchEvent[] = [lifecycle(10, "orch-1", "a1", "done")];
    const { items, cursor } = buildNewsroom([{ orch: o, events }], 100);
    expect(items).toHaveLength(0);
    expect(cursor).toBe(100);
  });

  it("merges + time-orders across multiple orchestrations", () => {
    const o2 = orch("orch-2", "Fix bug");
    const a: OrchEventsInput = {
      orch: o,
      events: [lifecycle(10, "orch-1", "a1", "done"), lifecycle(50, "orch-1", "a1", "blocked")],
    };
    const b: OrchEventsInput = {
      orch: o2,
      events: [lifecycle(30, "orch-2", "b1", "done")],
    };
    const { items } = buildNewsroom([a, b]);
    expect(items.map((i) => [i.ts, i.orchestrationName])).toEqual([
      [10, "Ship login"],
      [30, "Fix bug"],
      [50, "Ship login"],
    ]);
  });
});

describe("renderNewsForInjection", () => {
  it("is empty when there is no news", () => {
    expect(renderNewsForInjection([])).toBe("");
  });

  it("renders a compact, triage-prompting block", () => {
    const text = renderNewsForInjection([
      {
        ts: 1,
        orchestrationId: "o",
        orchestrationName: "n",
        role: "coder",
        branch: "feat",
        kind: "done",
        summary: "added parser",
        diffstat: "2 files +30/-4",
      },
    ]);
    expect(text).toContain("TEAM NEWS");
    expect(text.toLowerCase()).toContain("triage");
    expect(text).toContain("coder DONE");
    expect(text).toContain("feat");
    expect(text).toContain("2 files +30/-4");
    expect(text).toContain("added parser");
  });
});
