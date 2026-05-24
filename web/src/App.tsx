import { useEffect } from "react";
import { Composer } from "./components/Composer";
import { SessionHeader } from "./components/SessionHeader";
import { SessionRail } from "./components/SessionRail";
import { SessionSwitcher } from "./components/SessionSwitcher";
import { Transcript } from "./components/Transcript";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useSessions } from "./hooks/useSessions";

const WIDE_QUERY = "(min-width: 760px)";
const BASE_TITLE = "idea";

function setFavicon(attentionCount: number) {
  if (typeof document === "undefined") return;
  const link = document.getElementById("favicon") as HTMLLinkElement | null;
  if (!link) return;
  const svg =
    attentionCount > 0
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0a0a0a"/><text x="14" y="22" font-family="ui-sans-serif,system-ui" font-size="18" font-weight="700" text-anchor="middle" fill="#e6e6e6">i</text><circle cx="24" cy="9" r="7" fill="#ef4444"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0a0a0a"/><text x="16" y="22" font-family="ui-sans-serif,system-ui" font-size="18" font-weight="700" text-anchor="middle" fill="#e6e6e6">i</text></svg>`;
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
        />
      )}

      {!wide && showRail && (
        <MobileSessionList
          sessions={sessions}
          attentionCount={attentionCount}
          onPick={setCurrent}
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
                onSend={send}
              />
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
}: {
  sessions: ReturnType<typeof useSessions>["sessions"];
  attentionCount: number;
  onPick: (id: string) => void;
}) {
  return (
    <SessionRail
      sessions={sessions}
      current={null}
      onPick={onPick}
      attentionCount={attentionCount}
    />
  );
}
