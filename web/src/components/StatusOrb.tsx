import type { SessionState } from "../lib/protocol";

// Header-only "presence" indicator. Replaces the static dot + state label
// with a kinetic visual: a rotating scanner ring while Claude is thinking,
// a slow halo breath while idle, urgent ripples when it's waiting on the
// user. The rail rows keep their compact Dot — this only lives in places
// where there is room for a richer reveal.
const ORB_LABEL: Record<SessionState, string> = {
  busy: "thinking",
  idle: "ready",
  wait: "needs you",
  dead: "offline",
};

export function StatusOrb({ state }: { state: SessionState }) {
  return (
    <span className="status-orb-wrap" data-state={state}>
      <span className="status-orb" aria-hidden="true">
        <span className="status-orb-ring" />
        <span className="status-orb-halo" />
        <span className="status-orb-core" />
      </span>
      <span className="status-orb-label">
        <span className="status-orb-label-text">{ORB_LABEL[state]}</span>
        {state === "busy" && (
          <span className="status-orb-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
      </span>
    </span>
  );
}
