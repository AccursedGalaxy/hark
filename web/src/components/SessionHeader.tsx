import type { SessionView } from "../hooks/useSessions";
import { sessionLabel, shortId, tildeify } from "../lib/format";
import { StatusOrb } from "./StatusOrb";

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
      <span className="session-head-title">{sessionLabel(session)}</span>
      <StatusOrb state={session.state} />
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
