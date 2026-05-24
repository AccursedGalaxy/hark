import type { SessionView } from "../hooks/useSessions";
import { STATE_LABEL } from "../lib/protocol";
import { sessionLabel, shortId, tildeify } from "../lib/format";
import { Dot } from "./Dot";

export function SessionHeader({
  session,
  onBack,
}: {
  session: SessionView;
  onBack?: () => void;
}) {
  return (
    <div className="session-head">
      {onBack && (
        <button
          type="button"
          className="back-btn"
          onClick={onBack}
          aria-label="Back to sessions"
        >
          ←
        </button>
      )}
      <Dot state={session.state} />
      <span className="session-head-title">{sessionLabel(session)}</span>
      <span className={`session-head-state state-${session.state}`}>
        {STATE_LABEL[session.state]}
      </span>
      <span className="session-head-meta">
        <span className="session-head-dir" title={session.cwd}>
          {tildeify(session.cwd)}
        </span>
        <span className="session-head-kind">{session.kind}</span>
        <span className="session-head-id">{shortId(session.sessionId)}</span>
      </span>
    </div>
  );
}
