import { useState } from "react";
import type { SessionView } from "../hooks/useSessions";
import type { SendBody } from "../lib/protocol";
import { tildeify } from "../lib/format";

// Shown in place of the transcript when the selected session is `pending`.
// Mirrors Claude Code's TUI trust dialog ("1. Yes, I trust this folder /
// 2. No, exit") so the user can act on it from the web instead of having to
// switch to tmux. After the user picks one, Claude either registers a real
// session (we'll auto-switch off this synthetic id on the next poll) or
// exits cleanly (the row will disappear from the rail).
export function TrustPrompt({
  session,
  onSend,
  onTrustConfirmed,
}: {
  session: SessionView;
  onSend: (body: SendBody) => Promise<void>;
  // Called after we successfully send the trust-yes keystrokes, with the
  // pid of the claude process the user just trusted. The parent uses this
  // to auto-focus the new session once it registers under a real UUID.
  onTrustConfirmed?: (pid: number) => void;
}) {
  const [busy, setBusy] = useState<"trust" | "exit" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const click = async (choice: "trust" | "exit") => {
    setBusy(choice);
    setErr(null);
    try {
      // Claude's TUI gate uses 1-then-Enter / 2-then-Enter. We send the
      // digit as text + an explicit Enter via the existing send API.
      await onSend({ text: choice === "trust" ? "1" : "2" });
      if (choice === "trust") onTrustConfirmed?.(session.pid);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "send failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="trust-prompt">
      <div className="trust-prompt-card">
        <div className="trust-prompt-eyebrow">New session · awaiting trust</div>
        <h2 className="trust-prompt-title">Trust this folder?</h2>
        <div className="trust-prompt-path">{tildeify(session.cwd)}</div>
        <p className="trust-prompt-body">
          Claude Code will be able to read, edit, and execute files here. Only
          trust folders you created or know are safe.
        </p>
        <div className="trust-prompt-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void click("trust")}
            disabled={busy !== null}
            autoFocus
          >
            {busy === "trust" ? "Confirming…" : "Yes, trust this folder"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void click("exit")}
            disabled={busy !== null}
          >
            {busy === "exit" ? "Exiting…" : "No, exit"}
          </button>
        </div>
        {err && <div className="trust-prompt-err">{err}</div>}
      </div>
    </div>
  );
}
