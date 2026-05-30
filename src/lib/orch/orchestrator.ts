import {
  buildAgentBriefing,
  buildHeadBriefing,
  buildPmHeadBriefing,
  type AgentRole,
} from "./roles.js";
import { newAgentId, OrchStore } from "./store.js";
import {
  currentBranch as currentBranchIO,
  worktreeBaseDir,
  worktreeBranchName,
  worktreeHeadBranch,
  worktreePath,
} from "./worktree.js";
import path from "node:path";
import { PLAN_FILENAME } from "../projectConstants.js";
import {
  emptyAgentMetrics,
  isTerminalLifecycle,
  type AgentLifecycle,
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
    // Human-facing tmux window name (e.g. "hark-coder"). Cosmetic — the
    // orchestrator still correlates sessions by pid, never by window name.
    windowName?: string;
  }) => Promise<SpawnSessionResult>;
  // Kill a spawned session's process (by its pane pid) during teardown. The
  // live `claude` TUI must be killed BEFORE its worktree is removed — otherwise
  // it orphans (keeps running, detached from any orchestration) and holds the
  // worktree dir as its cwd, which leaves the directory behind on disk. Maps
  // onto process.kill in production; a recording fake in tests.
  killSession: (pid: number) => Promise<void>;
  // The branch currently checked out in a repo — the PM-head's base when
  // promoting a session. Maps onto worktree.currentBranch in production; a
  // fake in tests. Optional: defaults to the real git reader.
  currentBranch?: (repoRoot: string) => Promise<string>;
}

// The claude invocation orchestration sessions use. Workers and the executor
// head each run in their OWN isolated git worktree (spawnAgent / spawnHead), so
// nothing they can touch is outside that sandbox — which makes
// `--dangerously-skip-permissions` the correct posture for a headless agent
// here, not a risk: there is no human at the keyboard to answer a permission
// prompt, so any prompt is a silent wedge (the session blocks forever waiting
// on input that never comes). Skipping permissions removes that whole
// prompt-wedge failure class. It is defense-in-depth, NOT a fix for the
// tool-error cancel-cascade (the worker that spiralled ran fine under
// `--permission-mode auto` for 88 calls before a benign tool error wedged it —
// see the cancel-cascade breaker trigger in controller.ts).
//
// `--disallowed-tools Task,Agent` is the second, independent layer of that
// defense-in-depth: it denies the sub-agent-spawning tools so a worker (or the
// executor head) that DOES wedge mid-run can never fan the cancel-cascade out
// into nested sub-agents — a wedged session stays a single contained failure
// instead of seeding a tree of them. Skip-perms can't gate tools (the agent
// already runs with permissions skipped), so the deny-list is the only lever
// here. Tool names are comma-separated per `claude --help`; both Task and Agent
// are listed to cover either naming of the built-in spawner (an unrecognized
// name is simply ignored).
//
// Note: the persistent PM-head is promoted from an existing session, never
// spawned here, and is held read-only on the real tree by a PreToolUse hook —
// this command does not govern it.
const CLAUDE_COMMAND =
  "claude --dangerously-skip-permissions --disallowed-tools Task,Agent";

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
        windowName: `${orch.projectName}-${role}`,
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
        windowName: `${orch.projectName}-head`,
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

  // ---- PM-head promotion (PM-Head Orchestration Harness) ------------------

  // Promote an existing session to its project's persistent PM-head. Nothing is
  // spawned — the session + working tree already exist; we record a managed
  // orchestration whose head is this session, observing the project root
  // read-only. Idempotent: a second promotion for a project that already has an
  // active managed head re-attaches (updates the head's sessionId — the session
  // may be new after a restart) instead of creating a duplicate.
  async promoteSession(input: {
    sessionId: string;
    projectRoot: string;
    projectName: string;
  }): Promise<{
    orchestration: Orchestration;
    reattached: boolean;
  }> {
    const branch = await (this.deps.currentBranch ?? currentBranchIO)(
      input.projectRoot,
    );

    const existing = await this.deps.store.findActiveManagedHead(
      input.projectRoot,
    );
    if (existing) {
      await this.deps.store.updateHead(existing.id, (h) => {
        h.sessionId = input.sessionId;
      });
      const refreshed = await this.deps.store.getOrchestration(existing.id);
      return { orchestration: refreshed ?? existing, reattached: true };
    }

    const orchestration = await this.deps.store.createManagedHead({
      name: `PM: ${input.projectName}`,
      goal: `Persistent PM-head for ${input.projectName}`,
      projectRoot: input.projectRoot,
      projectName: input.projectName,
      baseRef: branch,
      sessionId: input.sessionId,
      branch,
    });
    return { orchestration, reattached: false };
  }

  // The PM charter delivered on promotion. Returned as the `hark head init`
  // command's stdout so the promoting session reads it as a tool result and
  // adopts the role — no keystroke injection into a live conversation (honors
  // the "nothing force-types" invariant).
  pmCharterFor(orch: Orchestration): string {
    if (!orch.head) throw new Error(`orchestration has no head: ${orch.id}`);
    return buildPmHeadBriefing({
      projectName: orch.projectName,
      projectRoot: orch.projectRoot,
      branch: orch.head.branch,
      planPath: path.join(orch.projectRoot, PLAN_FILENAME),
      autonomyLevel: orch.autonomyLevel,
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

  // SIGTERM a worker's session process once its lifecycle has gone terminal
  // (done/blocked/failed). A worker left running after it finishes keeps its
  // `claude` process alive with no task and spins on echo/git-poll + idle
  // wakeups — the dominant token sink found while dogfooding (~1.3M tokens on
  // one small change). Unlike teardownAgent this KEEPS the worktree + branch
  // (the head/PM still reads the committed work); it only kills the process.
  // Reuses the same `killSession` dep as teardown (tolerant of a null/dead
  // pid). `killedAt` makes it idempotent so the 3s reconcile loop signals once,
  // not every tick.
  async killTerminalAgent(orchId: string, agentId: string): Promise<void> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch) return;
    const agent = orch.agents.find((a) => a.id === agentId);
    if (!agent || agent.killedAt != null) return;
    await this.safeKill(agent.pid);
    await this.deps.store.updateAgent(orchId, agentId, (a) => {
      a.killedAt = Date.now();
    });
    await this.deps.store.appendEvent({
      ts: Date.now(),
      orchestrationId: orchId,
      agentId,
      kind: "note",
      message: `${agent.role} process terminated (${agent.lifecycle})`,
    });
  }

  // Halt a worker from the CLI (`hark agent stop`): flip its lifecycle to the
  // terminal `stopped` state, then reuse the exact terminal-kill path
  // (killTerminalAgent → killSession) the reconcile loop uses to reap finished
  // workers — SIGTERM the process, KEEP the worktree + branch (the PM still
  // inspects the work). Idempotent and safe on a zombie:
  //  - Already-terminal worker (done/blocked/failed/stopped/cancelled): we don't
  //    re-flip the lifecycle; killTerminalAgent no-ops if it was already reaped
  //    (killedAt set), so a repeat stop just reports the current state — no error.
  //  - A worker whose pid is already dead but still shows `running` (the zombie
  //    case where status lies): we flip it to `stopped` so status stops lying;
  //    killTerminalAgent's safeKill tolerates the dead pid.
  // Returns null when the orchestration/agent doesn't exist (the caller 404s).
  async stopAgent(
    orchId: string,
    agentId: string,
  ): Promise<{ lifecycle: AgentLifecycle; alreadyTerminal: boolean } | null> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch) return null;
    const agent = orch.agents.find((a) => a.id === agentId);
    if (!agent) return null;

    const alreadyTerminal = isTerminalLifecycle(agent.lifecycle);
    if (!alreadyTerminal) {
      await this.deps.store.setAgentLifecycle(orchId, agentId, "stopped");
    }
    // killTerminalAgent reads the (now terminal) lifecycle for its event log,
    // SIGTERMs the pid, and is idempotent via killedAt.
    await this.killTerminalAgent(orchId, agentId);

    const after = await this.deps.store.getOrchestration(orchId);
    const lifecycle =
      after?.agents.find((a) => a.id === agentId)?.lifecycle ??
      agent.lifecycle;
    return { lifecycle, alreadyTerminal };
  }

  // Tear down one agent: kill its live session, remove its worktree (the branch
  // is kept by default so committed work survives the throwaway checkout), mark
  // it cancelled. Kill precedes worktree removal so the process can't orphan or
  // hold the dir busy.
  async teardownAgent(
    orchId: string,
    agentId: string,
  ): Promise<void> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch) return;
    const agent = orch.agents.find((a) => a.id === agentId);
    if (!agent) return;
    await this.safeKill(agent.pid);
    await this.safeRemoveWorktree(orch.projectRoot, agent.worktreeDir);
    await this.deps.store.setAgentLifecycle(orchId, agentId, "cancelled");
  }

  // Tear down a whole orchestration — every agent AND the head — then mark it
  // archived. For each, the live session is killed BEFORE its worktree is
  // removed (a running `claude` orphans and holds its cwd otherwise). The head
  // has its own worktree (it's not in agents[]), so it's handled explicitly.
  async teardownOrchestration(orchId: string): Promise<void> {
    const orch = await this.deps.store.getOrchestration(orchId);
    if (!orch) return;
    for (const agent of orch.agents) {
      await this.safeKill(agent.pid);
      await this.safeRemoveWorktree(orch.projectRoot, agent.worktreeDir);
    }
    if (orch.head) {
      await this.safeKill(orch.head.pid);
      await this.safeRemoveWorktree(orch.projectRoot, orch.head.worktreeDir);
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

  // Kill a session's process, swallowing errors. The pid may be null (never
  // spawned) or already dead (the session exited on its own) — neither should
  // abort teardown, which must still remove the worktree and archive the run.
  private async safeKill(pid: number | null | undefined): Promise<void> {
    if (pid == null) return;
    try {
      await this.deps.killSession(pid);
    } catch {
      /* best-effort — the process may already have exited */
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
