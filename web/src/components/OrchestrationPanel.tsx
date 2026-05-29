import { useState } from "react";
import {
  type AgentLifecycle,
  type OrchAgent,
  type OrchHead,
  type ProjectInfo,
} from "../lib/protocol";
import {
  briefAgent,
  createOrchestration,
  respawnHead,
  teardownOrchestration,
} from "../lib/transport";
import type { OrchestrationsApi } from "../hooks/useOrchestrations";
import { tildeify } from "../lib/format";

// Maps an agent's lifecycle onto the existing status-dot palette + a label.
const LIFECYCLE_STYLE: Record<AgentLifecycle, { dot: string; label: string }> = {
  pending: { dot: "idle", label: "PENDING" },
  spawning: { dot: "idle", label: "SPAWNING" },
  running: { dot: "live", label: "RUNNING" },
  blocked: { dot: "waiting", label: "BLOCKED" },
  review: { dot: "waiting", label: "REVIEW" },
  done: { dot: "live", label: "DONE" },
  failed: { dot: "error", label: "FAILED" },
  stopped: { dot: "error", label: "STOPPED" },
  cancelled: { dot: "error", label: "CANCELLED" },
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function OrchestrationPanel({
  api,
  projects,
  onOpenSession,
  onBack,
}: {
  api: OrchestrationsApi;
  projects: ProjectInfo[];
  onOpenSession: (sessionId: string) => void;
  onBack?: () => void;
}) {
  const { orchestrations, selected, setSelected, detail, refresh } = api;

  if (selected && detail && detail.orchestration.id === selected) {
    return (
      <OrchestrationDetailView
        detail={detail}
        onBack={() => setSelected(null)}
        onOpenSession={onOpenSession}
        onChanged={refresh}
      />
    );
  }

  if (selected) {
    return (
      <>
        <PanelHeader title="Orchestration" onBack={() => setSelected(null)} />
        <div className="plan-pane">
          <div className="plan-status">Loading…</div>
        </div>
      </>
    );
  }

  return (
    <OrchestrationListView
      orchestrations={orchestrations}
      projects={projects}
      onSelect={setSelected}
      onCreated={refresh}
      onBack={onBack}
    />
  );
}

function PanelHeader({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <header className="topbar" data-screen-label="OrchTopBar">
      {onBack && (
        <button
          type="button"
          className="back-btn"
          onClick={onBack}
          aria-label="Back"
        >
          ←
        </button>
      )}
      <div className="crumbs">
        <span className="here">{title}</span>
        {subtitle && (
          <span className="branch" style={{ marginLeft: 8 }}>
            {subtitle}
          </span>
        )}
      </div>
      <div className="spacer" />
      {right}
    </header>
  );
}

function OrchestrationListView({
  orchestrations,
  projects,
  onSelect,
  onCreated,
  onBack,
}: {
  orchestrations: OrchestrationsApi["orchestrations"];
  projects: ProjectInfo[];
  onSelect: (id: string) => void;
  onCreated: () => void;
  onBack?: () => void;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PanelHeader
        title="Orchestrations"
        subtitle={`${orchestrations.length} active`}
        onBack={onBack}
        right={
          <button
            type="button"
            className="btn primary"
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? "Cancel" : "New orchestration"}
          </button>
        }
      />
      <div className="plan-pane" data-screen-label="OrchListPane">
        {creating && (
          <CreateForm
            projects={projects}
            onCreated={() => {
              setCreating(false);
              onCreated();
            }}
          />
        )}

        {orchestrations.length === 0 && !creating ? (
          <div className="orch-empty">
            <h2>No orchestrations yet</h2>
            <p>
              An orchestration spins up a <strong>head</strong> Claude session
              that decomposes your goal and spawns worker agents on demand —
              each in its own isolated git worktree. You talk to the head in
              natural language. Create one to get started.
            </p>
          </div>
        ) : (
          <div className="orch-list">
            {orchestrations.map((o) => {
              const s = o.summary;
              return (
                <div
                  key={o.id}
                  className="orch-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(o.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(o.id);
                    }
                  }}
                >
                  <div className="orch-card-top">
                    <span className="orch-card-name">{o.name}</span>
                    {o.managed && (
                      <span className="tag accent" title="Persistent PM-head">
                        PM{o.autonomyLevel ? ` · ${o.autonomyLevel}` : ""}
                      </span>
                    )}
                    <span className={"tag " + statusTagClass(o.status)}>
                      {o.status}
                    </span>
                  </div>
                  <div className="orch-card-goal">{o.goal}</div>
                  <div className="orch-card-meta">
                    <span className="tag">{o.projectName}</span>
                    <span className="tag">{s.agentCount} agents</span>
                    {s.successRate != null && (
                      <span className="tag">
                        {Math.round(s.successRate * 100)}% success
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", color: "var(--fg-3)" }}>
                      {fmtTokens(s.totalTokens)} tok
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function statusTagClass(status: string): string {
  if (status === "active") return "accent";
  if (status === "failed") return "ro";
  return "";
}

function CreateForm({
  projects,
  onCreated,
}: {
  projects: ProjectInfo[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [projectKey, setProjectKey] = useState(projects[0]?.key ?? "");
  const [baseRef, setBaseRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim() && goal.trim() && projectKey && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await createOrchestration({
        name: name.trim(),
        goal: goal.trim(),
        projectKey,
        baseRef: baseRef.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="orch-form">
      {projects.length === 0 ? (
        <div className="plan-error">
          No known projects yet. Open a Claude session in a git repo first —
          hark only orchestrates projects it has seen a live session in.
        </div>
      ) : (
        <>
          <label className="orch-field">
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ship OAuth login"
            />
          </label>
          <label className="orch-field">
            <span>Goal</span>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder="What should this team accomplish?"
            />
          </label>
          <label className="orch-field">
            <span>Project</span>
            <select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} ({tildeify(p.root)})
                </option>
              ))}
            </select>
          </label>
          <label className="orch-field">
            <span>Base ref (optional)</span>
            <input
              value={baseRef}
              onChange={(e) => setBaseRef(e.target.value)}
              placeholder="HEAD"
            />
          </label>
          <p className="orch-form-hint">
            hark spawns a <strong>head</strong> session that decomposes the goal
            and spawns worker agents on demand — no roster to pick.
          </p>
          {error && <div className="plan-error">{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn primary"
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {busy ? "Spawning head…" : "Create & spawn head"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function OrchestrationDetailView({
  detail,
  onBack,
  onOpenSession,
  onChanged,
}: {
  detail: NonNullable<OrchestrationsApi["detail"]>;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
  onChanged: () => void;
}) {
  const { orchestration: o, summary: s, events } = detail;
  const [busy, setBusy] = useState(false);

  const teardown = async () => {
    if (
      !window.confirm(
        `Tear down "${o.name}"? This removes every agent's worktree (branches are kept) and archives the orchestration.`,
      )
    )
      return;
    setBusy(true);
    try {
      await teardownOrchestration(o.id);
      onChanged();
      onBack();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "teardown failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PanelHeader
        title={o.name}
        subtitle={o.projectName}
        onBack={onBack}
        right={
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void teardown()}
          >
            Tear down
          </button>
        }
      />
      <div className="plan-pane" data-screen-label="OrchDetailPane">
        <div className="orch-goal">{o.goal}</div>

        {o.managed && (
          <div className="orch-card-meta" style={{ marginBottom: "0.5rem" }}>
            <span className="tag accent" title="Persistent, project-scoped PM-head (read-only on the tree)">
              PM-head
            </span>
            {o.autonomyLevel && (
              <span className="tag" title="Per-project autonomy dial (idle loop)">
                autonomy {o.autonomyLevel}
              </span>
            )}
          </div>
        )}

        <div className="orch-metrics">
          <Metric label="agents" value={`${s.agentCount}`} />
          <Metric
            label="success"
            value={s.successRate == null ? "—" : `${Math.round(s.successRate * 100)}%`}
          />
          <Metric label="tokens" value={fmtTokens(s.totalTokens)} />
          <Metric label="turns" value={`${s.totalTurns}`} />
          <Metric label="autonomy" value={fmtDuration(s.totalAutonomyMs)} />
          <Metric label="interventions" value={`${s.totalInterventions}`} />
        </div>

        <div className="section-label">
          <span>Head</span>
        </div>
        <HeadCard
          orchId={o.id}
          head={o.head}
          onOpenSession={onOpenSession}
          onChanged={onChanged}
        />

        <div className="section-label">
          <span>Workers</span>
          <span className="count">{o.agents.length}</span>
        </div>
        <div className="orch-agents">
          {o.agents.length === 0 && (
            <div className="orch-empty-inline">
              No workers yet — the head spawns them on demand as it decomposes
              the goal.
            </div>
          )}
          {o.agents.map((a) => (
            <AgentCard
              key={a.id}
              orchId={o.id}
              agent={a}
              onOpenSession={onOpenSession}
              onChanged={onChanged}
            />
          ))}
        </div>

        <div className="section-label">
          <span>Activity</span>
          <span className="count">{events.length}</span>
        </div>
        <div className="orch-events">
          {[...events].reverse().slice(0, 40).map((e, i) => (
            <div key={i} className="orch-event">
              <span className="orch-event-kind">{e.kind}</span>
              <span className="orch-event-msg">{e.message}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="orch-metric">
      <div className="orch-metric-value">{value}</div>
      <div className="orch-metric-label">{label}</div>
    </div>
  );
}

// The coordinating head, surfaced prominently — it's the session the user
// mainly talks to. Observability + an "Open head" affordance; respawn if it
// died or a legacy headless record has none.
function HeadCard({
  orchId,
  head,
  onOpenSession,
  onChanged,
}: {
  orchId: string;
  head: OrchHead | undefined;
  onOpenSession: (sessionId: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const respawn = async () => {
    setBusy(true);
    try {
      await respawnHead(orchId);
      onChanged();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "spawn head failed");
    } finally {
      setBusy(false);
    }
  };

  if (!head) {
    return (
      <div className="orch-agent orch-head">
        <div className="orch-agent-top">
          <span className="orch-agent-role">head</span>
          <span className="session-status">
            <span className="dot idle" />
            NONE
          </span>
        </div>
        <div className="orch-agent-blocked">
          This orchestration has no head (legacy headless record).
        </div>
        <div className="orch-agent-meta">
          <button
            type="button"
            className="btn-sm"
            disabled={busy}
            onClick={() => void respawn()}
          >
            Spawn head
          </button>
        </div>
      </div>
    );
  }

  const dot = head.sessionId ? "live" : "idle";
  const label = head.sessionId
    ? head.briefedAt != null
      ? "BRIEFED"
      : "STARTING"
    : "SPAWNING";

  return (
    <div className="orch-agent orch-head">
      <div className="orch-agent-top">
        <span className="orch-agent-role">head</span>
        <span className="session-status">
          <span className={"dot " + dot} />
          {label}
        </span>
      </div>
      <div className="orch-agent-branch">{head.branch}</div>
      <div className="orch-agent-meta">
        <span className="tag">
          {fmtTokens(head.metrics.inputTokens + head.metrics.outputTokens)} tok
        </span>
        <span className="tag">{head.metrics.turns} turns</span>
        {head.sessionId && (
          <button
            type="button"
            className="btn-sm"
            onClick={() => onOpenSession(head.sessionId!)}
          >
            Open head
          </button>
        )}
        {!head.sessionId && (
          <button
            type="button"
            className="btn-sm"
            disabled={busy}
            onClick={() => void respawn()}
          >
            Respawn
          </button>
        )}
      </div>
    </div>
  );
}

function AgentCard({
  orchId,
  agent,
  onOpenSession,
  onChanged,
}: {
  orchId: string;
  agent: OrchAgent;
  onOpenSession: (sessionId: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const style = LIFECYCLE_STYLE[agent.lifecycle] ?? LIFECYCLE_STYLE.pending;

  const brief = async () => {
    setBusy(true);
    try {
      await briefAgent(orchId, agent.id);
      onChanged();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "brief failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="orch-agent">
      <div className="orch-agent-top">
        <span className="orch-agent-role">{agent.role}</span>
        <span className="session-status">
          <span className={"dot " + style.dot} />
          {style.label}
        </span>
      </div>
      <div className="orch-agent-branch">{agent.branch}</div>
      {agent.blockedReason && (
        <div className="orch-agent-blocked">⚠ {agent.blockedReason}</div>
      )}
      <div className="orch-agent-meta">
        <span className="tag">{fmtTokens(agent.metrics.inputTokens + agent.metrics.outputTokens)} tok</span>
        <span className="tag">{agent.metrics.turns} turns</span>
        {agent.briefedAt == null && agent.sessionId && (
          <button
            type="button"
            className="btn-sm"
            disabled={busy}
            onClick={() => void brief()}
          >
            Brief
          </button>
        )}
        {agent.sessionId && (
          <button
            type="button"
            className="btn-sm"
            onClick={() => onOpenSession(agent.sessionId!)}
          >
            Open session
          </button>
        )}
      </div>
    </div>
  );
}
