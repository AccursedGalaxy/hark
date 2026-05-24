import type { SessionView } from "../hooks/useSessions";
import { STATE_LABEL } from "../lib/protocol";
import { sessionLabel, tildeify } from "../lib/format";
import { Dot } from "./Dot";

export function SessionRail({
  sessions,
  current,
  onPick,
  attentionCount,
}: {
  sessions: SessionView[];
  current: string | null;
  onPick: (id: string) => void;
  attentionCount: number;
}) {
  return (
    <aside className="rail" aria-label="Sessions">
      <div className="rail-head">
        <span className="rail-head-title">Claude sessions</span>
        <span className="rail-head-count">
          {attentionCount > 0
            ? `${attentionCount} / ${sessions.length}`
            : sessions.length}
        </span>
      </div>
      <div className="rail-list">
        {sessions.length === 0 ? (
          <div className="rail-empty">No active sessions</div>
        ) : (
          sessions.map((s) => (
            <button
              key={s.sessionId}
              type="button"
              className={`rail-row ${s.sessionId === current ? "is-active" : ""} ${s.needsAttention ? "is-attn" : ""}`}
              onClick={() => onPick(s.sessionId)}
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
          ))
        )}
      </div>
    </aside>
  );
}
