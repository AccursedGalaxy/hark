import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectInfo } from "../lib/protocol";
import { captureToProject } from "../lib/transport";
import { CloseIcon } from "./icons";

export function CaptureModal({
  open,
  projects,
  defaultProjectKey,
  onClose,
  onCaptured,
}: {
  open: boolean;
  projects: ProjectInfo[];
  defaultProjectKey: string | null;
  onClose: () => void;
  onCaptured: (projectKey: string) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(
    defaultProjectKey,
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Reset every time the modal re-opens; keeps the picker honest about the
  // user's current context (selected project / current session changes
  // between invocations).
  useEffect(() => {
    if (!open) return;
    setSelectedKey(defaultProjectKey);
    setText("");
    setError(null);
    setBusy(false);
    const id = window.setTimeout(() => textRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, defaultProjectKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const noProjects = projects.length === 0;
  const trimmed = text.trim();

  const submit = async () => {
    if (busy) return;
    if (!selectedKey) {
      setError("Pick a project");
      return;
    }
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await captureToProject(selectedKey, trimmed);
      onCaptured(selectedKey);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "capture failed");
    } finally {
      setBusy(false);
    }
  };

  const onTextareaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return createPortal(
    <>
      <div
        className="settings-overlay"
        onClick={onClose}
        role="presentation"
      />
      <div
        className="capture-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Capture to project"
      >
        <div className="settings-head">
          <h3>Capture to project</h3>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="Close capture"
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>

        {noProjects ? (
          <p className="capture-hint">
            No project available — open a session inside a git repo first.
          </p>
        ) : (
          <>
            {projects.length > 1 && (
              <label className="capture-row">
                <span className="capture-label">Project</span>
                <select
                  className="capture-select"
                  value={selectedKey ?? ""}
                  onChange={(e) => setSelectedKey(e.target.value || null)}
                  disabled={busy}
                >
                  {!selectedKey && <option value="">Pick a project…</option>}
                  {projects.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <textarea
              ref={textRef}
              className="capture-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onTextareaKey}
              placeholder="What's on your mind? (Enter to capture, Shift+Enter for newline)"
              rows={4}
              disabled={busy}
              spellCheck
            />

            {error && <div className="capture-error">{error}</div>}

            <div className="capture-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void submit()}
                disabled={busy || !trimmed || !selectedKey}
              >
                {busy ? "Capturing…" : "Capture"}
              </button>
            </div>
          </>
        )}
      </div>
    </>,
    document.body,
  );
}
