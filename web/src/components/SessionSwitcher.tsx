import type { SessionView } from "../hooks/useSessions";
import { sessionLabel } from "../lib/format";

const STATE_TO_DOT: Record<string, string> = {
  busy: "live",
  wait: "waiting",
  idle: "idle",
  dead: "error",
};

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
          className={`pill ${s.sessionId === current ? "is-active" : ""} ${
            s.needsAttention ? "is-attn" : ""
          }`}
          onClick={() => onPick(s.sessionId)}
        >
          <span className={"dot " + (STATE_TO_DOT[s.state] ?? "idle")} />
          <span>{sessionLabel(s)}</span>
        </button>
      ))}
    </div>
  );
}
