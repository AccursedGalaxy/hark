import { useMemo, useState } from "react";
import type { SessionView } from "../hooks/useSessions";
import { sessionLabel, tildeify } from "../lib/format";
import { setTheme, type Theme, getActiveTheme } from "../lib/theme";
import { BranchIcon, CloseIcon, PlusIcon, SearchIcon, SettingsIcon } from "./icons";
import { NewSessionButton } from "./NewSessionButton";

// Map our 4-state model to the design's 4 status badges:
//   busy → LIVE, wait → ASKING, idle → IDLE, dead → OFFLINE
const STATE_TO_DESIGN: Record<string, { dot: string; tag: string; label: string }> = {
  busy: { dot: "live", tag: "live", label: "LIVE" },
  wait: { dot: "waiting", tag: "waiting", label: "ASKING" },
  idle: { dot: "idle", tag: "idle", label: "IDLE" },
  dead: { dot: "error", tag: "ro", label: "OFFLINE" },
};

export function Sidebar({
  sessions,
  current,
  onPick,
  attentionCount,
  onSpawned,
  onClose,
}: {
  sessions: SessionView[];
  current: string | null;
  onPick: (id: string) => void;
  attentionCount: number;
  onSpawned: (pid: number | null) => void;
  onClose: (id: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [theme, setLocalTheme] = useState<Theme>(() => getActiveTheme());
  const [closing, setClosing] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const label = sessionLabel(s).toLowerCase();
      const cwd = (s.cwd ?? "").toLowerCase();
      return label.includes(q) || cwd.includes(q) || s.sessionId.includes(q);
    });
  }, [sessions, filter]);

  const { needs, idle } = useMemo(() => {
    const needs: SessionView[] = [];
    const idle: SessionView[] = [];
    for (const s of filtered) {
      if (s.state === "wait" || s.state === "busy" || s.needsAttention) {
        needs.push(s);
      } else {
        idle.push(s);
      }
    }
    return { needs, idle };
  }, [filtered]);

  const ordered = [...needs, ...idle];

  const handleClose = async (s: SessionView, ev: React.MouseEvent) => {
    ev.stopPropagation();
    const label = sessionLabel(s);
    const ok = window.confirm(
      `Close session "${label}"?\n\nThis terminates the Claude process in ${tildeify(s.cwd)}.`,
    );
    if (!ok) return;
    setClosing(s.sessionId);
    try {
      await onClose(s.sessionId);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Close failed");
    } finally {
      setClosing(null);
    }
  };

  const pickTheme = (t: Theme) => {
    setTheme(t);
    setLocalTheme(t);
  };

  return (
    <aside className="rail" data-screen-label="Sidebar">
      <div className="rail-head">
        <div className="brand">
          <span className="brand-dot"></span>
          hark
        </div>
        <div className="brand-meta">
          <div className="theme-switch" role="tablist" aria-label="Theme">
            <button
              type="button"
              className={theme === "dark" ? "on" : ""}
              onClick={() => pickTheme("dark")}
              aria-pressed={theme === "dark"}
            >
              Dark
            </button>
            <button
              type="button"
              className={theme === "paper" ? "on" : ""}
              onClick={() => pickTheme("paper")}
              aria-pressed={theme === "paper"}
            >
              Paper
            </button>
          </div>
        </div>
      </div>

      <div className="rail-search">
        <span className="icn">
          <SearchIcon />
        </span>
        <input
          placeholder="Search sessions, files, commands…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <kbd>⌘K</kbd>
      </div>

      {spawnOpen ? (
        <NewSessionButton
          inline
          onCancel={() => setSpawnOpen(false)}
          onSpawned={(pid) => {
            setSpawnOpen(false);
            onSpawned(pid);
          }}
        />
      ) : (
        <button
          type="button"
          className="new-btn"
          onClick={() => setSpawnOpen(true)}
        >
          <span className="plus">
            <PlusIcon />
          </span>
          <span>New session</span>
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--fg-3)",
            }}
          >
            ⌘N
          </span>
        </button>
      )}

      <div className="section-label">
        <span>Needs you</span>
        <span className="count">{attentionCount || needs.length}</span>
      </div>

      <div className="sessions">
        {ordered.length === 0 ? (
          <div
            style={{
              padding: "12px 14px",
              color: "var(--fg-3)",
              fontSize: 12,
              fontFamily: "var(--mono)",
            }}
          >
            No active sessions
          </div>
        ) : (
          ordered.map((s) => (
            <SessionRow
              key={s.sessionId}
              session={s}
              active={s.sessionId === current}
              closing={closing === s.sessionId}
              onClick={() => onPick(s.sessionId)}
              onClose={(e) => void handleClose(s, e)}
            />
          ))
        )}
      </div>

      <div className="rail-footer">
        <div className="avatar">h</div>
        <div>
          <div className="who">hark</div>
          <div className="role">workspace · local</div>
        </div>
        <button
          className="icon-btn"
          style={{ marginLeft: "auto" }}
          title="Settings"
          aria-label="Settings"
        >
          <SettingsIcon />
        </button>
      </div>
    </aside>
  );
}

function SessionRow({
  session,
  active,
  closing,
  onClick,
  onClose,
}: {
  session: SessionView;
  active: boolean;
  closing: boolean;
  onClick: () => void;
  onClose: (e: React.MouseEvent) => void;
}) {
  const style = STATE_TO_DESIGN[session.state] ?? STATE_TO_DESIGN.idle;
  const label = sessionLabel(session);
  const showRO = !session.hasTmuxPane;

  return (
    <div
      className={"session" + (active ? " active" : "")}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <button
        type="button"
        className="session-close"
        onClick={onClose}
        disabled={closing}
        aria-label={`Close session ${label}`}
        title="Close session"
      >
        {closing ? "…" : <CloseIcon />}
      </button>
      <div className="session-top">
        <span className="session-name">{label}</span>
        <span className="session-status">
          <span className={"dot " + style.dot}></span>
          {style.label}
        </span>
      </div>
      <div className="session-meta">
        <span className={"tag " + (active ? "accent" : "")}>{session.kind}</span>
        {session.tmuxLocation && (
          <span className="tag" title={`tmux ${session.tmuxLocation}`}>
            {session.tmuxLocation}
          </span>
        )}
        {showRO && <span className="tag ro">read-only</span>}
        <span style={{ marginLeft: "auto", color: "var(--fg-3)" }}>
          {shortRelative(session.updatedAt ?? session.lastEventAt)}
        </span>
      </div>
      <div className="session-path">
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {tildeify(session.cwd)}
        </span>
        {session.tmuxWindowName && (
          <>
            <span>·</span>
            <span className="branch">
              <BranchIcon /> {session.tmuxWindowName}
            </span>
          </>
        )}
      </div>
      {active && session.lastEventMessage && (
        <div className="session-summary">{session.lastEventMessage}</div>
      )}
    </div>
  );
}

function shortRelative(ms: number | undefined): string {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 0) return "now";
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d`;
  return new Date(ms).toLocaleDateString();
}
