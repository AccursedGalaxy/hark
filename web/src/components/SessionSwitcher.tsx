import type { SessionView } from "../hooks/useSessions";
import { sessionLabel } from "../lib/format";
import { Dot } from "./Dot";

// Mobile session switcher. Horizontal scroll if many sessions; pills stay
// scannable up to ~5. Past that, swap for a slide-over of <SessionRail>.
export function SessionSwitcher({
  sessions,
  current,
  onPick,
}: {
  sessions: SessionView[];
  current: string | null;
  onPick: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return <div className="switcher switcher-empty">No active sessions</div>;
  }
  return (
    <div className="switcher" role="tablist" aria-label="Sessions">
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          role="tab"
          type="button"
          aria-selected={s.sessionId === current}
          className={`pill ${s.sessionId === current ? "is-active" : ""} ${s.needsAttention ? "is-attn" : ""}`}
          onClick={() => onPick(s.sessionId)}
        >
          <Dot state={s.state} />
          <span className="pill-text">{sessionLabel(s)}</span>
        </button>
      ))}
    </div>
  );
}
