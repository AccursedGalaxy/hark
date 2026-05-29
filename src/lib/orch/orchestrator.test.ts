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
    },
    clearTrust: async (dir) => {
      calls.trustCleared.push(dir);
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

    // Spawned with the head env + auto permission mode + hark on PATH.
    const call = calls.spawnCalls.find((c) => c.cwd === head.worktreeDir)!;
    expect(call.command).toContain("--permission-mode auto");
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
    expect(call.command).toContain("--permission-mode auto");

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
});
