import { useLayoutEffect, useRef, useState } from "react";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import type { SendBody } from "../lib/protocol";

export function Composer({
  disabled,
  disabledReason,
  errorMessage,
  onSend,
}: {
  disabled: boolean;
  disabledReason?: string;
  errorMessage: string | null;
  onSend: (body: SendBody) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const kbInset = useKeyboardInset();

  // Auto-grow the textarea up to a cap; matches the old composer's behavior.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [text]);

  const submitText = async () => {
    const t = text;
    if (!t.trim() || disabled || busy) return;
    setBusy(true);
    try {
      await onSend({ text: t });
      setText("");
    } catch {
      // sendError is surfaced via errorMessage prop
    } finally {
      setBusy(false);
    }
  };

  const sendKeySequence = async (keys: string[]) => {
    if (disabled || busy) return;
    setBusy(true);
    try {
      for (const k of keys) {
        await onSend({ key: k });
      }
    } catch {
      /* errorMessage surfaces it */
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Enter sends, Shift+Enter newline. Skip Enter-to-send on touch where it's annoying.
    if (e.key === "Enter" && !e.shiftKey && !isTouch()) {
      e.preventDefault();
      void submitText();
    }
  };

  return (
    <div
      className={`composer-wrap ${disabled ? "is-disabled" : ""}`}
      style={{ paddingBottom: kbInset }}
    >
      {errorMessage && (
        <div className="composer-error" role="status">
          {errorMessage}
        </div>
      )}
      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={
            disabled
              ? (disabledReason ?? "Disabled")
              : "Send a message · Enter to send, Shift+Enter for newline"
          }
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Message"
        />
        <div className="composer-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void submitText()}
            disabled={disabled || busy || !text.trim()}
          >
            Send
          </button>
          <button
            type="button"
            className="btn-ghost"
            title="Send '1' then Enter (approve a permission prompt)"
            onClick={() => void sendKeySequence(["1", "Enter"])}
            disabled={disabled || busy}
          >
            Approve
          </button>
          <button
            type="button"
            className="btn-ghost"
            title="Send '2' then Enter (deny a permission prompt)"
            onClick={() => void sendKeySequence(["2", "Enter"])}
            disabled={disabled || busy}
          >
            Deny
          </button>
          <button
            type="button"
            className="btn-ghost"
            title="Send Escape"
            onClick={() => void sendKeySequence(["Escape"])}
            disabled={disabled || busy}
          >
            Esc
          </button>
          {disabled && disabledReason && (
            <span className="composer-hint">{disabledReason}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function isTouch() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}
