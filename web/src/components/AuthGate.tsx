import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AUTH_REQUIRED_EVENT } from "../lib/transport";

// Sits above App and decides whether to render it at all. The server keeps
// every /api route behind a token (see src/lib/auth.ts); this gate probes
// GET /api/auth/status on mount and either renders the app (authenticated —
// includes loopback, which is exempt server-side) or a minimal login card
// that exchanges the access token for the long-lived hark_auth cookie.
//
// It also listens for the transport layer's AUTH_REQUIRED_EVENT so a 401
// arriving mid-session (token rotated, cookie cleared) flips back to the
// login screen instead of leaving a half-dead app.

type GateState = "checking" | "authed" | "denied";

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/status");
      const data = (await r.json()) as { authenticated?: boolean };
      setState(data.authenticated === true ? "authed" : "denied");
    } catch {
      // Probe failed (server unreachable / mid-restart). Render the app
      // anyway: the server still enforces auth, so if we're genuinely
      // unauthenticated the first API 401 fires AUTH_REQUIRED_EVENT and
      // lands us back here — while a mere network blip gets the app's own
      // "Connection lost" banner instead of a dead login screen.
      setState("authed");
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    const onRequired = () => setState("denied");
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !token.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!r.ok) {
        setErr(r.status === 401 ? "Invalid token" : `Login failed (${r.status})`);
        return;
      }
      // Cookie is set — re-probe rather than trusting our own state, so the
      // gate only opens once the server actually recognizes us.
      setToken("");
      await check();
    } catch {
      setErr("Login failed — is the server reachable?");
    } finally {
      setBusy(false);
    }
  };

  // While the probe is in flight render nothing — it resolves in one round
  // trip, and a flash of login-or-app would be worse than a blank frame.
  if (state === "checking") return null;
  if (state === "authed") return <>{children}</>;

  return (
    <div className="auth-gate">
      <div className="auth-gate-card">
        <div className="auth-gate-eyebrow">hark · access control</div>
        <h2 className="auth-gate-title">Enter access token</h2>
        <p className="auth-gate-body">
          This server is token-protected. Paste the contents of{" "}
          <code>~/.config/hark/token</code> from the host machine — you only
          need to do this once per device.
        </p>
        <form className="auth-gate-form" onSubmit={(e) => void submit(e)}>
          <input
            type="password"
            className="auth-gate-input"
            placeholder="access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
            autoComplete="current-password"
          />
          <button
            type="submit"
            className="btn primary"
            disabled={busy || !token.trim()}
          >
            {busy ? "Checking…" : "Unlock"}
          </button>
        </form>
        {err && <div className="auth-gate-err">{err}</div>}
      </div>
    </div>
  );
}
