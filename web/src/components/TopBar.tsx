import { useEffect, useState } from "react";
import type { SessionView } from "../hooks/useSessions";
import { shortId, tildeify } from "../lib/format";
import {
  BranchIcon,
  ForkIcon,
  HistoryIcon,
  PauseIcon,
  ShareIcon,
} from "./icons";

// Map our internal session state into the design's status-chip variants:
//   wait → "waiting" (indigo/amber pill in the design)
//   busy → "busy"    (accent pill, thinking-time counter)
//   idle → "idle"    (jade)
//   dead → "dead"    (coral)
const STATE_TO_CHIP: Record<string, { className: string; label: string }> = {
  busy: { className: "busy", label: "Thinking" },
  wait: { className: "", label: "Awaiting your input" },
  idle: { className: "idle", label: "Idle" },
  dead: { className: "dead", label: "Offline" },
};

export function TopBar({
  session,
  onBack,
  onClose,
}: {
  session: SessionView;
  onBack?: () => void;
  onClose?: () => void;
}) {
  // Live thinking-time counter. Restart whenever the session enters "busy".
  const [busySeconds, setBusySeconds] = useState(0);
  useEffect(() => {
    if (session.state !== "busy") {
      setBusySeconds(0);
      return;
    }
    const start = session.updatedAt ?? Date.now();
    const tick = () =>
      setBusySeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [session.state, session.updatedAt]);

  const chip = STATE_TO_CHIP[session.state] ?? STATE_TO_CHIP.idle;
  const chipText =
    session.state === "busy"
      ? `${chip.label} · ${busySeconds}s`
      : chip.label;

  const project = tildeify(session.cwd);
  const projectParts = project.split("/").filter(Boolean);
  const lastSeg = projectParts[projectParts.length - 1] ?? project;
  const parentSeg = projectParts.slice(0, -1).join("/");

  return (
    <header className="topbar" data-screen-label="TopBar">
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
      <div className="crumbs">
        {parentSeg && (
          <>
            <span title={project}>{parentSeg.startsWith("~") ? parentSeg : "/" + parentSeg}</span>
            <span className="sep">/</span>
          </>
        )}
        <span className="here" title={project}>
          {lastSeg}
        </span>
        {session.tmuxLocation && (
          <span className="branch" style={{ marginLeft: 8 }}>
            <BranchIcon /> {session.tmuxLocation}
          </span>
        )}
      </div>

      <div className={"status-chip " + chip.className}>
        <span className="pulse"></span> {chipText}
      </div>

      <div className="spacer"></div>

      <div className="topbar-meta">
        <span className="id">#{shortId(session.sessionId)}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>{session.kind}</span>
        {session.version && (
          <>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>v{session.version}</span>
          </>
        )}
      </div>

      <div style={{ display: "flex", gap: 4 }}>
        <button className="icon-btn" title="History" aria-label="History">
          <HistoryIcon />
        </button>
        <button className="icon-btn" title="Fork session" aria-label="Fork">
          <ForkIcon />
        </button>
        <button className="icon-btn" title="Share" aria-label="Share">
          <ShareIcon />
        </button>
        {onClose && (
          <button
            className="icon-btn danger"
            title="Close session"
            aria-label="Close session"
            onClick={onClose}
          >
            <PauseIcon />
          </button>
        )}
      </div>
    </header>
  );
}
