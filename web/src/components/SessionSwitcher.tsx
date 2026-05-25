import type { SessionView } from "../hooks/useSessions";
import { sessionLabel, shortId } from "../lib/format";

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
    return (
      <div className="switcher switcher-empty">No active sessions</div>
    );
  }

  // When multiple sessions share the same primary label (e.g. several
  // sessions under the same project all read "hark"), repeating the
  // project name on every pill wastes phone-width and forces the strip
  // to scroll-clip. The topbar already shows the project, so in that
  // case we collapse the pill to just the disambiguator — the tmux pane
  // location (e.g. "dev:4.1"), falling back to a short id.
  const labelCounts = new Map<string, number>();
  for (const s of sessions) {
    const k = sessionLabel(s);
    labelCounts.set(k, (labelCounts.get(k) ?? 0) + 1);
  }

  return (
    <div className="switcher" role="tablist" aria-label="Sessions">
      {/* Inner track owns the horizontal scroll. Keeping it as a separate
          element lets the outer .switcher use `overflow: visible`, so pill
          borders don't get clipped vertically by the implicit overflow-y
          that `overflow-x: auto` would otherwise force. */}
      <div className="switcher-track">
        {sessions.map((s) => {
          const label = sessionLabel(s);
          const collides = (labelCounts.get(label) ?? 0) > 1;
          const disambig = s.tmuxLocation ?? shortId(s.sessionId);
          const isActive = s.sessionId === current;
          return (
            <button
              key={s.sessionId}
              role="tab"
              type="button"
              aria-selected={isActive}
              title={collides ? `${label} · ${disambig}` : label}
              className={`pill ${isActive ? "is-active" : ""} ${
                s.needsAttention ? "is-attn" : ""
              }`}
              onClick={() => onPick(s.sessionId)}
            >
              <span className={"dot " + (STATE_TO_DOT[s.state] ?? "idle")} />
              <span className={collides ? "mono" : undefined}>
                {collides ? disambig : label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
