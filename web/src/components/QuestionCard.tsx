import { useEffect, useMemo, useState } from "react";
import type { AskQuestion, SendBody } from "../lib/protocol";
import {
  formatAskAnswerText,
  formatAskKeySequence,
  isAskAnswerComplete,
  OTHER_SENTINEL,
} from "../lib/promptFormat";
import { SendIcon } from "./icons";

// Design's centerpiece question card. Hosts the AskUserQuestion form in the
// dock above the composer.
//
// The protocol carries N questions (1–4) each with M options (2–4). The
// design treats this as a 4-option single-select with a 2-column grid, so
// when there are multiple questions we render them one after another inside
// the same card. Keyboard 1–4 picks the focused question's option; ⌘↵ sends.
export function QuestionCard({
  questions,
  busy,
  onSend,
}: {
  questions: AskQuestion[];
  busy: boolean;
  onSend: (body: SendBody) => Promise<void>;
}) {
  const initial = useMemo(
    () => ({
      selections: questions.map(() => [] as string[]),
      others: questions.map(() => ""),
    }),
    [questions],
  );
  const [selections, setSelections] = useState<string[][]>(initial.selections);
  const [others, setOthers] = useState<string[]>(initial.others);
  const [submitting, setSubmitting] = useState(false);
  const [otherOpenFor, setOtherOpenFor] = useState<number | null>(null);

  useEffect(() => {
    setSelections(initial.selections);
    setOthers(initial.others);
    setOtherOpenFor(null);
  }, [initial]);

  const complete = useMemo(
    () => isAskAnswerComplete(questions, selections, others),
    [questions, selections, others],
  );

  const focusedQi = 0; // single-question is the common case; key shortcuts target the first question

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelections((prev) => {
      const cur = prev[qi] ?? [];
      const next = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label];
      const sels = [...prev];
      sels[qi] = next;
      return sels;
    });
  };

  const setOther = (qi: number, value: string) => {
    setOthers((prev) => {
      const next = [...prev];
      next[qi] = value;
      return next;
    });
  };

  const submit = async () => {
    if (!complete || submitting || busy) return;
    setSubmitting(true);
    try {
      const keys = formatAskKeySequence(questions, selections, others);
      if (keys) {
        for (const k of keys) await onSend({ key: k });
        return;
      }
      await onSend({ key: "Escape" });
      const text = formatAskAnswerText(questions, selections, others);
      await onSend({ text, submit: true });
    } finally {
      setSubmitting(false);
    }
  };

  // Keyboard shortcut: digit 1–4 picks an option on the first question,
  // Cmd/Ctrl + Enter sends.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (submitting || busy) return;
      // Ignore keys inside text inputs (the "Other" field's input).
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        }
        return;
      }
      const idx = "1234".indexOf(e.key);
      const q = questions[focusedQi];
      if (idx >= 0 && q && q.options[idx]) {
        toggle(focusedQi, q.options[idx].label, !!q.multiSelect);
        e.preventDefault();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        void onSend({ key: "Escape" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions, selections, others, busy, submitting]);

  const single = questions.length === 1;
  const primary = questions[0];

  return (
    <div className="question" data-screen-label="QuestionCard">
      <span className="q-tag">
        <span className="pulse"></span>
        {single ? "Claude is asking" : `Claude is asking · ${questions.length} questions`}
      </span>

      {questions.map((q, qi) => (
        <div key={qi} style={{ marginTop: qi === 0 ? 0 : 18 }}>
          {q.header && (
            <span
              style={{
                display: "inline-block",
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--accent)",
                marginTop: 8,
              }}
            >
              {q.header}
            </span>
          )}
          <div className="q-title">{q.question}</div>

          <div className="q-options" role={q.multiSelect ? "group" : "radiogroup"}>
            {q.options.map((opt, oi) => {
              const selected = (selections[qi] ?? []).includes(opt.label);
              return (
                <button
                  type="button"
                  key={oi}
                  role={q.multiSelect ? "checkbox" : "radio"}
                  aria-checked={selected}
                  className={`q-opt${selected ? " selected" : ""}`}
                  onClick={() => toggle(qi, opt.label, !!q.multiSelect)}
                  onDoubleClick={() => void submit()}
                >
                  <span className="key">{oi + 1}</span>
                  <span className="head">{opt.label}</span>
                  <span className="body">{opt.description ?? ""}</span>
                </button>
              );
            })}
            {/* Auto-injected Other row */}
            <OtherRow
              qi={qi}
              multi={!!q.multiSelect}
              selected={(selections[qi] ?? []).includes(OTHER_SENTINEL)}
              open={otherOpenFor === qi}
              value={others[qi] ?? ""}
              onToggle={() => {
                toggle(qi, OTHER_SENTINEL, !!q.multiSelect);
                setOtherOpenFor((prev) => (prev === qi ? null : qi));
              }}
              onChange={(v) => setOther(qi, v)}
            />
          </div>
        </div>
      ))}

      <div className="q-actions">
        {primary && (
          <>
            <span className="hint">
              <kbd>1</kbd>–<kbd>{Math.min(4, primary.options.length)}</kbd> to pick
            </span>
            <span className="hint">
              <kbd>⌘</kbd>
              <kbd>↵</kbd> to send
            </span>
          </>
        )}
        <span className="spc"></span>
        <button
          type="button"
          className="btn-custom"
          onClick={() => void onSend({ key: "Escape" })}
          disabled={busy}
          title="Cancel — send Escape to the TUI"
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => void submit()}
          disabled={!complete || submitting || busy}
        >
          {submitting ? "Sending…" : "Send answer"}
          <SendIcon />
        </button>
      </div>
    </div>
  );
}

function OtherRow({
  qi,
  multi,
  selected,
  open,
  value,
  onToggle,
  onChange,
}: {
  qi: number;
  multi: boolean;
  selected: boolean;
  open: boolean;
  value: string;
  onToggle: () => void;
  onChange: (v: string) => void;
}) {
  // Index after the last design option = 4 by convention; show as "5" if there.
  const expanded = open || selected;
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      className={`q-opt${selected ? " selected" : ""}`}
      onClick={onToggle}
      style={{ gridColumn: "1 / -1" }}
    >
      <span className="key">·</span>
      <span className="head">Other — write a custom reply…</span>
      {expanded && (
        <span className="body" onClick={(e) => e.stopPropagation()}>
          <input
            type="text"
            placeholder="Type your answer…"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => {
              if (!selected) onToggle();
            }}
            style={{
              marginTop: 4,
              width: "100%",
              padding: "8px 12px",
              borderRadius: 8,
              background: "var(--ink-0)",
              border: "1px solid var(--line)",
              color: "var(--fg-0)",
              fontFamily: "var(--mono)",
              fontSize: 12.5,
              outline: "none",
            }}
            aria-label={`Custom answer for question ${qi + 1}`}
          />
        </span>
      )}
    </button>
  );
}
