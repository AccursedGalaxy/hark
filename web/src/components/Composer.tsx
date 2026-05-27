import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import type {
  Pending,
  PromptKind,
  SendBody,
  SessionError,
  SlashCommand,
  UploadedFile,
} from "../lib/protocol";
import { useSlashMenu } from "../lib/slashMenu";
import { fetchSlashCommands } from "../lib/transport";
import {
  AttachIcon,
  CameraIcon,
  ChevIcon,
  ClipIcon,
  CloseIcon,
  FileIcon,
  PhotoIcon,
  QuestionIcon,
  SendIcon,
  SparkIcon,
  TermIcon,
  TextIcon,
} from "./icons";
import { PromptPanel } from "./PromptPanel";
import { QuestionCard } from "./QuestionCard";
import { SlashCommandMenu } from "./SlashCommandMenu";

const PROMPT_LABEL: Record<Exclude<PromptKind, null>, string> = {
  permission: "permission requested",
  elicitation: "form input requested",
  idle: "awaiting your reply",
};

const PASTE_FILE_THRESHOLD = 4000;

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

interface PendingUpload {
  id: string;
  name: string;
  size: number;
  mime: string;
  loaded: number;
  total: number;
  previewUrl?: string;
}

interface Attachment extends UploadedFile {
  id: string;
  previewUrl?: string;
}

export function Composer({
  disabled,
  disabledReason,
  errorMessage,
  promptKind,
  pending,
  lastError,
  cwd,
  onSend,
  onUpload,
}: {
  disabled: boolean;
  disabledReason?: string;
  errorMessage: string | null;
  promptKind: PromptKind;
  pending: Pending | null;
  lastError: SessionError | null;
  cwd?: string;
  onSend: (body: SendBody) => Promise<void>;
  onUpload: (
    files: File[],
    onProgress?: (loaded: number, total: number) => void,
  ) => Promise<UploadedFile[]>;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pasteFilePrompt, setPasteFilePrompt] = useState<string | null>(null);
  const [pasteAsFileOpen, setPasteAsFileOpen] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[] | null>(null);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const attachWrapRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const kbInset = useKeyboardInset();

  // Pending kinds that have their own focused dock above the composer.
  const isQuestion = pending?.kind === "ask_user_question";
  // Whether the textarea is locked because a question / form is up.
  const lockedByQuestion = isQuestion;
  // Rich panel (per-tool permission card, plan mode, elicitation, oauth,
  // error chip). Question card has its own dock instead.
  const showRichPanel =
    !disabled &&
    !isQuestion &&
    (pending !== null || lastError !== null);
  const showApproveDeny =
    !lockedByQuestion &&
    promptKind === "permission" &&
    (pending === null || pending?.kind === "tool_permission");
  const showInteractiveTools =
    !disabled && !lockedByQuestion && promptKind !== null;
  const autoOpenKeypad =
    !lockedByQuestion &&
    (promptKind === "permission" || promptKind === "elicitation");

  useEffect(() => {
    if (autoOpenKeypad) setKeypadOpen(true);
  }, [autoOpenKeypad]);
  useEffect(() => {
    if (!showInteractiveTools) setKeypadOpen(false);
  }, [showInteractiveTools]);

  useEffect(() => {
    if (!attachMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!attachWrapRef.current?.contains(e.target as Node)) {
        setAttachMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [attachMenuOpen]);

  useEffect(() => {
    return () => {
      for (const a of attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      for (const u of uploads) if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [text]);

  const commitSlashEdit = useCallback(
    (next: { text: string; caret: number }) => {
      setText(next.text);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(next.caret, next.caret);
        setCaret(next.caret);
      });
    },
    [],
  );

  const slashMenu = useSlashMenu({
    text,
    caret,
    allCommands: slashCommands,
    enabled: !disabled,
    onCommit: commitSlashEdit,
  });

  const hasSlashTrigger = !!slashMenu.trigger && !disabled;
  useEffect(() => {
    if (!hasSlashTrigger) return;
    if (slashCommands !== null) return;
    if (!cwd) {
      setSlashCommands([]);
      return;
    }
    let cancelled = false;
    fetchSlashCommands(cwd)
      .then((cmds) => {
        if (!cancelled) setSlashCommands(cmds);
      })
      .catch(() => {
        if (!cancelled) setSlashCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [hasSlashTrigger, slashCommands, cwd]);

  const updateCaret = useCallback(() => {
    const ta = taRef.current;
    if (ta) setCaret(ta.selectionStart);
  }, []);

  // ---- Uploads ----------------------------------------------------------

  const startUpload = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || disabled) return;
      setUploadError(null);
      const pendingArr: PendingUpload[] = files.map((f) => ({
        id: `pu-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: f.name || "file",
        size: f.size,
        mime: f.type || "application/octet-stream",
        loaded: 0,
        total: f.size,
        previewUrl: f.type.startsWith("image/")
          ? URL.createObjectURL(f)
          : undefined,
      }));
      setUploads((prev) => [...prev, ...pendingArr]);
      const total = files.reduce((a, f) => a + f.size, 0);
      try {
        const uploaded = await onUpload(files, (loaded) => {
          const ratio = total > 0 ? loaded / total : 1;
          setUploads((prev) =>
            prev.map((p) =>
              pendingArr.some((q) => q.id === p.id)
                ? { ...p, loaded: Math.round(p.total * ratio) }
                : p,
            ),
          );
        });
        setUploads((prev) =>
          prev.filter((p) => !pendingArr.some((q) => q.id === p.id)),
        );
        setAttachments((prev) => [
          ...prev,
          ...uploaded.map((u, i) => ({
            ...u,
            id: pendingArr[i]?.id ?? `at-${Date.now()}-${i}`,
            previewUrl: pendingArr[i]?.previewUrl,
          })),
        ]);
      } catch (err) {
        setUploads((prev) =>
          prev.filter((p) => !pendingArr.some((q) => q.id === p.id)),
        );
        for (const p of pendingArr) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
        setUploadError(err instanceof Error ? err.message : "upload failed");
        setTimeout(() => setUploadError(null), 4000);
      }
    },
    [disabled, onUpload],
  );

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  };

  const pickFiles = () => {
    setAttachMenuOpen(false);
    fileInputRef.current?.click();
  };
  const pickPhotos = () => {
    setAttachMenuOpen(false);
    photoInputRef.current?.click();
  };
  const openCamera = () => {
    setAttachMenuOpen(false);
    cameraInputRef.current?.click();
  };
  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    e.target.value = "";
    void startUpload(files);
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (disabled || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (disabled || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) void startUpload(files);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      void startUpload(files);
      return;
    }
    const pasted = e.clipboardData.getData("text");
    if (pasted.length >= PASTE_FILE_THRESHOLD) {
      setPasteFilePrompt(pasted);
    }
  };

  const convertPasteToFile = useCallback(async () => {
    const content = pasteFilePrompt;
    if (!content) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = new File([content], `paste-${stamp}.txt`, {
      type: "text/plain",
    });
    setText((t) => t.replace(content, "").trim());
    setPasteFilePrompt(null);
    await startUpload([file]);
  }, [pasteFilePrompt, startUpload]);

  const canSend =
    !disabled &&
    !lockedByQuestion &&
    !busy &&
    uploads.length === 0 &&
    (text.trim().length > 0 || attachments.length > 0);

  const submitText = async () => {
    if (!canSend) return;
    const t = text;
    const atts = attachments.map((a) => a.path);
    setBusy(true);
    try {
      await onSend({ text: t, attachments: atts });
      setText("");
      for (const a of attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      setAttachments([]);
      setPasteFilePrompt(null);
    } catch {
      /* errorMessage surfaces it */
    } finally {
      setBusy(false);
    }
  };

  const sendKeySequence = async (keys: string[]) => {
    if (disabled || busy) return;
    setBusy(true);
    try {
      for (const k of keys) await onSend({ key: k });
    } catch {
      /* errorMessage surfaces it */
    } finally {
      setBusy(false);
    }
  };

  const sendKey = (k: string) => sendKeySequence([k]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    noteKeyForHardwareDetection(e);
    if (slashMenu.onKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey && shouldSendOnEnter()) {
      e.preventDefault();
      void submitText();
    }
  };

  const allChips: Array<
    | { kind: "attachment"; a: Attachment }
    | { kind: "upload"; u: PendingUpload }
  > = [
    ...attachments.map((a) => ({ kind: "attachment" as const, a })),
    ...uploads.map((u) => ({ kind: "upload" as const, u })),
  ];

  const placeholderText = disabled
    ? (disabledReason ?? "Disabled")
    : lockedByQuestion
      ? "Answer the question above to continue…"
      : "Reply, or describe what to do next…";

  return (
    <div
      className={`composer-wrap ${disabled ? "is-disabled" : ""} ${
        dragging ? "is-dragover" : ""
      }`}
      style={{ paddingBottom: kbInset ? kbInset + 18 : undefined }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="composer-drop" role="status">
          <ClipIcon />
          <span>Drop files to attach</span>
        </div>
      )}

      {/* Question dock — separate from the composer so the prompt sits as
          its own focused interaction above the textarea. */}
      {isQuestion && pending?.kind === "ask_user_question" && (
        <div
          className="question-dock"
          data-screen-label="QuestionDock"
          style={{ paddingBottom: 0, marginTop: -14 }}
        >
          <QuestionCard
            questions={pending.questions}
            busy={busy}
            onSend={onSend}
          />
        </div>
      )}

      {(errorMessage || uploadError) && (
        <div className="composer-error" role="status">
          {errorMessage || uploadError}
        </div>
      )}

      <div className={`composer ${disabled ? "is-disabled" : ""}`}>
        <div className="composer-top">
          <div className="composer-attach" ref={attachWrapRef}>
            <button
              type="button"
              className="chip"
              title="Attach files"
              aria-label="Attach files"
              aria-expanded={attachMenuOpen}
              disabled={disabled}
              onClick={() => setAttachMenuOpen((v) => !v)}
            >
              <AttachIcon /> Attach
            </button>
            {attachMenuOpen && (
              <div className="composer-attach-menu" role="menu">
                {isTouch() && (
                  <button
                    type="button"
                    className="composer-attach-item"
                    role="menuitem"
                    onClick={openCamera}
                  >
                    <CameraIcon />
                    <span>Take photo</span>
                  </button>
                )}
                <button
                  type="button"
                  className="composer-attach-item"
                  role="menuitem"
                  onClick={pickPhotos}
                >
                  <PhotoIcon />
                  <span>{isTouch() ? "Photo library" : "Photo"}</span>
                </button>
                <button
                  type="button"
                  className="composer-attach-item"
                  role="menuitem"
                  onClick={pickFiles}
                >
                  <FileIcon />
                  <span>File</span>
                </button>
                <button
                  type="button"
                  className="composer-attach-item"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    setPasteAsFileOpen(true);
                  }}
                >
                  <TextIcon />
                  <span>Paste as file…</span>
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="chip"
            title="Insert @file"
            disabled={disabled}
            onClick={() => {
              const ta = taRef.current;
              if (!ta) return;
              ta.focus();
              const before = text.slice(0, caret);
              const after = text.slice(caret);
              const next = before + "@" + after;
              setText(next);
              requestAnimationFrame(() => {
                ta.setSelectionRange(caret + 1, caret + 1);
                setCaret(caret + 1);
              });
            }}
          >
            <SparkIcon /> @file
          </button>
          <button
            type="button"
            className="chip"
            title="Insert /slash command"
            disabled={disabled}
            onClick={() => {
              const ta = taRef.current;
              if (!ta) return;
              ta.focus();
              const before = text.slice(0, caret);
              const after = text.slice(caret);
              const insert = before.endsWith("/") ? "" : "/";
              const next = before + insert + after;
              setText(next);
              requestAnimationFrame(() => {
                ta.setSelectionRange(caret + insert.length, caret + insert.length);
                setCaret(caret + insert.length);
              });
            }}
          >
            <TermIcon /> /run
          </button>
          {showInteractiveTools && (
            <button
              type="button"
              className={"chip warn" + (keypadOpen ? " is-active" : "")}
              title="Toggle raw key pad"
              aria-expanded={keypadOpen}
              onClick={() => setKeypadOpen((v) => !v)}
            >
              <QuestionIcon /> Keys
              <ChevIcon />
            </button>
          )}
          <span style={{ flex: 1 }} />
          <span
            className={`chip ${disabled ? "dead" : promptKind ? "warn" : "live"}`}
            style={{ cursor: "default" }}
          >
            <span
              className="dot"
              style={{ width: 6, height: 6, marginRight: 4 }}
            />
            {disabled ? "disconnected" : promptKind ? PROMPT_LABEL[promptKind] : "connected"}
          </span>
        </div>

        {showRichPanel && (
          <PromptPanel
            pending={pending}
            lastError={lastError}
            busy={busy}
            onSend={onSend}
          />
        )}

        {allChips.length > 0 && (
          <div className="composer-attachments" role="list" aria-label="Attachments">
            {allChips.map((c) =>
              c.kind === "attachment" ? (
                <AttachmentChip
                  key={c.a.id}
                  attachment={c.a}
                  onRemove={() => removeAttachment(c.a.id)}
                />
              ) : (
                <UploadingChip key={c.u.id} upload={c.u} />
              ),
            )}
          </div>
        )}

        {pasteFilePrompt && (
          <div className="composer-paste-prompt" role="status">
            <span>
              Long paste ({pasteFilePrompt.length.toLocaleString()} chars). Send
              as file?
            </span>
            <div className="composer-paste-prompt-actions">
              <button
                type="button"
                className="btn primary"
                onClick={() => void convertPasteToFile()}
              >
                Save as file
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setPasteFilePrompt(null)}
              >
                Keep inline
              </button>
            </div>
          </div>
        )}

        <div className="composer-input">
          {/* Hidden file inputs */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={onFileInput}
            aria-hidden="true"
          />
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={onFileInput}
            aria-hidden="true"
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={onFileInput}
            aria-hidden="true"
          />

          {slashMenu.open && (
            <SlashCommandMenu
              commands={slashMenu.filtered}
              highlight={slashMenu.highlight}
              onSelect={slashMenu.pick}
              onHover={slashMenu.setHighlight}
            />
          )}
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            placeholder={placeholderText}
            disabled={disabled || lockedByQuestion}
            // Hint to iOS / Android soft keyboards: show a "send"-style
            // return key. Doesn't change our hardware-keyboard Enter
            // handling, just relabels the on-screen key.
            enterKeyHint="send"
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onKeyUp={updateCaret}
            onClick={updateCaret}
            onSelect={updateCaret}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            aria-label="Message"
          />
          <button
            type="button"
            className="send"
            // preventDefault on pointerdown keeps focus on the textarea
            // through the tap. Without this, iOS PWA (Add to Home Screen)
            // blurs the textarea, the soft keyboard collapses, the layout
            // shifts, and the subsequent click never lands on Send.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => void submitText()}
            disabled={!canSend}
            title={uploads.length > 0 ? "Waiting for upload…" : "Send (Enter)"}
            aria-label="Send"
          >
            <SendIcon />
          </button>
        </div>

        {showApproveDeny && (
          <div className="composer-actions">
            <div className="composer-actions-primary">
              <button
                type="button"
                className="btn primary"
                title="Send '1' then Enter (approve)"
                onClick={() => void sendKeySequence(["1", "Enter"])}
                disabled={disabled || busy}
              >
                Approve
              </button>
              <button
                type="button"
                className="btn danger"
                title="Send '2' then Enter (deny)"
                onClick={() => void sendKeySequence(["2", "Enter"])}
                disabled={disabled || busy}
              >
                Deny
              </button>
            </div>
            <div className="composer-actions-secondary">
              <button
                type="button"
                className="btn ghost btn-sm"
                title="Send Escape"
                onClick={() => void sendKeySequence(["Escape"])}
                disabled={busy}
              >
                Esc
              </button>
            </div>
          </div>
        )}

        {keypadOpen && showInteractiveTools && (
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

        <div className="composer-foot">
          <span>{disabled ? disabledReason ?? "Disabled" : "Claude Code · interactive"}</span>
          <span className="spc" />
          <span>
            <kbd>↵</kbd> send · <kbd>⇧</kbd>
            <kbd>↵</kbd> newline · <kbd>/</kbd> commands
          </span>
        </div>
      </div>

      {pasteAsFileOpen && (
        <PasteAsFileDialog
          onCancel={() => setPasteAsFileOpen(false)}
          onAttach={(content, name) => {
            setPasteAsFileOpen(false);
            const file = new File([content], name || "snippet.txt", {
              type: "text/plain",
            });
            void startUpload([file]);
          }}
        />
      )}
    </div>
  );
}

function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if (dt.types) {
    for (const t of dt.types) if (t === "Files") return true;
  }
  return false;
}

function isTouch() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

// Module-level latch: once we observe a keydown with characteristics that
// only a hardware keyboard can produce (modifier keys, function keys, Tab,
// arrows, Escape), remember it for the rest of the session and let Enter
// submit from then on. The visualViewport heuristic below is the
// first-keypress fallback for plain Enter on iPad PWAs.
let sawHardwareKeyboard = false;
function noteKeyForHardwareDetection(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }) {
  if (sawHardwareKeyboard) return;
  if (e.metaKey || e.ctrlKey || e.altKey) {
    sawHardwareKeyboard = true;
    return;
  }
  if (
    e.key === "Tab" ||
    e.key === "Escape" ||
    e.key === "ArrowUp" ||
    e.key === "ArrowDown" ||
    e.key === "ArrowLeft" ||
    e.key === "ArrowRight" ||
    (e.key.length > 1 && e.key.startsWith("F") && /^F\d+$/.test(e.key))
  ) {
    sawHardwareKeyboard = true;
  }
}

// Whether pressing Enter (without Shift) should submit instead of inserting
// a newline. Desktop / mouse devices always submit. On a touch device we
// submit when a hardware keyboard is detected — either because we've seen
// a hardware-only key in this session, or because `any-pointer: fine`
// reports a trackpad/mouse alongside the touch screen (e.g. iPad + Magic
// Keyboard), or because no on-screen keyboard is currently visible.
function shouldSendOnEnter() {
  if (typeof window === "undefined") return true;
  if (window.matchMedia("(pointer: fine)").matches) return true;
  if (sawHardwareKeyboard) return true;
  if (window.matchMedia("(any-pointer: fine)").matches) return true;
  const vv = window.visualViewport;
  if (!vv) return false;
  const softKeyboardGap = window.innerHeight - (vv.height + vv.offsetTop);
  return softKeyboardGap < 100;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const isImage = attachment.mime.startsWith("image/");
  return (
    <div className="attach-chip" role="listitem">
      <div className="attach-chip-thumb">
        {isImage && attachment.previewUrl ? (
          <img src={attachment.previewUrl} alt="" />
        ) : (
          <FileIcon />
        )}
      </div>
      <div className="attach-chip-meta">
        <span className="attach-chip-name" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="attach-chip-size">{formatSize(attachment.size)}</span>
      </div>
      <button
        type="button"
        className="attach-chip-remove"
        title="Remove attachment"
        aria-label={`Remove ${attachment.name}`}
        onClick={onRemove}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function UploadingChip({ upload }: { upload: PendingUpload }) {
  const pct =
    upload.total > 0
      ? Math.min(100, Math.round((upload.loaded / upload.total) * 100))
      : 0;
  const isImage = upload.mime.startsWith("image/");
  return (
    <div className="attach-chip attach-chip-uploading" role="listitem" aria-busy>
      <div className="attach-chip-thumb">
        {isImage && upload.previewUrl ? (
          <img src={upload.previewUrl} alt="" />
        ) : (
          <FileIcon />
        )}
      </div>
      <div className="attach-chip-meta">
        <span className="attach-chip-name" title={upload.name}>
          {upload.name}
        </span>
        <span className="attach-chip-size">
          {formatSize(upload.loaded)} / {formatSize(upload.total)}
        </span>
        <div
          className="attach-chip-progress"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="attach-chip-progress-fill"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function PasteAsFileDialog({
  onAttach,
  onCancel,
}: {
  onAttach: (content: string, name: string) => void;
  onCancel: () => void;
}) {
  const [content, setContent] = useState("");
  const [name, setName] = useState("snippet.txt");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const submit = () => {
    if (!content.trim()) return;
    onAttach(content, name.trim() || "snippet.txt");
  };
  return (
    <div
      className="paste-dialog-overlay"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="paste-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Paste text as file"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="paste-dialog-head">
          <h3>Paste as file</h3>
          <button
            type="button"
            className="paste-dialog-close"
            aria-label="Close"
            onClick={onCancel}
          >
            <CloseIcon />
          </button>
        </div>
        <input
          className="paste-dialog-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="File name"
          placeholder="snippet.txt"
        />
        <textarea
          ref={ref}
          className="paste-dialog-body"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste long text, logs, or code here…"
        />
        <div className="paste-dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!content.trim()}
            onClick={submit}
          >
            Attach
          </button>
        </div>
      </div>
    </div>
  );
}
