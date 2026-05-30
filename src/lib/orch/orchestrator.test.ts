import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OrchStore } from "./store.js";
import {
  Orchestrator,
  type OrchestratorDeps,
  type SpawnSessionResult,
} from "./orchestrator.js";

let dir: string;
let store: OrchStore;

// Records of the side effects the fakes were asked to perform.
interface SpawnCall {
  cwd: string;
  command?: string;
  env?: Record<string, string>;
  pathPrepend?: string;
}
interface Calls {
  added: { worktreeDir: string; branch: string; baseRef: string }[];
  removed: string[];
  spawned: string[];
  spawnCalls: SpawnCall[];
  trustCleared: string[];
  killed: number[];
  // Interleaved record of kill/remove effects, so tests can assert ordering
  // (a session must be killed before its worktree is removed).
  order: string[];
}

function makeDeps(
  store: OrchStore,
  overrides: Partial<OrchestratorDeps> = {},
): { deps: OrchestratorDeps; calls: Calls } {
  const calls: Calls = {
    added: [],
    removed: [],
    spawned: [],
    spawnCalls: [],
    trustCleared: [],
    killed: [],
    order: [],
  };
  let pidSeq = 1000;
  const deps: OrchestratorDeps = {
    store,
    baseDir: "/wt-base",
    apiBase: "http://localhost:3000",
    cliBinDir: "/opt/hark/bin",
    addWorktree: async (o) => {
      calls.added.push({
        worktreeDir: o.worktreeDir,
        branch: o.branch,
        baseRef: o.baseRef,
      });
    },
    removeWorktree: async (o) => {
      calls.removed.push(o.worktreeDir);
      calls.order.push(`remove:${o.worktreeDir}`);
    },
    clearTrust: async (dir) => {
      calls.trustCleared.push(dir);
    },
    killSession: async (pid) => {
      calls.killed.push(pid);
      calls.order.push(`kill:${pid}`);
    },
    spawnSession: async (o): Promise<SpawnSessionResult> => {
      calls.spawned.push(o.cwd);
      calls.spawnCalls.push({
        cwd: o.cwd,
        command: o.command,
        env: o.env,
        pathPrepend: o.pathPrepend,
      });
      return { pid: pidSeq++ };
    },
    ...overrides,
  };
  return { deps, calls };
}

const teamInput = {
  name: "Ship login",
  goal: "Add OAuth login",
  projectRoot: "/home/u/app",
  projectName: "app",
  baseRef: "main",
  roles: ["researcher", "coder", "reviewer"] as const,
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-orchestrator-"));
  store = new OrchStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("Orchestrator.promoteSession (PM-head)", () => {
  it("promotes a session into a managed PM-head without spawning anything", async () => {
    const { deps, calls } = makeDeps(store, {
      currentBranch: async () => "feature/x",
    });
    const orch = new Orchestrator(deps);

    const { orchestration, reattached } = await orch.promoteSession({
      sessionId: "sess-abc",
      projectRoot: "/home/u/app",
      projectName: "app",
    });

    expect(reattached).toBe(false);
    expect(orchestration.managed).toBe(true);
    expect(orchestration.autonomyLevel).toBe("L2");
    // No worktree created, no session spawned — the tree + session exist.
    expect(calls.added).toHaveLength(0);
    expect(calls.spawned).toHaveLength(0);
    // The head IS this session, observing the project root read-only.
    expect(orchestration.head?.sessionId).toBe("sess-abc");
    expect(orchestration.head?.worktreeDir).toBe("/home/u/app");
    expect(orchestration.head?.branch).toBe("feature/x");
    expect(orchestration.baseRef).toBe("feature/x");
  });

  it("is idempotent — re-promoting re-attaches the (possibly new) session id", async () => {
    const { deps } = makeDeps(store, { currentBranch: async () => "main" });
    const orch = new Orchestrator(deps);

    const first = await orch.promoteSession({
      sessionId: "sess-1",
      projectRoot: "/home/u/app",
      projectName: "app",
    });
    const second = await orch.promoteSession({
      sessionId: "sess-2",
      projectRoot: "/home/u/app",
      projectName: "app",
    });

    expect(second.reattached).toBe(true);
    expect(second.orchestration.id).toBe(first.orchestration.id);
    expect(second.orchestration.head?.sessionId).toBe("sess-2");
    // Still exactly one orchestration for the project.
    const all = await store.listOrchestrations();
    expect(all.filter((o) => o.managed)).toHaveLength(1);
  });

  it("builds a PM charter that is read back as the command stdout", async () => {
    const { deps } = makeDeps(store, { currentBranch: async () => "main" });
    const orch = new Orchestrator(deps);
    const { orchestration } = await orch.promoteSession({
      sessionId: "sess-1",
      projectRoot: "/home/u/app",
      projectName: "app",
    });
    const charter = orch.pmCharterFor(orchestration);
    expect(charter.toLowerCase()).toContain("product manager");
    expect(charter).toContain("/home/u/app/PLAN.md");
    expect(charter).toContain("L2");
  });
});

describe("Orchestrator.createTeam", () => {
  it("creates an orchestration and one isolated agent per role", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);

    const { orchestration, agents } = await orch.createTeam({
      ...teamInput,
      roles: [...teamInput.roles],
    });

    expect(agents).toHaveLength(3);
    expect(agents.map((a) => a.role)).toEqual([
      "researcher",
      "coder",
      "reviewer",
    ]);

    // Each agent got its own worktree + a session spawned in it.
    expect(calls.added).toHaveLength(3);
    expect(calls.spawned).toHaveLength(3);
    for (const a of agents) {
      expect(a.worktreeDir).toContain("/wt-base/app/");
      expect(a.branch).toMatch(/^hark\/ship-login\//);
      expect(a.lifecycle).toBe("spawning");
      expect(a.pid).not.toBeNull();
      // The session was spawned with cwd = the agent's worktree.
      expect(calls.spawned).toContain(a.worktreeDir);
    }

    // Branches and worktrees are all distinct.
    const branches = new Set(agents.map((a) => a.branch));
    const dirs = new Set(agents.map((a) => a.worktreeDir));
    expect(branches.size).toBe(3);
    expect(dirs.size).toBe(3);

    // Persisted.
    const persisted = await store.getOrchestration(orchestration.id);
    expect(persisted!.agents).toHaveLength(3);
  });

  it("rolls back the worktree and marks the agent failed if spawn fails", async () => {
    const { deps, calls } = makeDeps(store, {
      spawnSession: async () => {
        throw new Error("tmux unavailable");
      },
    });
    const orch = new Orchestrator(deps);

    const { orchestration, agents } = await orch.createTeam({
      ...teamInput,
      roles: ["coder"],
    });

    // No agent returned (it failed), but the worktree was rolled back.
    expect(agents).toHaveLength(0);
    expect(calls.added).toHaveLength(1);
    expect(calls.removed).toEqual(calls.added.map((a) => a.worktreeDir));

    const persisted = await store.getOrchestration(orchestration.id);
    expect(persisted!.agents).toHaveLength(1);
    expect(persisted!.agents[0].lifecycle).toBe("failed");

    const events = await store.readEvents(orchestration.id);
    expect(events.some((e) => e.kind === "failure")).toBe(true);
  });

  it("does not spawn a session when worktree creation fails", async () => {
    const { deps, calls } = makeDeps(store, {
      addWorktree: async () => {
        throw new Error("not a git repo");
      },
    });
    const orch = new Orchestrator(deps);

    const { agents } = await orch.createTeam({ ...teamInput, roles: ["tester"] });
    expect(agents).toHaveLength(0);
    expect(calls.spawned).toHaveLength(0);
    // Nothing to roll back since the worktree never got created.
    expect(calls.removed).toHaveLength(0);
  });

  it("keeps staffing the team when one agent fails", async () => {
    let n = 0;
    const { deps } = makeDeps(store, {
      spawnSession: async (o) => {
        n++;
        if (n === 2) throw new Error("boom on the second");
        return { pid: 2000 + n };
      },
    });
    const orch = new Orchestrator(deps);
    const { orchestration, agents } = await orch.createTeam({
      ...teamInput,
      roles: ["researcher", "coder", "reviewer"],
    });

    // Second spawn failed; first and third succeeded.
    expect(agents.map((a) => a.role)).toEqual(["researcher", "reviewer"]);
    const persisted = await store.getOrchestration(orchestration.id);
    const failed = persisted!.agents.filter((a) => a.lifecycle === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].role).toBe("coder");
  });
});

describe("Orchestrator.spawnHead", () => {
  it("creates the head worktree + session, clears trust, records the head", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const created = await orch.createTeam({ ...teamInput, roles: [] });

    const head = await orch.spawnHead(created.orchestration.id);

    // Head branch is the dedicated head ref; worktree under the orch dir.
    expect(head.branch).toBe("hark/ship-login/head");
    expect(head.worktreeDir).toContain("/wt-base/app/");
    expect(head.worktreeDir).toMatch(/\/head$/);
    expect(head.pid).not.toBeNull();

    // Trust cleared for the head dir BEFORE the session was spawned.
    expect(calls.trustCleared).toContain(head.worktreeDir);

    // Spawned with the head env + skip-permissions posture + hark on PATH.
    const call = calls.spawnCalls.find((c) => c.cwd === head.worktreeDir)!;
    expect(call.command).toContain("--dangerously-skip-permissions");
    expect(call.env?.HARK_ROLE).toBe("head");
    expect(call.env?.HARK_ORCH_ID).toBe(created.orchestration.id);
    expect(call.env?.HARK_API).toBe("http://localhost:3000");
    expect(call.pathPrepend).toBe("/opt/hark/bin");

    // Persisted on the record (not in agents[]).
    const persisted = await store.getOrchestration(created.orchestration.id);
    expect(persisted!.head?.branch).toBe("hark/ship-login/head");
    expect(persisted!.agents).toHaveLength(0);
    const events = await store.readEvents(created.orchestration.id);
    expect(events.some((e) => e.kind === "head_spawned")).toBe(true);
  });
});

describe("Orchestrator.createWithHead", () => {
  it("creates an orchestration with a head and no workers", async () => {
    const { deps } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const { orchestration, head } = await orch.createWithHead({
      name: teamInput.name,
      goal: teamInput.goal,
      projectRoot: teamInput.projectRoot,
      projectName: teamInput.projectName,
      baseRef: teamInput.baseRef,
    });
    expect(head.branch).toBe("hark/ship-login/head");
    expect(orchestration.agents).toHaveLength(0);
    const persisted = await store.getOrchestration(orchestration.id);
    expect(persisted!.head).toBeTruthy();
  });
});

describe("Orchestrator.spawnAgent task/dependsOn", () => {
  it("records the dispatched task + dependency and clears trust per worker", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const created = await orch.createTeam({ ...teamInput, roles: [] });

    const a = await orch.spawnAgent(created.orchestration.id, "coder", {
      task: "Implement the parser",
      dependsOn: "agent-upstream",
    });
    expect(a.task).toBe("Implement the parser");
    expect(a.dependsOn).toBe("agent-upstream");
    expect(calls.trustCleared).toContain(a.worktreeDir);

    // Worker env carries its role (gates it OUT of spawning) + orch id.
    const call = calls.spawnCalls.find((c) => c.cwd === a.worktreeDir)!;
    expect(call.env?.HARK_ROLE).toBe("coder");
    expect(call.command).toContain("--dangerously-skip-permissions");

    // The dispatched task flows into the briefing.
    const persisted = await store.getOrchestration(created.orchestration.id);
    const briefing = orch.briefingFor(persisted!, persisted!.agents[0]);
    expect(briefing).toContain("Implement the parser");
  });
});

describe("Orchestrator.briefingFor", () => {
  it("renders the agent's role briefing with mission + isolation context", async () => {
    const { deps } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const { orchestration, agents } = await orch.createTeam({
      ...teamInput,
      roles: ["coder"],
    });
    const briefing = orch.briefingFor(orchestration, agents[0]);
    expect(briefing).toContain("**Coder**");
    expect(briefing).toContain("Add OAuth login");
    expect(briefing).toContain(agents[0].branch);
    expect(briefing).toContain("[[HARK:DONE]]");
  });
});

describe("Orchestrator.killTerminalAgent", () => {
  it("SIGTERMs a terminal worker's pid and records killedAt, keeping the worktree", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const o = await deps.store.createOrchestration({
      name: "t",
      goal: "g",
      projectRoot: "/r",
      projectName: "p",
    });
    const agent = await deps.store.addAgent(o.id, {
      role: "coder",
      branch: "b",
      worktreeDir: "/w",
      pid: 777,
      lifecycle: "done",
    });

    await orch.killTerminalAgent(o.id, agent!.id);

    expect(calls.killed).toEqual([777]);
    const after = await deps.store.getOrchestration(o.id);
    expect(typeof after!.agents[0].killedAt).toBe("number");
    // The worktree/branch survive — only the process is killed.
    expect(calls.removed).toEqual([]);
  });

  it("is idempotent — does not re-kill an already-killed worker", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const o = await deps.store.createOrchestration({
      name: "t",
      goal: "g",
      projectRoot: "/r",
      projectName: "p",
    });
    const agent = await deps.store.addAgent(o.id, {
      role: "coder",
      branch: "b",
      worktreeDir: "/w",
      pid: 777,
      lifecycle: "blocked",
    });

    await orch.killTerminalAgent(o.id, agent!.id);
    await orch.killTerminalAgent(o.id, agent!.id);

    expect(calls.killed).toEqual([777]);
  });

  it("tolerates a null pid (a failed agent that never spawned)", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const o = await deps.store.createOrchestration({
      name: "t",
      goal: "g",
      projectRoot: "/r",
      projectName: "p",
    });
    const agent = await deps.store.addAgent(o.id, {
      role: "coder",
      branch: "b",
      worktreeDir: "/w",
      pid: null,
      lifecycle: "failed",
    });

    await orch.killTerminalAgent(o.id, agent!.id);

    expect(calls.killed).toEqual([]);
    const after = await deps.store.getOrchestration(o.id);
    expect(typeof after!.agents[0].killedAt).toBe("number");
  });
});

describe("Orchestrator.stopAgent", () => {
  it("flips a running worker to stopped, SIGTERMs its pid, keeps the worktree", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const o = await deps.store.createOrchestration({
      name: "t",
      goal: "g",
      projectRoot: "/r",
      projectName: "p",
    });
    const agent = await deps.store.addAgent(o.id, {
      role: "coder",
      branch: "b",
      worktreeDir: "/w",
      pid: 777,
      lifecycle: "running",
    });

    const result = await orch.stopAgent(o.id, agent!.id);

    expect(result).toEqual({ lifecycle: "stopped", alreadyTerminal: false });
    expect(calls.killed).toEqual([777]);
    const after = await deps.store.getOrchestration(o.id);
    expect(after!.agents[0].lifecycle).toBe("stopped");
    expect(typeof after!.agents[0].killedAt).toBe("number");
    // The worktree/branch survive — stop only halts the process.
    expect(calls.removed).toEqual([]);
  });

  it("fixes a zombie: a running worker with a dead pid still flips to stopped", async () => {
    // killSession throws to simulate the pid already being gone (the live
    // researcher-0bb21b symptom: record shows `running` but the process is dead).
    const { deps } = makeDeps(store, {
      killSession: async () => {
        throw new Error("ESRCH: no such process");
      },
    });
    const orch = new Orchestrator(deps);
    const o = await deps.store.createOrchestration({
      name: "t",
      goal: "g",
      projectRoot: "/r",
      projectName: "p",
    });
    const agent = await deps.store.addAgent(o.id, {
      role: "researcher",
      branch: "b",
      worktreeDir: "/w",
      pid: 2082267,
      lifecycle: "running",
    });

    const result = await orch.stopAgent(o.id, agent!.id);

    // The dead-pid SIGTERM is swallowed; the lifecycle is still made honest.
    expect(result).toEqual({ lifecycle: "stopped", alreadyTerminal: false });
    const after = await deps.store.getOrchestration(o.id);
    expect(after!.agents[0].lifecycle).toBe("stopped");
  });

  it("is idempotent on an already-terminal worker — reports state, doesn't re-flip", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const o = await deps.store.createOrchestration({
      name: "t",
      goal: "g",
      projectRoot: "/r",
      projectName: "p",
    });
    const agent = await deps.store.addAgent(o.id, {
      role: "coder",
      branch: "b",
      worktreeDir: "/w",
      pid: 777,
      lifecycle: "done",
    });
    // First stop reaps the done worker (killTerminalAgent fires once).
    await orch.stopAgent(o.id, agent!.id);
    // Second stop must not error and must report the unchanged terminal state.
    const again = await orch.stopAgent(o.id, agent!.id);

    expect(again).toEqual({ lifecycle: "done", alreadyTerminal: true });
    // Only one SIGTERM total — killedAt makes the kill idempotent.
    expect(calls.killed).toEqual([777]);
    const after = await deps.store.getOrchestration(o.id);
    expect(after!.agents[0].lifecycle).toBe("done");
  });

  it("returns null for an unknown agent so the endpoint can 404", async () => {
    const { deps } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const o = await deps.store.createOrchestration({
      name: "t",
      goal: "g",
      projectRoot: "/r",
      projectName: "p",
    });
    expect(await orch.stopAgent(o.id, "agent-missing")).toBeNull();
  });
});

describe("Orchestrator teardown", () => {
  it("removes an agent's worktree and marks it cancelled", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const { orchestration, agents } = await orch.createTeam({
      ...teamInput,
      roles: ["coder"],
    });

    await orch.teardownAgent(orchestration.id, agents[0].id);
    expect(calls.removed).toContain(agents[0].worktreeDir);
    const persisted = await store.getOrchestration(orchestration.id);
    expect(persisted!.agents[0].lifecycle).toBe("cancelled");
  });

  it("tears down all agents and archives the orchestration", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const { orchestration, agents } = await orch.createTeam({
      ...teamInput,
      roles: ["researcher", "coder"],
    });

    await orch.teardownOrchestration(orchestration.id);
    for (const a of agents) expect(calls.removed).toContain(a.worktreeDir);
    const persisted = await store.getOrchestration(orchestration.id);
    expect(persisted!.status).toBe("archived");
  });

  it("also removes the head worktree on teardown (it's not in agents[])", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const { orchestration, head } = await orch.createWithHead({
      name: teamInput.name,
      goal: teamInput.goal,
      projectRoot: teamInput.projectRoot,
      projectName: teamInput.projectName,
      baseRef: teamInput.baseRef,
    });
    await orch.spawnAgent(orchestration.id, "coder");

    await orch.teardownOrchestration(orchestration.id);
    expect(calls.removed).toContain(head.worktreeDir);
  });

  it("kills the agent's session before removing its worktree", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const { orchestration, agents } = await orch.createTeam({
      ...teamInput,
      roles: ["coder"],
    });
    const pid = agents[0].pid!;

    await orch.teardownAgent(orchestration.id, agents[0].id);

    expect(calls.killed).toContain(pid);
    // The bug this guards: a live `claude` left running holds its worktree dir
    // as cwd and orphans. Kill must precede remove.
    const killIdx = calls.order.indexOf(`kill:${pid}`);
    const removeIdx = calls.order.indexOf(`remove:${agents[0].worktreeDir}`);
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(killIdx);
  });

  it("kills every agent and the head before removing their worktrees", async () => {
    const { deps, calls } = makeDeps(store);
    const orch = new Orchestrator(deps);
    const { orchestration, head } = await orch.createWithHead({
      name: teamInput.name,
      goal: teamInput.goal,
      projectRoot: teamInput.projectRoot,
      projectName: teamInput.projectName,
      baseRef: teamInput.baseRef,
    });
    const agent = await orch.spawnAgent(orchestration.id, "coder");

    await orch.teardownOrchestration(orchestration.id);

    expect(calls.killed).toContain(agent.pid!);
    expect(calls.killed).toContain(head.pid!);
    for (const [pid, dir] of [
      [agent.pid!, agent.worktreeDir],
      [head.pid!, head.worktreeDir],
    ] as const) {
      const killIdx = calls.order.indexOf(`kill:${pid}`);
      const removeIdx = calls.order.indexOf(`remove:${dir}`);
      expect(killIdx).toBeGreaterThanOrEqual(0);
      expect(removeIdx).toBeGreaterThan(killIdx);
    }
  });

  it("tears down even when a session pid is already gone (null/dead)", async () => {
    // A session that exited on its own has no pid; teardown must still remove
    // the worktree and archive rather than throwing.
    const { deps, calls } = makeDeps(store, {
      killSession: async () => {
        throw new Error("ESRCH: no such process");
      },
    });
    const orch = new Orchestrator(deps);
    const { orchestration, agents } = await orch.createTeam({
      ...teamInput,
      roles: ["coder"],
    });

    await expect(
      orch.teardownOrchestration(orchestration.id),
    ).resolves.toBeUndefined();
    expect(calls.removed).toContain(agents[0].worktreeDir);
    const persisted = await store.getOrchestration(orchestration.id);
    expect(persisted!.status).toBe("archived");
  });
});
