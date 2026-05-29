import {
  buildAgentBriefing,
  type AgentRole,
} from "./roles.js";
import { newAgentId, OrchStore } from "./store.js";
import { worktreeBaseDir, worktreeBranchName, worktreePath } from "./worktree.js";
import type { OrchAgent, Orchestration } from "../../shared/protocol.js";

// The orchestrator is the brain that wires the foundation pieces into the
// actual "spawn a team of agents" flow: it composes the store (state), the
// worktree lib (isolation), a session spawner (the existing tmux spawn path),
// and the role briefings. Every external effect is an injected dependency so
// the orchestration logic — id derivation, ordering, rollback, lifecycle and
// event bookkeeping — is unit-testable with fakes, no git/tmux required.

export interface SpawnSessionResult {
  pid: number | null;
}

export interface OrchestratorDeps {
  store: OrchStore;
  // Base dir for worktrees; defaults to worktreeBaseDir() in production.
  baseDir?: string;
  addWorktree: (opts: {
    repoRoot: string;
    worktreeDir: string;
    branch: string;
    baseRef: string;
  }) => Promise<void>;
  removeWorktree: (opts: {
    repoRoot: string;
    worktreeDir: string;
    force?: boolean;
  }) => Promise<void>;
  // Spawn a Claude Code session whose cwd is the agent's worktree. Maps onto
  // spawnClaudeSession in production; the orchestrator only needs the pid back.
  spawnSession: (opts: {
    cwd: string;
    command?: string;
  }) => Promise<SpawnSessionResult>;
}

export interface CreateTeamInput {
  name: string;
  goal: string;
  projectRoot: string;
  projectName: string;
  baseRef?: string;
  // Roles to staff the orchestration with, in spawn order. Duplicates are
  // allowed (e.g. two coders) — ids keep their worktrees/branches distinct.
  roles: AgentRole[];
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  private baseDir(): string {
    return this.deps.baseDir ?? worktreeBaseDir();
  }

  // Create one agent: derive its isolated branch + worktree dir from a
  // pre-minted id, record it, create the worktree, then spawn its session.
  // On any failure the partial state is rolled back (worktree removed if it
  // was created) and the agent is marked failed — never left half-spawned.
  async spawnAgent(orchId: string, role: AgentRole): Promise<OrchAgent> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch) throw new Error(`orchestration not found: ${orchId}`);

    const id = newAgentId();
    const branch = worktreeBranchName(orch.name, role, id.slice(-6));
    const worktreeDir = worktreePath(
      this.baseDir(),
      orch.projectName,
      orchId,
      id,
    );

    const agent = await this.deps.store.addAgent(orchId, {
      id,
      role,
      branch,
      worktreeDir,
      lifecycle: "pending",
    });
    if (!agent) throw new Error(`orchestration not found: ${orchId}`);

    // 1. Isolated worktree.
    try {
      await this.deps.addWorktree({
        repoRoot: orch.projectRoot,
        worktreeDir,
        branch,
        baseRef: orch.baseRef,
      });
    } catch (err) {
      await this.fail(orchId, id, `worktree create failed: ${err}`);
      throw err;
    }

    // 2. Session in that worktree.
    let pid: number | null = null;
    try {
      const result = await this.deps.spawnSession({ cwd: worktreeDir });
      pid = result.pid;
    } catch (err) {
      // Roll back the worktree we just made so we don't leak it.
      await this.safeRemoveWorktree(orch.projectRoot, worktreeDir);
      await this.fail(orchId, id, `session spawn failed: ${err}`);
      throw err;
    }

    await this.deps.store.updateAgent(orchId, id, (a) => {
      a.pid = pid;
    });
    const spawned = await this.deps.store.setAgentLifecycle(
      orchId,
      id,
      "spawning",
    );
    return spawned ?? agent;
  }

  // Create an orchestration and staff it. Agents are spawned sequentially:
  // `git worktree add` takes the repo's index.lock, so parallel adds on one
  // repo would contend. The orchestration is returned with all agents recorded.
  async createTeam(
    input: CreateTeamInput,
  ): Promise<{ orchestration: Orchestration; agents: OrchAgent[] }> {
    const orchestration = await this.deps.store.createOrchestration({
      name: input.name,
      goal: input.goal,
      projectRoot: input.projectRoot,
      projectName: input.projectName,
      baseRef: input.baseRef,
    });

    const agents: OrchAgent[] = [];
    for (const role of input.roles) {
      // One agent failing shouldn't abort the whole team; record it and move
      // on so the user gets a partially-staffed orchestration plus the error
      // trail in events.jsonl rather than nothing.
      try {
        agents.push(await this.spawnAgent(orchestration.id, role));
      } catch {
        /* failure already recorded by spawnAgent */
      }
    }

    const refreshed = await this.deps.store.getOrchestration(orchestration.id);
    return { orchestration: refreshed ?? orchestration, agents };
  }

  // The role briefing for an agent — the first message a human (or the
  // autonomy controller) delivers to the agent's session via the tmux send
  // path. Pure/derivable, so it can be regenerated at any time. Kept here so
  // delivery timing (waiting for the session past its trust prompt) stays a
  // separate concern owned by the controller.
  briefingFor(
    orch: Orchestration,
    agent: OrchAgent,
    upstream?: string,
  ): string {
    return buildAgentBriefing({
      role: agent.role,
      orchestrationName: orch.name,
      goal: orch.goal,
      branch: agent.branch,
      worktreeDir: agent.worktreeDir,
      upstream,
    });
  }

  // Tear down one agent: remove its worktree (and optionally delete its
  // branch), mark it cancelled. The branch is kept by default so committed
  // work survives the throwaway checkout.
  async teardownAgent(
    orchId: string,
    agentId: string,
  ): Promise<void> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch) return;
    const agent = orch.agents.find((a) => a.id === agentId);
    if (!agent) return;
    await this.safeRemoveWorktree(orch.projectRoot, agent.worktreeDir);
    await this.deps.store.setAgentLifecycle(orchId, agentId, "cancelled");
  }

  // Tear down a whole orchestration's agents and mark it archived.
  async teardownOrchestration(orchId: string): Promise<void> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch) return;
    for (const agent of orch.agents) {
      await this.safeRemoveWorktree(orch.projectRoot, agent.worktreeDir);
    }
    await this.deps.store.setStatus(orchId, "archived");
  }

  private async safeRemoveWorktree(
    repoRoot: string,
    worktreeDir: string,
  ): Promise<void> {
    try {
      await this.deps.removeWorktree({ repoRoot, worktreeDir, force: true });
    } catch {
      /* best-effort cleanup — a leaked worktree is recoverable via prune */
    }
  }

  private async fail(
    orchId: string,
    agentId: string,
    reason: string,
  ): Promise<void> {
    await this.deps.store.setAgentLifecycle(orchId, agentId, "failed", {
      reason,
    });
    await this.deps.store.appendEvent({
      ts: Date.now(),
      orchestrationId: orchId,
      agentId,
      kind: "failure",
      message: reason,
    });
  }
}
