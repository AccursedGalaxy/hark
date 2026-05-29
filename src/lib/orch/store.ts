import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_AUTONOMY_LEVEL,
  emptyAgentMetrics,
  type AgentLifecycle,
  type AgentRole,
  type AutonomyLevel,
  type OrchAgent,
  type OrchEvent,
  type Orchestration,
  type OrchestrationStatus,
  type OrchHead,
} from "../../shared/protocol.js";

// File-backed persistence for orchestrations. Mirrors hark's "everything is a
// file, no database" philosophy: each orchestration is a directory under
// ~/.hark/orchestrations/<id>/ holding its record (orchestration.json) and an
// append-only event log (events.jsonl). The log is the audit trail the brief
// asks for — decisions, checkpoints, blocks, failures, metric snapshots, in
// order, never rewritten.

export function defaultOrchDir(): string {
  return (
    process.env.HARK_ORCH_DIR ||
    path.join(os.homedir(), ".hark", "orchestrations")
  );
}

const RECORD_FILE = "orchestration.json";
const EVENTS_FILE = "events.jsonl";

// Short, time-sortable, collision-resistant id. Lexicographically increasing
// (base36 ms timestamp) so a plain readdir sorts oldest→newest, with random
// suffix to disambiguate ids minted in the same millisecond.
function genId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = randomBytes(3).toString("hex");
  return `${prefix}-${t}-${r}`;
}

// Mint an agent id without inserting it — lets a caller compute the agent's
// worktree path + branch (both keyed on the id) before adding the record.
export function newAgentId(): string {
  return genId("agent");
}

export interface CreateOrchestrationInput {
  name: string;
  goal: string;
  projectRoot: string;
  projectName: string;
  baseRef?: string;
}

export interface CreateAgentInput {
  // Optional pre-minted id (see newAgentId) so the caller can derive the
  // worktree path/branch from it before the record exists. Generated if absent.
  id?: string;
  role: AgentRole;
  branch: string;
  worktreeDir: string;
  pid?: number | null;
  sessionId?: string | null;
  lifecycle?: AgentLifecycle;
}

export class OrchStore {
  private readonly rootDir: string;
  // Per-orchestration write lock so concurrent read-modify-write cycles on the
  // same record can't clobber each other. Keyed by id; same chaining pattern
  // as the tmux pane lock.
  private readonly locks = new Map<string, Promise<void>>();

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? defaultOrchDir();
  }

  private dir(id: string): string {
    return path.join(this.rootDir, id);
  }
  private recordPath(id: string): string {
    return path.join(this.dir(id), RECORD_FILE);
  }
  private eventsPath(id: string): string {
    return path.join(this.dir(id), EVENTS_FILE);
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((res) => (release = res));
    const tail = prior.then(() => mine);
    this.locks.set(id, tail);
    try {
      await prior;
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  // Atomic JSON write: temp file in the same dir + rename, so a reader never
  // observes a half-written record even if the process dies mid-write.
  private async writeRecord(o: Orchestration): Promise<void> {
    const dir = this.dir(o.id);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${RECORD_FILE}.${randomBytes(4).toString("hex")}`);
    await fs.writeFile(tmp, JSON.stringify(o, null, 2), "utf8");
    await fs.rename(tmp, this.recordPath(o.id));
  }

  async createOrchestration(
    input: CreateOrchestrationInput,
  ): Promise<Orchestration> {
    const now = Date.now();
    const o: Orchestration = {
      id: genId("orch"),
      name: input.name,
      goal: input.goal,
      projectRoot: input.projectRoot,
      projectName: input.projectName,
      baseRef: input.baseRef ?? "HEAD",
      status: "active",
      createdAt: now,
      updatedAt: now,
      agents: [],
    };
    await this.writeRecord(o);
    await this.appendEvent({
      ts: now,
      orchestrationId: o.id,
      kind: "orchestration_created",
      message: `Orchestration "${o.name}" created for ${o.projectName}`,
      data: { goal: o.goal, baseRef: o.baseRef },
    });
    return o;
  }

  // Create a persistent, project-scoped PM-head by promoting an existing
  // session (PM-Head Orchestration Harness). Unlike createOrchestration +
  // spawnHead, nothing is spawned: the session and the working tree already
  // exist. The head's worktreeDir IS the project root (the PM observes the
  // user's live tree read-only), and its sessionId is known up front (the
  // promoting session). `managed: true` is what scopes pure-PM enforcement +
  // the autonomy dial to this record.
  async createManagedHead(input: {
    name: string;
    goal: string;
    projectRoot: string;
    projectName: string;
    baseRef: string;
    sessionId: string;
    branch: string;
    autonomyLevel?: AutonomyLevel;
  }): Promise<Orchestration> {
    const now = Date.now();
    const head: OrchHead = {
      sessionId: input.sessionId,
      pid: null,
      worktreeDir: input.projectRoot,
      branch: input.branch,
      // The PM charter is delivered as the `hark head init` stdout (read as a
      // tool result), never typed in — so the head is "briefed" from the start.
      // This also keeps the executor briefing-delivery flow from firing on it.
      briefedAt: now,
      metrics: emptyAgentMetrics(),
    };
    const o: Orchestration = {
      id: genId("orch"),
      name: input.name,
      goal: input.goal,
      projectRoot: input.projectRoot,
      projectName: input.projectName,
      baseRef: input.baseRef,
      status: "active",
      createdAt: now,
      updatedAt: now,
      agents: [],
      head,
      managed: true,
      autonomyLevel: input.autonomyLevel ?? DEFAULT_AUTONOMY_LEVEL,
      // Start the newsroom cursor at promotion time so the first head turn
      // isn't flooded with any pre-promotion orchestration history.
      newsCursor: now,
      // Just promoted = in active conversation; the idle loop only kicks in
      // after the human has been quiet past the idle threshold.
      lastHumanAt: now,
    };
    await this.writeRecord(o);
    await this.appendEvent({
      ts: now,
      orchestrationId: o.id,
      kind: "orchestration_created",
      message: `PM-head promoted for ${o.projectName}`,
      data: { goal: o.goal, baseRef: o.baseRef, managed: true },
    });
    await this.appendEvent({
      ts: now,
      orchestrationId: o.id,
      kind: "head_spawned",
      message: `PM-head attached (session ${input.sessionId}) on ${input.branch}`,
      data: { worktreeDir: head.worktreeDir, branch: head.branch, promoted: true },
    });
    return o;
  }

  // The active, managed PM-head for a project root, if one exists. Newest-first
  // (listOrchestrations sorts that way) so a re-promotion attaches to the most
  // recent. Used for idempotent promotion + the CLI's env-fallback resolution.
  async findActiveManagedHead(
    projectRoot: string,
  ): Promise<Orchestration | null> {
    for (const o of await this.listOrchestrations()) {
      if (o.status === "active" && o.managed && o.projectRoot === projectRoot) {
        return o;
      }
    }
    return null;
  }

  // All active orchestrations for a project root — the span of the newsroom
  // (spec §8.2: all the project's live orchestrations), newest-first.
  async listActiveByProject(
    projectRoot: string,
  ): Promise<Orchestration[]> {
    const all = await this.listOrchestrations();
    return all.filter(
      (o) => o.status === "active" && o.projectRoot === projectRoot,
    );
  }

  // Advance the managed head's newsroom high-water cursor.
  async setNewsCursor(id: string, cursor: number): Promise<void> {
    await this.updateOrchestration(
      id,
      (o) => {
        o.newsCursor = cursor;
      },
      false, // a cursor bump isn't a meaningful "update" — don't touch updatedAt
    );
  }

  // Set the per-project autonomy dial on a managed head.
  async setAutonomyLevel(
    id: string,
    level: AutonomyLevel,
  ): Promise<Orchestration | null> {
    const updated = await this.updateOrchestration(id, (o) => {
      o.autonomyLevel = level;
    });
    if (updated) {
      await this.appendEvent({
        ts: Date.now(),
        orchestrationId: id,
        kind: "note",
        message: `autonomy level → ${level}`,
        data: { autonomyLevel: level },
      });
    }
    return updated;
  }

  async getOrchestration(id: string): Promise<Orchestration | null> {
    try {
      const raw = await fs.readFile(this.recordPath(id), "utf8");
      return JSON.parse(raw) as Orchestration;
    } catch {
      return null;
    }
  }

  async listOrchestrations(): Promise<Orchestration[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch {
      return [];
    }
    const out: Orchestration[] = [];
    await Promise.all(
      entries.map(async (id) => {
        const o = await this.getOrchestration(id);
        if (o) out.push(o);
      }),
    );
    // Newest first.
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  // Read-modify-write under the per-id lock. Returns the updated record, or
  // null if the orchestration doesn't exist. `bumpUpdatedAt` defaults true.
  async updateOrchestration(
    id: string,
    mutate: (o: Orchestration) => void,
    bumpUpdatedAt = true,
  ): Promise<Orchestration | null> {
    return this.withLock(id, async () => {
      const o = await this.getOrchestration(id);
      if (!o) return null;
      mutate(o);
      if (bumpUpdatedAt) o.updatedAt = Date.now();
      await this.writeRecord(o);
      return o;
    });
  }

  async setStatus(
    id: string,
    status: OrchestrationStatus,
  ): Promise<Orchestration | null> {
    const updated = await this.updateOrchestration(id, (o) => {
      o.status = status;
    });
    if (updated) {
      await this.appendEvent({
        ts: Date.now(),
        orchestrationId: id,
        kind: "orchestration_status",
        message: `Orchestration status → ${status}`,
        data: { status },
      });
    }
    return updated;
  }

  async addAgent(
    orchId: string,
    input: CreateAgentInput,
  ): Promise<OrchAgent | null> {
    const now = Date.now();
    const agent: OrchAgent = {
      id: input.id ?? genId("agent"),
      orchestrationId: orchId,
      role: input.role,
      branch: input.branch,
      worktreeDir: input.worktreeDir,
      sessionId: input.sessionId ?? null,
      pid: input.pid ?? null,
      lifecycle: input.lifecycle ?? "pending",
      createdAt: now,
      updatedAt: now,
      metrics: emptyAgentMetrics(),
    };
    const updated = await this.updateOrchestration(orchId, (o) => {
      o.agents.push(agent);
    });
    if (!updated) return null;
    await this.appendEvent({
      ts: now,
      orchestrationId: orchId,
      agentId: agent.id,
      kind: "agent_spawned",
      message: `${agent.role} agent created on ${agent.branch}`,
      data: { worktreeDir: agent.worktreeDir },
    });
    return agent;
  }

  async updateAgent(
    orchId: string,
    agentId: string,
    mutate: (a: OrchAgent) => void,
  ): Promise<OrchAgent | null> {
    let result: OrchAgent | null = null;
    await this.updateOrchestration(orchId, (o) => {
      const a = o.agents.find((x) => x.id === agentId);
      if (!a) return;
      mutate(a);
      a.updatedAt = Date.now();
      result = a;
    });
    return result;
  }

  // Convenience for the most common agent mutation — a lifecycle transition,
  // logged to the event stream so the timeline is complete.
  async setAgentLifecycle(
    orchId: string,
    agentId: string,
    lifecycle: AgentLifecycle,
    opts: { reason?: string } = {},
  ): Promise<OrchAgent | null> {
    const a = await this.updateAgent(orchId, agentId, (agent) => {
      agent.lifecycle = lifecycle;
      if (lifecycle === "blocked") agent.blockedReason = opts.reason;
      else delete agent.blockedReason;
    });
    if (a) {
      await this.appendEvent({
        ts: Date.now(),
        orchestrationId: orchId,
        agentId,
        kind: "agent_lifecycle",
        message: `${a.role} → ${lifecycle}${opts.reason ? `: ${opts.reason}` : ""}`,
        // Structured so the newsroom projection can filter to head-relevant
        // transitions (done/blocked/review/failed) without parsing the message.
        data: { lifecycle, role: a.role, branch: a.branch, reason: opts.reason },
      });
    }
    return a;
  }

  // ---- Head (head-session model) ------------------------------------------

  // Record the coordinating head on an orchestration. The head lives on the
  // record directly (not in agents[]) so it's exempt from the worker nudge
  // loop and its markers are orchestration-scoped. Logs head_spawned.
  async setHead(
    orchId: string,
    head: Omit<OrchHead, "metrics"> & { metrics?: OrchHead["metrics"] },
  ): Promise<Orchestration | null> {
    const full: OrchHead = { ...head, metrics: head.metrics ?? emptyAgentMetrics() };
    const updated = await this.updateOrchestration(orchId, (o) => {
      o.head = full;
    });
    if (updated) {
      await this.appendEvent({
        ts: Date.now(),
        orchestrationId: orchId,
        kind: "head_spawned",
        message: `head session spawned on ${full.branch}`,
        data: { worktreeDir: full.worktreeDir, branch: full.branch },
      });
    }
    return updated;
  }

  // Read-modify-write the head under the per-id lock. Returns the updated head,
  // or null if the orchestration has no head. Mirrors updateAgent.
  async updateHead(
    orchId: string,
    mutate: (h: OrchHead) => void,
  ): Promise<OrchHead | null> {
    let result: OrchHead | null = null;
    await this.updateOrchestration(orchId, (o) => {
      if (!o.head) return;
      mutate(o.head);
      result = o.head;
    });
    return result;
  }

  // Append one event to the orchestration's JSONL log. O_APPEND keeps
  // concurrent appends from interleaving mid-line (kernel-atomic for the small
  // single-line writes we do here), matching projectCapture's approach.
  async appendEvent(event: OrchEvent): Promise<void> {
    const dir = this.dir(event.orchestrationId);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(
      this.eventsPath(event.orchestrationId),
      JSON.stringify(event) + "\n",
      "utf8",
    );
  }

  async readEvents(orchId: string): Promise<OrchEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.eventsPath(orchId), "utf8");
    } catch {
      return [];
    }
    const out: OrchEvent[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as OrchEvent);
      } catch {
        /* skip a corrupt line rather than failing the whole read */
      }
    }
    return out;
  }
}
