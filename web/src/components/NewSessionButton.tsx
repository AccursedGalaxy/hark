import { useEffect, useRef, useState } from "react";
import { spawnSession } from "../lib/transport";

// Compact +New control. Collapsed: a single button. Expanded: a cwd input + Go.
// The server expands `~` and validates the path, so we can pass user input
// through verbatim.
export function NewSessionButton({ onSpawned }: { onSpawned: () => void }) {
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState("~");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setErr(null);
    setCwd("~");
  };

  const go = async () => {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      await spawnSession(trimmed);
      onSpawned();
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "spawn failed");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="rail-new"
        onClick={() => setOpen(true)}
        title="Spawn a new Claude session in a tmux window"
      >
        + New
      </button>
    );
  }

  return (
    <div className="rail-new-form">
      <input
        ref={inputRef}
        type="text"
        value={cwd}
        placeholder="working dir (e.g. ~/Projects/foo)"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={busy}
        onChange={(e) => setCwd(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void go();
          else if (e.key === "Escape") close();
        }}
      />
      <div className="rail-new-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => void go()}
          disabled={busy || !cwd.trim()}
        >
          {busy ? "Spawning…" : "Spawn"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={close}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
      {err && <div className="rail-new-err">{err}</div>}
    </div>
  );
}
