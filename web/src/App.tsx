import { useEffect, useState } from "react";
import { Composer } from "./components/Composer";
import { SessionHeader } from "./components/SessionHeader";
import { SessionRail } from "./components/SessionRail";
import { SessionSwitcher } from "./components/SessionSwitcher";
import { StatusOrb } from "./components/StatusOrb";
import { Transcript } from "./components/Transcript";
import { TrustPrompt } from "./components/TrustPrompt";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useSessions } from "./hooks/useSessions";

const WIDE_QUERY = "(min-width: 760px)";
const BASE_TITLE = "hark";

function setFavicon(attentionCount: number) {
  if (typeof document === "undefined") return;
  const link = document.getElementById("favicon") as HTMLLinkElement | null;
  if (!link) return;
  const svg =
    attentionCount > 0
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0a0a0a"/><text x="14" y="22" font-family="ui-sans-serif,system-ui" font-size="18" font-weight="700" text-anchor="middle" fill="#e6e6e6">h</text><circle cx="24" cy="9" r="7" fill="#ef4444"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0a0a0a"/><text x="16" y="22" font-family="ui-sans-serif,system-ui" font-size="18" font-weight="700" text-anchor="middle" fill="#e6e6e6">h</text></svg>`;
  const href = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  if (link.href !== href) link.href = href;
}

export default function App() {
  const wide = useMediaQuery(WIDE_QUERY);
  const {
    connected,
    sessions,
    attentionCount,
    current,
    currentSession,
    setCurrent,
    events,
    transcriptLoading,
    transcriptError,
    send,
    sendError,
    upload,
    currentPromptKind,
    currentPendingPermission,
    closeSession,
    refresh,
  } = useSessions();

  // Sync title + favicon with attention count.
  useEffect(() => {
    const prefix = attentionCount > 0 ? `(${attentionCount}) ` : "";
    document.title = `${prefix}${BASE_TITLE}`;
    setFavicon(attentionCount);
  }, [attentionCount]);

  // On desktop, auto-select the first session if none is picked.
  useEffect(() => {
    if (!wide) return;
    if (current) return;
    const first = sessions[0];
    if (first) setCurrent(first.sessionId);
  }, [wide, current, sessions, setCurrent]);

  // If the currently-selected session disappears (closed externally, or a
  // pending session got registered under a real UUID after a trust confirm),
  // clear the selection so the auto-select effect above can pick a new one.
  useEffect(() => {
    if (!current) return;
    if (sessions.length === 0) return;
    if (!sessions.some((s) => s.sessionId === current)) setCurrent(null);
  }, [current, sessions, setCurrent]);

  // After trust confirm, follow the same claude PID to its newly-registered
  // session (same process, fresh UUID). Otherwise the pending row vanishes
  // and the user lands on whatever sessions[0] happens to be — likely the
  // wrong place.
  const [awaitingPid, setAwaitingPid] = useState<number | null>(null);
  useEffect(() => {
    if (awaitingPid === null) return;
    const match = sessions.find(
      (s) => s.pid === awaitingPid && s.kind !== "pending",
    );
    if (match) {
      setCurrent(match.sessionId);
      setAwaitingPid(null);
    }
  }, [awaitingPid, sessions, setCurrent]);

  const showRail = wide || !current;
  const showSession = wide || !!current;

  return (
    <div className={`app ${wide ? "is-wide" : "is-narrow"}`}>
      {!connected && (
        <div className="conn-banner" role="status">
          Connection lost — reconnecting…
        </div>
      )}

      {wide && (
        <SessionRail
          sessions={sessions}
          current={current}
          onPick={setCurrent}
          attentionCount={attentionCount}
          onSpawned={refresh}
          onClose={closeSession}
        />
      )}

      {!wide && showRail && (
        <MobileSessionList
          sessions={sessions}
          attentionCount={attentionCount}
          onPick={setCurrent}
          onSpawned={refresh}
          onClose={closeSession}
        />
      )}

      {showSession && (
        <main className="session-pane">
          {!wide && currentSession && (
            <SessionSwitcher
              sessions={sessions}
              current={current}
              onPick={setCurrent}
            />
          )}

          {currentSession ? (
            <>
              <SessionHeader
                session={currentSession}
                onBack={!wide ? () => setCurrent(null) : undefined}
              />
              {currentSession.kind === "pending" ? (
                <TrustPrompt
                  session={currentSession}
                  onSend={send}
                  onTrustConfirmed={setAwaitingPid}
                />
              ) : (
                <>
                  <Transcript
                    events={events}
                    loading={transcriptLoading}
                    error={transcriptError}
                  />
                  <Composer
                    disabled={!currentSession.hasTmuxPane}
                    disabledReason={
                      !currentSession.hasTmuxPane
                        ? "session not in tmux"
                        : undefined
                    }
                    errorMessage={sendError}
                    promptKind={currentPromptKind}
                    pendingPermission={currentPendingPermission}
                    cwd={currentSession.cwd}
                    onSend={send}
                    onUpload={upload}
                  />
                  <div className="session-presence-wrap">
                    <StatusOrb state={currentSession.state} />
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="empty">
              {connected ? "No sessions" : "Connecting…"}
            </div>
          )}
        </main>
      )}
    </div>
  );
}

// Full-screen list shown on mobile when no session is selected. Uses the same
// rich rail rows because it has the screen space and gives a "home" feel.
function MobileSessionList({
  sessions,
  attentionCount,
  onPick,
  onSpawned,
  onClose,
}: {
  sessions: ReturnType<typeof useSessions>["sessions"];
  attentionCount: number;
  onPick: (id: string) => void;
  onSpawned: () => void;
  onClose: (id: string) => Promise<void>;
}) {
  return (
    <SessionRail
      sessions={sessions}
      current={null}
      onPick={onPick}
      attentionCount={attentionCount}
      onSpawned={onSpawned}
      onClose={onClose}
    />
  );
}
