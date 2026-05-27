import { useEffect, useState } from "react";
import { Composer } from "./components/Composer";
import { ContextRail } from "./components/ContextRail";
import { Sidebar } from "./components/Sidebar";
import { SessionSwitcher } from "./components/SessionSwitcher";
import { TaskListPanel } from "./components/TaskListPanel";
import { TopBar } from "./components/TopBar";
import { Transcript } from "./components/Transcript";
import { TrustPrompt } from "./components/TrustPrompt";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useSessions } from "./hooks/useSessions";
import { sessionLabel, tildeify } from "./lib/format";
import { getContextRail, setContextRail } from "./lib/theme";

const WIDE_QUERY = "(min-width: 880px)";
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
  const [showContext, setShowContext] = useState<boolean>(() => getContextRail());

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
    currentPending,
    currentLastError,
    closeSession,
    refresh,
  } = useSessions();

  useEffect(() => {
    const prefix = attentionCount > 0 ? `(${attentionCount}) ` : "";
    document.title = `${prefix}${BASE_TITLE}`;
    setFavicon(attentionCount);
  }, [attentionCount]);

  useEffect(() => {
    if (!wide) return;
    if (current) return;
    const first = sessions[0];
    if (first) setCurrent(first.sessionId);
  }, [wide, current, sessions, setCurrent]);

  useEffect(() => {
    if (!current) return;
    if (sessions.length === 0) return;
    if (!sessions.some((s) => s.sessionId === current)) setCurrent(null);
  }, [current, sessions, setCurrent]);

  // Used by two flows that both need "focus the session with this pid as
  // soon as it appears in the rail":
  //   1. spawning a new session — we want to land on the pending row so
  //      the TrustPrompt is visible immediately, without the user having
  //      to find and click it.
  //   2. confirming trust on an existing pending session — focus the real
  //      session once Claude registers under a UUID. (The pending→real
  //      handoff in useSessions promotes us automatically once we're on
  //      pending-<pid>, so matching either kind is fine here.)
  const [awaitingPid, setAwaitingPid] = useState<number | null>(null);
  useEffect(() => {
    if (awaitingPid === null) return;
    const match = sessions.find((s) => s.pid === awaitingPid);
    if (match) {
      setCurrent(match.sessionId);
      setAwaitingPid(null);
    }
  }, [awaitingPid, sessions, setCurrent]);

  const showSidebar = wide;
  const showSession = wide || !!current;
  const ctxVisible = wide && showContext && !!currentSession && currentSession.kind !== "pending";

  return (
    <div
      className={`app ${wide ? "is-wide" : "is-narrow"} ${ctxVisible ? "with-context" : ""}`}
    >
      {!connected && (
        <div className="conn-banner" role="status">
          Connection lost — reconnecting…
        </div>
      )}

      {showSidebar && (
        <Sidebar
          sessions={sessions}
          current={current}
          onPick={setCurrent}
          attentionCount={attentionCount}
          onSpawned={(pid) => {
            if (pid !== null) setAwaitingPid(pid);
            refresh();
          }}
          onClose={closeSession}
          showContext={showContext}
          onShowContext={(v) => {
            setShowContext(v);
            setContextRail(v);
          }}
        />
      )}

      {!showSidebar && !current && (
        <Sidebar
          sessions={sessions}
          current={current}
          onPick={setCurrent}
          attentionCount={attentionCount}
          onSpawned={(pid) => {
            if (pid !== null) setAwaitingPid(pid);
            refresh();
          }}
          onClose={closeSession}
          showContext={showContext}
          onShowContext={(v) => {
            setShowContext(v);
            setContextRail(v);
          }}
        />
      )}

      {showSession && (
        <main className="main">
          {!wide && currentSession && (
            <SessionSwitcher
              sessions={sessions}
              current={current}
              onPick={setCurrent}
            />
          )}

          {currentSession ? (
            <>
              <TopBar
                session={currentSession}
                onBack={!wide ? () => setCurrent(null) : undefined}
                onClose={() => {
                  const label = sessionLabel(currentSession);
                  const ok = window.confirm(
                    `Close session "${label}"?\n\nThis terminates the Claude process in ${tildeify(currentSession.cwd)}.`,
                  );
                  if (!ok) return;
                  void closeSession(currentSession.sessionId);
                }}
              />
              {currentSession.kind === "pending" ? (
                <TrustPrompt
                  session={currentSession}
                  onSend={send}
                  onTrustConfirmed={setAwaitingPid}
                />
              ) : (
                <>
                  <TaskListPanel
                    events={events}
                    sessionId={currentSession.sessionId}
                  />
                  <Transcript
                    events={events}
                    loading={transcriptLoading}
                    error={transcriptError}
                    pendingKind={currentPending?.kind ?? null}
                    onJumpToQuestion={() => {
                      const el = document.querySelector(
                        '[data-screen-label="QuestionDock"]',
                      );
                      el?.scrollIntoView({ behavior: "smooth", block: "center" });
                    }}
                  />
                  <div className="dock">
                    <Composer
                      disabled={!currentSession.hasTmuxPane}
                      disabledReason={
                        !currentSession.hasTmuxPane
                          ? "session not in tmux"
                          : undefined
                      }
                      errorMessage={sendError}
                      promptKind={currentPromptKind}
                      pending={currentPending}
                      lastError={currentLastError}
                      cwd={currentSession.cwd}
                      onSend={send}
                      onUpload={upload}
                    />
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="empty">
              {connected ? "No session selected" : "Connecting…"}
            </div>
          )}
        </main>
      )}

      {ctxVisible && currentSession && (
        <ContextRail session={currentSession} events={events} />
      )}
    </div>
  );
}
