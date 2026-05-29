import { describe, it, expect } from "vitest";
import {
  buildResolveRequest,
  envFromProcess,
  mergeResolved,
  planCommand,
  renderResponse,
  type CliEnv,
} from "./cli.js";
import type { OrchStatusView } from "../../shared/protocol.js";

const headEnv: CliEnv = {
  orchId: "orch-1",
  api: "http://localhost:3000",
  role: "head",
};
const workerEnv: CliEnv = {
  orchId: "orch-1",
  api: "http://localhost:3000",
  role: "coder",
};

describe("planCommand — orch status", () => {
  it("GETs the orchestration status view", () => {
    const plan = planCommand(["orch", "status"], headEnv);
    expect(plan).toEqual({
      kind: "request",
      request: { method: "GET", path: "/api/orchestrations/orch-1/status" },
      render: "status",
    });
  });

  it("errors without an orchestration id in the env", () => {
    const plan = planCommand(["orch", "status"], { api: "x" });
    expect(plan.kind).toBe("error");
  });

  it("long-polls events for orch watch", () => {
    const plan = planCommand(["orch", "watch"], headEnv);
    expect(plan).toEqual({
      kind: "request",
      request: { method: "GET", path: "/api/orchestrations/orch-1/events?wait=1" },
      render: "watch",
    });
  });
});

describe("planCommand — head init (promotion)", () => {
  it("POSTs the promote with the session id + cwd", () => {
    const plan = planCommand(["head", "init"], {
      api: "http://localhost:3000",
      sessionId: "sess-abc",
      cwd: "/home/u/app",
    });
    expect(plan).toEqual({
      kind: "request",
      request: {
        method: "POST",
        path: "/api/head/promote",
        body: { sessionId: "sess-abc", cwd: "/home/u/app" },
      },
      render: "promote",
    });
  });

  it("errors when not inside a Claude Code session", () => {
    const plan = planCommand(["head", "init"], { api: "x", cwd: "/home/u/app" });
    expect(plan.kind).toBe("error");
  });

  it("renders the charter from the promote response as stdout", () => {
    const out = renderResponse("promote", {
      ok: true,
      orchId: "orch-1",
      reattached: false,
      charter: "You are the **product manager**…",
    });
    expect(out).toContain("Promoted this session");
    expect(out).toContain("product manager");
  });

  it("POSTs the autonomy dial against the resolved orchId", () => {
    const plan = planCommand(["head", "autonomy", "l3"], {
      ...headEnv,
    });
    expect(plan).toEqual({
      kind: "request",
      request: {
        method: "POST",
        path: "/api/orchestrations/orch-1/autonomy",
        body: { level: "L3" },
      },
      render: "autonomy",
    });
  });

  it("rejects an unknown autonomy level", () => {
    expect(planCommand(["head", "autonomy", "L9"], headEnv).kind).toBe("error");
  });

  it("notes a re-attach when promoting an already-managed project", () => {
    const out = renderResponse("promote", {
      reattached: true,
      charter: "charter body",
    });
    expect(out).toContain("Re-attached");
  });
});

describe("planCommand — pr", () => {
  it("POSTs a PR request for the agent (no title → --fill server-side)", () => {
    const plan = planCommand(["pr", "agent-3"], headEnv);
    expect(plan).toEqual({
      kind: "request",
      request: {
        method: "POST",
        path: "/api/orchestrations/orch-1/agents/agent-3/pr",
        body: {},
      },
      render: "pr",
    });
  });

  it("passes a --title through", () => {
    const plan = planCommand(["pr", "agent-3", "--title", "Add OAuth"], headEnv);
    if (plan.kind === "request") {
      expect(plan.request.body).toEqual({ title: "Add OAuth" });
    } else {
      throw new Error("expected request");
    }
  });

  it("errors without an agentId", () => {
    expect(planCommand(["pr"], headEnv).kind).toBe("error");
  });

  it("renders the created PR url", () => {
    const out = renderResponse("pr", {
      ok: true,
      result: { status: "created", url: "https://gh/pr/9", branch: "feat" },
    });
    expect(out).toContain("https://gh/pr/9");
  });

  it("renders the no-remote ready-branch message", () => {
    const out = renderResponse("pr", {
      ok: true,
      result: { status: "no_remote", branch: "feat", diffstat: "1 file", message: "Branch feat is ready" },
    });
    expect(out).toContain("ready");
  });
});

describe("env-fallback resolution", () => {
  it("builds a resolve GET from cwd when orchId is unset", () => {
    const req = buildResolveRequest({
      api: "x",
      cwd: "/home/u/app",
      sessionId: "sess-1",
    });
    expect(req?.method).toBe("GET");
    expect(req?.path).toContain("/api/head/resolve?");
    expect(req?.path).toContain("cwd=%2Fhome%2Fu%2Fapp");
    expect(req?.path).toContain("sessionId=sess-1");
  });

  it("does not resolve when orchId is already known", () => {
    expect(buildResolveRequest({ api: "x", orchId: "orch-1", cwd: "/x" })).toBeNull();
  });

  it("does not resolve without a cwd", () => {
    expect(buildResolveRequest({ api: "x" })).toBeNull();
  });

  it("merges the resolved orchId + role into the env", () => {
    const merged = mergeResolved(
      { api: "x", cwd: "/home/u/app" },
      { orchId: "orch-9", role: "head" },
    );
    expect(merged.orchId).toBe("orch-9");
    expect(merged.role).toBe("head");
  });

  it("reads CLAUDE_CODE_SESSION_ID + cwd from the process env", () => {
    const env = envFromProcess(
      { CLAUDE_CODE_SESSION_ID: "sess-x", HARK_API: "http://h:9" },
      "/work/dir",
    );
    expect(env.sessionId).toBe("sess-x");
    expect(env.cwd).toBe("/work/dir");
    expect(env.api).toBe("http://h:9");
  });

  it("unlocks agent spawn once the env-fallback supplies role=head", () => {
    // Simulate a promoted head: no orchId/role in env, then resolved.
    const resolved = mergeResolved(
      { api: "x", cwd: "/home/u/app", sessionId: "s" },
      { orchId: "orch-1", role: "head" },
    );
    const plan = planCommand(
      ["agent", "spawn", "coder", "--task", "do it"],
      resolved,
    );
    expect(plan.kind).toBe("request");
    if (plan.kind === "request") {
      expect(plan.request.path).toBe("/api/orchestrations/orch-1/agents");
    }
  });
});

describe("planCommand — agent spawn (head-gated)", () => {
  it("POSTs a spawn with role, task, and dependsOn", () => {
    const plan = planCommand(
      ["agent", "spawn", "coder", "--task", "Build the parser", "--depends-on", "agent-9"],
      headEnv,
    );
    expect(plan).toEqual({
      kind: "request",
      request: {
        method: "POST",
        path: "/api/orchestrations/orch-1/agents",
        body: { role: "coder", task: "Build the parser", dependsOn: "agent-9" },
      },
      render: "spawn",
    });
  });

  it("rejects an unknown role", () => {
    const plan = planCommand(["agent", "spawn", "wizard", "--task", "x"], headEnv);
    expect(plan.kind).toBe("error");
  });

  it("is gated to the head — a worker cannot spawn", () => {
    const plan = planCommand(
      ["agent", "spawn", "coder", "--task", "x"],
      workerEnv,
    );
    expect(plan.kind).toBe("error");
    if (plan.kind === "error") expect(plan.message).toMatch(/head/i);
  });

  it("requires a task", () => {
    const plan = planCommand(["agent", "spawn", "coder"], headEnv);
    expect(plan.kind).toBe("error");
  });
});

describe("planCommand — agent send / brief / diff / log", () => {
  it("sends a message to a worker", () => {
    const plan = planCommand(["agent", "send", "agent-2", "run the tests"], headEnv);
    expect(plan).toEqual({
      kind: "request",
      request: {
        method: "POST",
        path: "/api/orchestrations/orch-1/agents/agent-2/send",
        body: { text: "run the tests" },
      },
      render: "send",
    });
  });

  it("briefs a worker with its next task", () => {
    const plan = planCommand(["agent", "brief", "agent-2", "now add docs"], headEnv);
    expect(plan).toEqual({
      kind: "request",
      request: {
        method: "POST",
        path: "/api/orchestrations/orch-1/agents/agent-2/brief",
        body: { task: "now add docs" },
      },
      render: "brief",
    });
  });

  it("defaults diff to --stat and supports --full", () => {
    expect(planCommand(["agent", "diff", "agent-2"], headEnv)).toEqual({
      kind: "request",
      request: {
        method: "GET",
        path: "/api/orchestrations/orch-1/agents/agent-2/diff?mode=stat",
      },
      render: "diff",
    });
    expect(
      (planCommand(["agent", "diff", "agent-2", "--full"], headEnv) as any).request
        .path,
    ).toBe("/api/orchestrations/orch-1/agents/agent-2/diff?mode=full");
  });

  it("gets a worker's commit log", () => {
    const plan = planCommand(["agent", "log", "agent-2"], headEnv);
    expect((plan as any).request.path).toBe(
      "/api/orchestrations/orch-1/agents/agent-2/log",
    );
  });
});

describe("planCommand — errors and help", () => {
  it("returns help for no args or --help", () => {
    expect(planCommand([], headEnv).kind).toBe("message");
    expect(planCommand(["--help"], headEnv).kind).toBe("message");
  });

  it("errors on an unknown command", () => {
    expect(planCommand(["frobnicate"], headEnv).kind).toBe("error");
  });
});

describe("renderResponse — status", () => {
  const view: OrchStatusView = {
    id: "orch-1",
    name: "Ship login",
    goal: "Add OAuth",
    status: "active",
    head: {
      branch: "hark/ship-login/head",
      sessionId: "sess-head",
      briefed: true,
      turns: 12,
      tokens: 45000,
    },
    agents: [
      {
        id: "agent-2",
        role: "coder",
        lifecycle: "running",
        branch: "hark/ship-login/coder-aaa",
        diffstat: "2 files +30/-4",
        turns: 8,
        tokens: 22000,
        task: "Build the parser",
      },
      {
        id: "agent-3",
        role: "tester",
        lifecycle: "done",
        branch: "hark/ship-login/tester-bbb",
        diffstat: "1 file +12/-0",
        turns: 5,
        tokens: 9000,
      },
    ],
  };

  it("renders one compact line per agent plus the head, no transcripts", () => {
    const out = renderResponse("status", view);
    expect(out).toContain("Ship login");
    expect(out).toContain("head");
    expect(out).toContain("coder");
    expect(out).toContain("agent-2");
    expect(out).toContain("running");
    expect(out).toContain("2 files +30/-4");
    expect(out).toContain("tester");
    expect(out).toContain("done");
    // One line per agent (+ a header line + a head line). No giant dumps.
    expect(out.split("\n").length).toBeLessThan(12);
  });
});

describe("renderResponse — spawn / send / diff", () => {
  it("reports the new agent id on spawn", () => {
    const out = renderResponse("spawn", { ok: true, agent: { id: "agent-9", role: "coder" } });
    expect(out).toContain("agent-9");
    expect(out).toContain("coder");
  });

  it("prints the raw diff for diff", () => {
    const out = renderResponse("diff", { diff: " file.ts | 3 +++\n" });
    expect(out).toContain("file.ts");
  });

  it("acknowledges send/brief", () => {
    expect(renderResponse("send", { ok: true }).toLowerCase()).toContain("ok");
    expect(renderResponse("brief", { ok: true }).toLowerCase()).toContain("ok");
  });

  it("renders watched events and the timeout case", () => {
    const out = renderResponse("watch", {
      events: [{ kind: "head_notified", message: "coder → done" }],
    });
    expect(out).toContain("head_notified");
    expect(out).toContain("coder → done");
    expect(renderResponse("watch", { events: [] })).toContain("no new events");
  });
});
