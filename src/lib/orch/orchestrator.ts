import {
  buildAgentBriefing,
  buildHeadBriefing,
  type AgentRole,
} from "./roles.js";
import { newAgentId, OrchStore } from "./store.js";
import {
  worktreeBaseDir,
  worktreeBranchName,
  worktreeHeadBranch,
  worktreePath,
} from "./worktree.js";
import {
  emptyAgentMetrics,
  type OrchAgent,
  type OrchHead,
  type Orchestration,
} from "../../shared/protocol.js";

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
  // Base URL of the hark API the spawned `hark` CLI targets (HARK_API). When
  // unset, HARK_API is omitted from the session env.
  apiBase?: string;
  // Directory holding the `hark` CLI; prepended to the spawned session's PATH
  // so the head/workers can invoke it. When unset, PATH is left untouched.
  cliBinDir?: string;
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
  // Pre-clear the folder-trust dialog for a worktree dir (Gate 1) before its
  // session spawns, so the dialog never fires unattended. Maps onto clearTrust
  // in production; a no-op fake in tests.
  clearTrust: (dir: string) => Promise<void>;
  // Spawn a Claude Code session whose cwd is the agent's worktree. Maps onto
  // spawnClaudeSession in production; the orchestrator only needs the pid back.
  spawnSession: (opts: {
    cwd: string;
    command?: string;
    env?: Record<string, string>;
    pathPrepend?: string;
  }) => Promise<SpawnSessionResult>;
}

// The claude invocation orchestration sessions use. `--permission-mode auto`
// is the default tool-permission posture (Gate 2): a safety classifier
// auto-approves safe calls and escalates genuinely risky ones via the
// marker→notify path, instead of either silent auto-run or a dead stall.
const CLAUDE_COMMAND = "claude --permission-mode auto";

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

  // The env a spawned orchestration session gets so the `hark` CLI auto-targets
  // this run. HARK_ROLE gates spawning to the head (workers carry their role).
  private sessionEnv(orchId: string, role: string): Record<string, string> {
    const env: Record<string, string> = {
      HARK_ORCH_ID: orchId,
      HARK_ROLE: role,
    };
    if (this.deps.apiBase) env.HARK_API = this.deps.apiBase;
    return env;
  }

  // Create one agent: derive its isolated branch + worktree dir from a
  // pre-minted id, record it, create the worktree, then spawn its session.
  // On any failure the partial state is rolled back (worktree removed if it
  // was created) and the agent is marked failed — never left half-spawned.
  async spawnAgent(
    orchId: string,
    role: AgentRole,
    opts: { task?: string; dependsOn?: string } = {},
  ): Promise<OrchAgent> {
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

    // Record the dispatched task / dependency up front so the briefing (which
    // reads them off the agent) reflects what the head asked for.
    if (opts.task != null || opts.dependsOn != null) {
      await this.deps.store.updateAgent(orchId, id, (a) => {
        if (opts.task != null) a.task = opts.task;
        if (opts.dependsOn != null) a.dependsOn = opts.dependsOn;
      });
    }

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

    // 2. Clear the folder-trust dialog for this worktree before spawning so it
    //    never fires unattended (Gate 1). Best-effort: a trust failure
    //    shouldn't abort the spawn (the host may already trust it / use auto).
    await this.safeClearTrust(worktreeDir);

    // 3. Session in that worktree.
    let pid: number | null = null;
    try {
      const result = await this.deps.spawnSession({
        cwd: worktreeDir,
        command: CLAUDE_COMMAND,
        env: this.sessionEnv(orchId, role),
        pathPrepend: this.deps.cliBinDir,
      });
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

  // Spawn the coordinating head session for an orchestration: its own isolated
  // worktree (clean tree for git/gh), trust pre-cleared, launched with the head
  // env + auto permission mode. Recorded on Orchestration.head, never agents[].
  async spawnHead(orchId: string): Promise<OrchHead> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch) throw new Error(`orchestration not found: ${orchId}`);

    const branch = worktreeHeadBranch(orch.name);
    const worktreeDir = worktreePath(
      this.baseDir(),
      orch.projectName,
      orchId,
      "head",
    );

    // 1. Isolated head worktree.
    await this.deps.addWorktree({
      repoRoot: orch.projectRoot,
      worktreeDir,
      branch,
      baseRef: orch.baseRef,
    });

    // 2. Clear trust before spawn (Gate 1).
    await this.safeClearTrust(worktreeDir);

    // 3. Head session.
    let pid: number | null = null;
    try {
      const result = await this.deps.spawnSession({
        cwd: worktreeDir,
        command: CLAUDE_COMMAND,
        env: this.sessionEnv(orchId, "head"),
        pathPrepend: this.deps.cliBinDir,
      });
      pid = result.pid;
    } catch (err) {
      await this.safeRemoveWorktree(orch.projectRoot, worktreeDir);
      throw err;
    }

    const updated = await this.deps.store.setHead(orchId, {
      sessionId: null,
      pid,
      worktreeDir,
      branch,
    });
    return (
      updated?.head ?? {
        sessionId: null,
        pid,
        worktreeDir,
        branch,
        metrics: emptyAgentMetrics(),
      }
    );
  }

  // The entry path for the head-session model: create the orchestration record
  // (no fixed team) and spawn its head. The head then drives worker spawning on
  // demand. Distinct from the legacy createTeam (kept for back-compat).
  async createWithHead(
    input: Omit<CreateTeamInput, "roles">,
  ): Promise<{ orchestration: Orchestration; head: OrchHead }> {
    const orchestration = await this.deps.store.createOrchestration({
      name: input.name,
      goal: input.goal,
      projectRoot: input.projectRoot,
      projectName: input.projectName,
      baseRef: input.baseRef,
    });
    const head = await this.spawnHead(orchestration.id);
    const refreshed = await this.deps.store.getOrchestration(orchestration.id);
    return { orchestration: refreshed ?? orchestration, head };
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
      task: agent.task,
      upstream,
    });
  }

  // The head briefing — the bootstrap message delivered to the head session.
  headBriefingFor(orch: Orchestration): string {
    if (!orch.head) throw new Error(`orchestration has no head: ${orch.id}`);
    return buildHeadBriefing({
      orchestrationName: orch.name,
      goal: orch.goal,
      branch: orch.head.branch,
      worktreeDir: orch.head.worktreeDir,
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

  // Clear the folder-trust dialog for a worktree, swallowing errors. Trust
  // clearing is a convenience (the dialog otherwise blocks the session); if it
  // fails the session still spawns and the user can clear the dialog manually,
  // so a failure must not abort the spawn.
  private async safeClearTrust(worktreeDir: string): Promise<void> {
    try {
      await this.deps.clearTrust(worktreeDir);
    } catch {
      /* best-effort — session still spawns; user clears the dialog if needed */
    }
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
