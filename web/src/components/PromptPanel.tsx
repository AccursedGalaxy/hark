import { useEffect, useMemo, useState } from "react";
import type {
  AskQuestion,
  AskQuestionOption,
  ElicitationField,
  Pending,
  SendBody,
  SessionError,
} from "../lib/protocol";
import {
  describeToolHeader,
  errorHint,
  formatAskAnswerText,
  formatElicitationText,
  isAskAnswerComplete,
  isElicitationComplete,
  OTHER_SENTINEL,
  prettyPath,
} from "../lib/promptFormat";
import { Markdown } from "./Markdown";

/**
 * The "Claude is waiting" surface that sits above the composer textarea.
 * Switches on the discriminated `pending.kind` so each prompt class gets a
 * tailored UI:
 *
 *  - `tool_permission`     → per-tool card (Bash command, Edit diff, …)
 *  - `ask_user_question`   → multi-question form with radio/checkbox/Other
 *  - `exit_plan_mode`      → markdown plan + three accept actions
 *  - `elicitation`         → MCP form (string/number/boolean/enum fields)
 *  - `oauth`               → "waiting on desktop" badge
 *
 * Each variant calls `onSend` with either a numbered key sequence (the
 * fast path that drives the TUI directly) or with `Escape` + a typed text
 * answer (for the structured AskUserQuestion / Elicitation widgets that
 * the TUI doesn't expose to scripted keystrokes). This is the path the
 * `prompts.md` doc recommends — it works today without depending on
 * undocumented HTTP-hook block-and-respond semantics.
 */
export function PromptPanel({
  pending,
  lastError,
  busy,
  onSend,
}: {
  pending: Pending | null;
  lastError?: SessionError | null;
  busy: boolean;
  onSend: (body: SendBody) => Promise<void>;
}) {
  if (!pending && !lastError) return null;

  return (
    <div className="prompt-panel" role="region" aria-label="Pending prompt">
      {lastError && <ErrorChip error={lastError} busy={busy} onSend={onSend} />}
      {pending?.kind === "tool_permission" && (
        <ToolPermissionCard
          toolName={pending.toolName}
          toolInput={pending.toolInput}
        />
      )}
      {pending?.kind === "ask_user_question" && (
        <AskUserQuestionForm
          questions={pending.questions}
          busy={busy}
          onSend={onSend}
        />
      )}
      {pending?.kind === "exit_plan_mode" && (
        <PlanModeView plan={pending.plan} busy={busy} onSend={onSend} />
      )}
      {pending?.kind === "elicitation" && (
        <ElicitationForm
          serverName={pending.serverName}
          message={pending.message}
          fields={pending.fields}
          busy={busy}
          onSend={onSend}
        />
      )}
      {pending?.kind === "oauth" && <OAuthBadge message={pending.message} />}
    </div>
  );
}

// ---- Per-tool permission card (0.1) ---------------------------------------

const TOOL_CARD_BODY_MAX = 600;

function toolBody(toolName: string, toolInput: unknown): React.ReactNode {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string =>
    typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);

  switch (toolName) {
    case "Bash":
    case "PowerShell": {
      const cmd = str(input.command);
      const desc = str(input.description);
      return (
        <>
          <CodeBlock prompt="$" text={cmd} variant="shell" />
          {desc && <div className="tool-desc">{desc}</div>}
        </>
      );
    }
    case "Edit":
    case "NotebookEdit": {
      const file = str(input.file_path ?? input.notebook_path ?? input.path);
      const oldStr = str(input.old_string);
      const newStr = str(input.new_string);
      const showDiff = oldStr.length > 0 || newStr.length > 0;
      return (
        <>
          {file && <PathRow path={file} />}
          {showDiff && <DiffPreview oldText={oldStr} newText={newStr} />}
        </>
      );
    }
    case "Write": {
      const file = str(input.file_path ?? input.path);
      const content = str(input.content);
      return (
        <>
          {file && <PathRow path={file} />}
          {content && (
            <CodeBlock text={content} variant="code" maxLines={20} />
          )}
        </>
      );
    }
    case "Read": {
      const file = str(input.file_path ?? input.path);
      return file ? <PathRow path={file} /> : null;
    }
    case "WebFetch": {
      const url = str(input.url);
      const prompt = str(input.prompt);
      return (
        <>
          {url && <UrlRow url={url} />}
          {prompt && <div className="tool-desc">{prompt}</div>}
        </>
      );
    }
    case "WebSearch": {
      const q = str(input.query);
      return (
        <div className="tool-query">
          <SearchIcon />
          <span>{q || "(no query)"}</span>
        </div>
      );
    }
    case "Agent":
    case "Task": {
      const desc = str(input.description);
      const prompt = str(input.prompt);
      return (
        <>
          {desc && <div className="tool-desc strong">{desc}</div>}
          {prompt && (
            <CodeBlock text={prompt} variant="prose" maxLines={6} />
          )}
        </>
      );
    }
    default:
      return <JsonTree value={toolInput} />;
  }
}

function ToolPermissionCard({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput: unknown;
}) {
  const header = describeToolHeader(toolName, toolInput);
  return (
    <section className={`pp-card pp-tone-${header.tone}`} role="group">
      <header className="pp-card-head">
        <span className="pp-card-eyebrow">permission</span>
        <span className="pp-card-badge">{header.badge}</span>
        {header.badgeDetail && (
          <span className="pp-card-detail" title={header.badgeDetail}>
            {header.badgeDetail}
          </span>
        )}
        {header.hint && <span className="pp-card-hint">{header.hint}</span>}
      </header>
      <div className="pp-card-body">{toolBody(toolName, toolInput)}</div>
    </section>
  );
}

// ---- AskUserQuestion (0.2) ------------------------------------------------

interface AskState {
  // For each question (indexed): selected labels (or OTHER_SENTINEL) plus
  // the user's free-text "Other" entry. Multi-select questions hold many
  // labels; single-select hold one.
  selections: string[][];
  others: string[];
}

function AskUserQuestionForm({
  questions,
  busy,
  onSend,
}: {
  questions: AskQuestion[];
  busy: boolean;
  onSend: (body: SendBody) => Promise<void>;
}) {
  const initial = useMemo<AskState>(
    () => ({
      selections: questions.map(() => []),
      others: questions.map(() => ""),
    }),
    [questions],
  );
  const [state, setState] = useState<AskState>(initial);
  const [submitting, setSubmitting] = useState(false);

  // Reset state when the underlying questions change identity (a new
  // prompt arrived). Without this the form would carry over stale picks.
  useEffect(() => setState(initial), [initial]);

  const complete = useMemo(
    () => isAskAnswerComplete(questions, state.selections, state.others),
    [questions, state],
  );

  const toggle = (qi: number, label: string, multi: boolean) => {
    setState((prev) => {
      const cur = prev.selections[qi] ?? [];
      const next = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label];
      const sels = [...prev.selections];
      sels[qi] = next;
      return { ...prev, selections: sels };
    });
  };

  const setOther = (qi: number, value: string) => {
    setState((prev) => {
      const others = [...prev.others];
      others[qi] = value;
      return { ...prev, others };
    });
  };

  // Format the answers for Claude. We send Escape first to dismiss the
  // TUI widget, then a clean text message. Each question gets a leading
  // header so Claude can map answer → question unambiguously. Multi-select
  // joins with ", "; "Other" expands to the user's free text.
  const submit = async () => {
    if (!complete || submitting || busy) return;
    setSubmitting(true);
    try {
      await onSend({ key: "Escape" });
      const text = formatAskAnswerText(
        questions,
        state.selections,
        state.others,
      );
      await onSend({ text, submit: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="pp-card pp-tone-question" role="group">
      <header className="pp-card-head">
        <span className="pp-card-eyebrow">question</span>
        <span className="pp-card-badge">
          {questions.length === 1
            ? "1 question"
            : `${questions.length} questions`}
        </span>
      </header>
      <div className="pp-card-body">
        <ol className="pp-questions">
          {questions.map((q, qi) => (
            <li className="pp-question" key={qi}>
              {q.header && (
                <span className="pp-question-chip">{q.header}</span>
              )}
              <p className="pp-question-text">{q.question}</p>
              <ul className="pp-options" role={q.multiSelect ? "group" : "radiogroup"}>
                {q.options.map((opt, oi) => (
                  <OptionRow
                    key={oi}
                    qi={qi}
                    multi={!!q.multiSelect}
                    option={opt}
                    selected={(state.selections[qi] ?? []).includes(opt.label)}
                    onToggle={() =>
                      toggle(qi, opt.label, !!q.multiSelect)
                    }
                  />
                ))}
                <OtherRow
                  qi={qi}
                  multi={!!q.multiSelect}
                  selected={(state.selections[qi] ?? []).includes(
                    OTHER_SENTINEL,
                  )}
                  value={state.others[qi] ?? ""}
                  onToggle={() =>
                    toggle(qi, OTHER_SENTINEL, !!q.multiSelect)
                  }
                  onChange={(v) => setOther(qi, v)}
                />
              </ul>
            </li>
          ))}
        </ol>
        <div className="pp-actions">
          <button
            type="button"
            className="btn btn-approve"
            disabled={!complete || submitting || busy}
            onClick={() => void submit()}
          >
            {submitting ? "Sending…" : "Submit answer"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || submitting}
            onClick={() => void onSend({ key: "Escape" })}
          >
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

function OptionRow({
  qi,
  multi,
  option,
  selected,
  onToggle,
}: {
  qi: number;
  multi: boolean;
  option: AskQuestionOption;
  selected: boolean;
  onToggle: () => void;
}) {
  const id = `pp-opt-${qi}-${option.label.replace(/\W+/g, "_")}`;
  return (
    <li className={`pp-option ${selected ? "is-selected" : ""}`}>
      <label htmlFor={id}>
        <input
          id={id}
          type={multi ? "checkbox" : "radio"}
          name={multi ? id : `pp-q-${qi}`}
          checked={selected}
          onChange={onToggle}
        />
        <span className="pp-option-body">
          <span className="pp-option-label">{option.label}</span>
          {option.description && (
            <span className="pp-option-desc">{option.description}</span>
          )}
          {option.preview && (
            <span className="pp-option-preview">
              <Markdown source={option.preview} tight />
            </span>
          )}
        </span>
      </label>
    </li>
  );
}

function OtherRow({
  qi,
  multi,
  selected,
  value,
  onToggle,
  onChange,
}: {
  qi: number;
  multi: boolean;
  selected: boolean;
  value: string;
  onToggle: () => void;
  onChange: (v: string) => void;
}) {
  const id = `pp-opt-${qi}-other`;
  return (
    <li className={`pp-option pp-option-other ${selected ? "is-selected" : ""}`}>
      <label htmlFor={id}>
        <input
          id={id}
          type={multi ? "checkbox" : "radio"}
          name={multi ? id : `pp-q-${qi}`}
          checked={selected}
          onChange={onToggle}
        />
        <span className="pp-option-body">
          <span className="pp-option-label">Other</span>
          <input
            type="text"
            className="pp-other-input"
            placeholder="Type a custom answer…"
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              if (!selected) onToggle();
            }}
            onFocus={() => {
              if (!selected) onToggle();
            }}
          />
        </span>
      </label>
    </li>
  );
}

// ---- ExitPlanMode (0.3) ---------------------------------------------------

function PlanModeView({
  plan,
  busy,
  onSend,
}: {
  plan: string;
  busy: boolean;
  onSend: (body: SendBody) => Promise<void>;
}) {
  const sendSequence = async (keys: string[]) => {
    for (const k of keys) await onSend({ key: k });
  };
  return (
    <section className="pp-card pp-tone-plan" role="group">
      <header className="pp-card-head">
        <span className="pp-card-eyebrow">plan ready</span>
        <span className="pp-card-badge">ExitPlanMode</span>
      </header>
      <div className="pp-card-body pp-plan-scroll">
        <Markdown source={plan} tight />
      </div>
      <div className="pp-actions">
        <button
          type="button"
          className="btn btn-approve"
          disabled={busy}
          onClick={() => void sendSequence(["1", "Enter"])}
          title="Accept the plan and auto-accept all subsequent edits"
        >
          Accept · auto-edit
        </button>
        <button
          type="button"
          className="btn btn-approve btn-approve-soft"
          disabled={busy}
          onClick={() => void sendSequence(["2", "Enter"])}
          title="Accept the plan but review each edit"
        >
          Accept · review each
        </button>
        <button
          type="button"
          className="btn btn-deny"
          disabled={busy}
          onClick={() => void sendSequence(["3", "Enter"])}
          title="Reject — keep planning"
        >
          Keep planning
        </button>
      </div>
    </section>
  );
}

// ---- Elicitation (0.4) ----------------------------------------------------

function ElicitationForm({
  serverName,
  message,
  fields,
  busy,
  onSend,
}: {
  serverName: string;
  message?: string;
  fields: ElicitationField[];
  busy: boolean;
  onSend: (body: SendBody) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setValues({}), [fields]);

  const setField = (name: string, value: string) =>
    setValues((p) => ({ ...p, [name]: value }));

  const complete = isElicitationComplete(fields, values);

  // No usable form structure → tell the user to handle it on the desktop.
  if (fields.length === 0) {
    return (
      <section className="pp-card pp-tone-question" role="group">
        <header className="pp-card-head">
          <span className="pp-card-eyebrow">form requested</span>
          <span className="pp-card-badge">{serverName}</span>
        </header>
        <div className="pp-card-body">
          <p className="pp-empty">
            {message ??
              `${serverName} is requesting a structured response. Open the desktop TUI to complete it.`}
          </p>
          <div className="pp-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void onSend({ key: "Escape" })}
            >
              Cancel
            </button>
          </div>
        </div>
      </section>
    );
  }

  const submit = async () => {
    if (!complete || submitting || busy) return;
    setSubmitting(true);
    try {
      await onSend({ key: "Escape" });
      await onSend({
        text: formatElicitationText(fields, values),
        submit: true,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="pp-card pp-tone-question" role="group">
      <header className="pp-card-head">
        <span className="pp-card-eyebrow">form requested</span>
        <span className="pp-card-badge">{serverName}</span>
      </header>
      <div className="pp-card-body">
        {message && <p className="pp-question-text">{message}</p>}
        <div className="pp-fields">
          {fields.map((f) => (
            <ElicField
              key={f.name}
              field={f}
              value={values[f.name] ?? ""}
              onChange={(v) => setField(f.name, v)}
            />
          ))}
        </div>
        <div className="pp-actions">
          <button
            type="button"
            className="btn btn-approve"
            disabled={!complete || submitting || busy}
            onClick={() => void submit()}
          >
            {submitting ? "Sending…" : "Accept"}
          </button>
          <button
            type="button"
            className="btn btn-deny"
            disabled={busy || submitting}
            onClick={() => void onSend({ key: "Escape" })}
          >
            Decline
          </button>
        </div>
      </div>
    </section>
  );
}

function ElicField({
  field,
  value,
  onChange,
}: {
  field: ElicitationField;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = `pp-fld-${field.name}`;
  const common = {
    id,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      onChange(e.target.value),
  };
  return (
    <div className="pp-field">
      <label htmlFor={id}>
        <span className="pp-field-label">
          {field.name}
          {field.required && <span className="pp-field-req"> *</span>}
        </span>
        {field.description && (
          <span className="pp-field-desc">{field.description}</span>
        )}
        {field.type === "boolean" ? (
          <select
            {...common}
            onChange={(e) => onChange(e.target.value)}
            className="pp-field-input"
          >
            <option value="">—</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : field.type === "enum" && (field.options?.length ?? 0) > 0 ? (
          <select {...common} className="pp-field-input">
            <option value="">—</option>
            {field.options!.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <input
            {...common}
            type={field.type === "number" ? "number" : "text"}
            className="pp-field-input"
            placeholder={
              field.type === "number"
                ? "0"
                : field.type === "string"
                  ? "value"
                  : field.type
            }
          />
        )}
      </label>
    </div>
  );
}

// ---- OAuth badge (0.5) ----------------------------------------------------

function OAuthBadge({ message }: { message: string }) {
  return (
    <section className="pp-card pp-tone-oauth" role="group">
      <header className="pp-card-head">
        <span className="pp-card-eyebrow">auth required</span>
        <span className="pp-card-badge">OAuth</span>
      </header>
      <div className="pp-card-body">
        <p className="pp-empty">{message}</p>
      </div>
    </section>
  );
}

// ---- Error chip (Tier 1.2) -------------------------------------------------

function ErrorChip({
  error,
  busy,
  onSend,
}: {
  error: SessionError;
  busy: boolean;
  onSend: (body: SendBody) => Promise<void>;
}) {
  const hint = errorHint(error.errorType);
  return (
    <section className="pp-card pp-tone-error" role="alert">
      <header className="pp-card-head">
        <span className="pp-card-eyebrow">error</span>
        <span className="pp-card-badge">{error.errorType}</span>
        <span className="pp-card-detail">{hint}</span>
      </header>
      {error.errorMessage && (
        <div className="pp-card-body">
          <pre className="pp-error-body">{error.errorMessage}</pre>
        </div>
      )}
      <div className="pp-actions">
        <button
          type="button"
          className="btn btn-approve"
          disabled={busy}
          title="Retry the turn"
          onClick={() => void onSend({ text: "continue", submit: true })}
        >
          Retry
        </button>
      </div>
    </section>
  );
}

// ---- Shared atoms --------------------------------------------------------

function PathRow({ path }: { path: string }) {
  return (
    <div className="pp-path">
      <FileIcon />
      <code title={path}>{prettyPath(path)}</code>
    </div>
  );
}

function UrlRow({ url }: { url: string }) {
  return (
    <div className="pp-url">
      <GlobeIcon />
      <a href={url} rel="noreferrer" target="_blank">
        {url}
      </a>
    </div>
  );
}

function CodeBlock({
  text,
  prompt,
  variant,
  maxLines,
}: {
  text: string;
  prompt?: string;
  variant: "shell" | "code" | "prose";
  maxLines?: number;
}) {
  const lines = text.split("\n");
  const tooLong =
    (maxLines && lines.length > maxLines) || text.length > TOOL_CARD_BODY_MAX;
  const [expanded, setExpanded] = useState(false);
  const display =
    tooLong && !expanded && maxLines
      ? lines.slice(0, maxLines).join("\n")
      : text.length > TOOL_CARD_BODY_MAX && !expanded
        ? text.slice(0, TOOL_CARD_BODY_MAX)
        : text;
  return (
    <div className={`pp-codeblock variant-${variant}`}>
      <pre>
        {prompt && <span className="pp-codeblock-prompt">{prompt} </span>}
        {display}
        {tooLong && !expanded && "…"}
      </pre>
      {tooLong && (
        <button
          type="button"
          className="pp-more"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? "show less"
            : `show full (${lines.length} lines, ${text.length} chars)`}
        </button>
      )}
    </div>
  );
}

function DiffPreview({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText.split("\n").slice(0, 12);
  const newLines = newText.split("\n").slice(0, 12);
  return (
    <div className="pp-diff">
      {oldLines.length > 0 && (
        <div className="pp-diff-side">
          <div className="pp-diff-head">−</div>
          <pre>{oldLines.join("\n")}</pre>
        </div>
      )}
      {newLines.length > 0 && (
        <div className="pp-diff-side">
          <div className="pp-diff-head">+</div>
          <pre>{newLines.join("\n")}</pre>
        </div>
      )}
    </div>
  );
}

function JsonTree({ value }: { value: unknown }) {
  let pretty: string;
  try {
    pretty = JSON.stringify(value, null, 2) ?? "";
  } catch {
    pretty = String(value);
  }
  return <CodeBlock text={pretty} variant="code" maxLines={20} />;
}

// ---- Icons --------------------------------------------------------------

function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9 1.5H4a1.5 1.5 0 00-1.5 1.5v10A1.5 1.5 0 004 14.5h8a1.5 1.5 0 001.5-1.5V6L9 1.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M9 1.5V6h4.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M10 10l3 3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
