import { useEffect, useId, useRef, useState } from "react";
import { fetchRecentSpawnDirs, spawnSession } from "../lib/transport";

export function NewSessionButton({
  inline,
  onSpawned,
  onCancel,
}: {
  inline?: boolean;
  // Receives the new pane's PID so the caller can auto-focus the matching
  // pending/registered session row once it appears. null when tmux didn't
  // print a parseable pid (shouldn't happen with -P -F, but degrade safely).
  onSpawned: (pid: number | null) => void;
  onCancel?: () => void;
}) {
  const [open, setOpen] = useState(!!inline);
  const [cwd, setCwd] = useState("~");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    void fetchRecentSpawnDirs().then(setSuggestions).catch(() => {});
  }, [open]);

  const close = () => {
    setErr(null);
    setCwd("~");
    if (inline) {
      onCancel?.();
    } else {
      setOpen(false);
    }
  };

  const go = async () => {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await spawnSession(trimmed);
      onSpawned(res.pid ?? null);
      if (!inline) setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "spawn failed");
    } finally {
      setBusy(false);
    }
  };

  if (!open && !inline) {
    return (
      <button
        type="button"
        className="btn"
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
        list={listId}
        onChange={(e) => setCwd(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void go();
          else if (e.key === "Escape") close();
        }}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
      )}
      <div className="rail-new-actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => void go()}
          disabled={busy || !cwd.trim()}
        >
          {busy ? "Spawning…" : "Spawn"}
        </button>
        <button
          type="button"
          className="btn ghost"
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
