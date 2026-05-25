import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import type { PendingPermission, PromptKind, SendBody } from "../lib/protocol";

const PROMPT_LABEL: Record<Exclude<PromptKind, null>, string> = {
  permission: "permission requested",
  elicitation: "form input requested",
  idle: "awaiting your reply",
};

const PERMISSION_CARD_MAX = 400; // chars in collapsed summary
const PLAN_CARD_MAX_HEIGHT = "40vh";

// Single-key chips for the raw-key pad. `key` is the tmux key name passed
// straight to `tmux send-keys`; see docs/interactions.md for which prompts
// each one targets.
type KeyChip = { label: string; key: string; title?: string };

const KEY_ROWS: KeyChip[][] = [
  [
    { label: "1", key: "1" },
    { label: "2", key: "2" },
    { label: "3", key: "3" },
    { label: "4", key: "4" },
    { label: "5", key: "5" },
    { label: "y", key: "y" },
    { label: "n", key: "n" },
  ],
  [
    { label: "↑", key: "Up", title: "Arrow up" },
    { label: "↓", key: "Down", title: "Arrow down" },
    { label: "←", key: "Left", title: "Arrow left" },
    { label: "→", key: "Right", title: "Arrow right" },
    { label: "Tab", key: "Tab" },
    { label: "Enter", key: "Enter" },
    { label: "^C", key: "C-c", title: "Send Ctrl+C (interrupt)" },
  ],
];

export function Composer({
  disabled,
  disabledReason,
  errorMessage,
  promptKind,
  pendingPermission,
  onSend,
}: {
  disabled: boolean;
  disabledReason?: string;
  errorMessage: string | null;
  promptKind: PromptKind;
  pendingPermission: PendingPermission | null;
  onSend: (body: SendBody) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [keypadOpen, setKeypadOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const kbInset = useKeyboardInset();

  const isPlanMode = pendingPermission?.toolName === "ExitPlanMode";
  // ExitPlanMode gets its own three-button action set; vanilla permission
  // prompts get the Approve/Deny pair; everything else hides both.
  const showApproveDeny = promptKind === "permission" && !isPlanMode;
  const showPlanButtons = isPlanMode;
  // Auto-open the keypad when Claude is awaiting a discrete choice
  // (permission digit, MCP elicitation form). Skip for "idle" — there the
  // user types a message in the textarea, raw keys aren't useful.
  const autoOpenKeypad =
    promptKind === "permission" || promptKind === "elicitation";

  useEffect(() => {
    if (autoOpenKeypad) setKeypadOpen(true);
  }, [autoOpenKeypad]);

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

  const sendKey = (k: string) => sendKeySequence([k]);

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
        {pendingPermission && <PermissionCard pending={pendingPermission} />}
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
          {showApproveDeny && (
            <>
              <button
                type="button"
                className="btn-approve"
                title="Send '1' then Enter (approve a permission prompt)"
                onClick={() => void sendKeySequence(["1", "Enter"])}
                disabled={disabled || busy}
              >
                Approve
              </button>
              <button
                type="button"
                className="btn-deny"
                title="Send '2' then Enter (deny a permission prompt)"
                onClick={() => void sendKeySequence(["2", "Enter"])}
                disabled={disabled || busy}
              >
                Deny
              </button>
            </>
          )}
          {showPlanButtons && (
            <>
              <button
                type="button"
                className="btn-approve"
                title="Send '1' then Enter — accept plan, auto-accept file edits"
                onClick={() => void sendKeySequence(["1", "Enter"])}
                disabled={disabled || busy}
              >
                Accept (auto)
              </button>
              <button
                type="button"
                className="btn-approve btn-approve-soft"
                title="Send '2' then Enter — accept plan, review each edit"
                onClick={() => void sendKeySequence(["2", "Enter"])}
                disabled={disabled || busy}
              >
                Accept (review)
              </button>
              <button
                type="button"
                className="btn-deny"
                title="Send '3' then Enter — keep planning"
                onClick={() => void sendKeySequence(["3", "Enter"])}
                disabled={disabled || busy}
              >
                Keep planning
              </button>
            </>
          )}
          <button
            type="button"
            className="btn-ghost"
            title="Send Escape"
            onClick={() => void sendKeySequence(["Escape"])}
            disabled={disabled || busy}
          >
            Esc
          </button>
          <button
            type="button"
            className="btn-ghost btn-keypad-toggle"
            title="Toggle raw key pad"
            aria-expanded={keypadOpen}
            onClick={() => setKeypadOpen((v) => !v)}
            disabled={disabled}
          >
            {keypadOpen ? "Hide keys" : "Keys"}
          </button>
          {promptKind && !disabled && (
            <span
              className={`composer-hint composer-hint-prompt prompt-${promptKind}`}
              title="What Claude Code is waiting for"
            >
              {PROMPT_LABEL[promptKind]}
            </span>
          )}
          {disabled && disabledReason && (
            <span className="composer-hint">{disabledReason}</span>
          )}
        </div>
        {keypadOpen && (
          <div className="composer-keypad" role="group" aria-label="Raw keys">
            {KEY_ROWS.map((row, i) => (
              <div className="keypad-row" key={i}>
                {row.map((chip) => (
                  <button
                    type="button"
                    key={chip.key}
                    className="key-chip"
                    title={chip.title ?? `Send ${chip.key}`}
                    onClick={() => void sendKey(chip.key)}
                    disabled={disabled || busy}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
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

// ---- Permission card -------------------------------------------------------

type PermissionSummary = {
  // Short label that goes on the card chip, e.g. "Bash", "Edit", "MCP".
  badge: string;
  // The actual content to render. `kind` switches the styling — "command",
  // "path", "url", "plan" each get a slightly different look.
  kind: "command" | "path" | "url" | "plan" | "raw";
  body: string;
  // Optional second line (e.g. file path under a diff snippet).
  detail?: string;
};

function summarizePermission(p: PendingPermission): PermissionSummary {
  const input = (p.toolInput ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string =>
    typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);

  switch (p.toolName) {
    case "Bash":
    case "PowerShell":
      return { badge: p.toolName, kind: "command", body: str(input.command) };
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return {
        badge: p.toolName,
        kind: "path",
        body: str(input.file_path ?? input.path ?? input.notebook_path),
      };
    case "WebFetch":
      return { badge: "WebFetch", kind: "url", body: str(input.url) };
    case "WebSearch":
      return { badge: "WebSearch", kind: "raw", body: str(input.query) };
    case "ExitPlanMode":
      return { badge: "Plan ready", kind: "plan", body: str(input.plan) };
    case "Agent":
    case "Task": {
      const subagent = str(input.subagent_type) || "agent";
      const desc = str(input.description) || str(input.prompt);
      return { badge: `Agent · ${subagent}`, kind: "raw", body: desc };
    }
    default: {
      // mcp__server__tool gets split for readability; everything else falls
      // through to the same "tool + JSON args" rendering.
      if (p.toolName.startsWith("mcp__")) {
        const parts = p.toolName.split("__");
        const server = parts[1] ?? "?";
        const tool = parts.slice(2).join("__") || "?";
        return {
          badge: `MCP · ${server}`,
          kind: "raw",
          body: `${tool}(${JSON.stringify(input)})`,
        };
      }
      return {
        badge: p.toolName,
        kind: "raw",
        body: JSON.stringify(input),
      };
    }
  }
}

function PermissionCard({ pending }: { pending: PendingPermission }) {
  const summary = summarizePermission(pending);
  const [expanded, setExpanded] = useState(false);
  const tooLong =
    summary.kind !== "plan" && summary.body.length > PERMISSION_CARD_MAX;
  const display =
    tooLong && !expanded
      ? summary.body.slice(0, PERMISSION_CARD_MAX) + "…"
      : summary.body;

  return (
    <div className={`perm-card perm-${summary.kind}`} role="region" aria-label="Pending permission">
      <div className="perm-card-head">
        <span className="perm-card-label">permission</span>
        <span className="perm-card-badge">{summary.badge}</span>
      </div>
      <pre
        className="perm-card-body"
        style={
          summary.kind === "plan"
            ? { maxHeight: PLAN_CARD_MAX_HEIGHT, overflow: "auto" }
            : undefined
        }
      >
        {display}
      </pre>
      {summary.detail && <div className="perm-card-detail">{summary.detail}</div>}
      {tooLong && (
        <button
          type="button"
          className="perm-card-more"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "show less" : `show full (${summary.body.length} chars)`}
        </button>
      )}
    </div>
  );
}
