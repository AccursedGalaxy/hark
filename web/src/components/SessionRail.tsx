import { useState } from "react";
import type { SessionView } from "../hooks/useSessions";
import { STATE_LABEL } from "../lib/protocol";
import { sessionLabel, tildeify } from "../lib/format";
import { Dot } from "./Dot";
import { NewSessionButton } from "./NewSessionButton";
import { ThemeToggle } from "./ThemeToggle";

export function SessionRail({
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
  onSpawned: () => void;
  onClose: (id: string) => Promise<void>;
}) {
  const [closing, setClosing] = useState<string | null>(null);

  const handleClose = async (s: SessionView) => {
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
  return (
    <aside className="rail" aria-label="Sessions">
      <div className="rail-head">
        <span className="rail-head-title">Sessions</span>
        <span className="rail-head-actions">
          <span className="rail-head-count">
            {attentionCount > 0
              ? `${attentionCount} / ${sessions.length}`
              : sessions.length}
          </span>
          <ThemeToggle />
        </span>
      </div>
      <div className="rail-toolbar">
        <NewSessionButton onSpawned={onSpawned} />
      </div>
      <div className="rail-list">
        {sessions.length === 0 ? (
          <div className="rail-empty">No active sessions</div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.sessionId}
              data-state={s.state}
              className={`rail-row ${s.sessionId === current ? "is-active" : ""} ${s.needsAttention ? "is-attn" : ""} ${closing === s.sessionId ? "is-closing" : ""}`}
            >
              <button
                type="button"
                className="rail-row-body"
                onClick={() => onPick(s.sessionId)}
                disabled={closing === s.sessionId}
              >
                <div className="rail-row-top">
                  <span className="rail-name">
                    <Dot state={s.state} />
                    <span className="rail-name-text">{sessionLabel(s)}</span>
                  </span>
                  <span className={`rail-state state-${s.state}`}>
                    {STATE_LABEL[s.state]}
                  </span>
                </div>
                <div className="rail-meta">
                  {!s.hasTmuxPane && (
                    <span className="badge-ro">read-only</span>
                  )}
                  <span className="rail-kind">{s.kind}</span>
                  {s.tmuxLocation && (
                    <span
                      className="rail-loc"
                      title={
                        s.tmuxWindowName
                          ? `tmux ${s.tmuxLocation} (${s.tmuxWindowName})`
                          : `tmux ${s.tmuxLocation}`
                      }
                    >
                      {s.tmuxLocation}
                    </span>
                  )}
                </div>
                <div className="rail-dir" title={s.cwd}>
                  {tildeify(s.cwd)}
                </div>
                {s.needsAttention && s.lastEventMessage && (
                  <div className="rail-attn-msg" title={s.lastEventMessage}>
                    {s.lastEventMessage}
                  </div>
                )}
              </button>
              <button
                type="button"
                className="rail-close"
                aria-label={`Close session ${sessionLabel(s)}`}
                title="Close session"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleClose(s);
                }}
                disabled={closing === s.sessionId}
              >
                {closing === s.sessionId ? "…" : "×"}
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
