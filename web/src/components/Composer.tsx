import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import type {
  PendingPermission,
  PromptKind,
  SendBody,
  UploadedFile,
} from "../lib/protocol";
import { Markdown } from "./Markdown";

const PROMPT_LABEL: Record<Exclude<PromptKind, null>, string> = {
  permission: "permission requested",
  elicitation: "form input requested",
  idle: "awaiting your reply",
};

const PERMISSION_CARD_MAX = 400; // chars in collapsed summary
const PLAN_CARD_MAX_HEIGHT = "40vh";
// Pastes longer than this prompt the user to attach the content as a file
// instead of jamming a wall of text into the textarea (and into the tmux
// pane). Tuned so a typical stack trace still goes inline.
const PASTE_FILE_THRESHOLD = 4000;

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

// In-flight upload — kept in state so chips render while bytes are flying.
// On success we replace the placeholder with the server-issued UploadedFile.
interface PendingUpload {
  id: string;
  name: string;
  size: number;
  mime: string;
  loaded: number;
  total: number;
  // Local preview URL for image files (revoked when the chip leaves).
  previewUrl?: string;
}

interface Attachment extends UploadedFile {
  // Local id we can use for removal before/after the upload finishes.
  id: string;
  previewUrl?: string;
}

export function Composer({
  disabled,
  disabledReason,
  errorMessage,
  promptKind,
  pendingPermission,
  onSend,
  onUpload,
}: {
  disabled: boolean;
  disabledReason?: string;
  errorMessage: string | null;
  promptKind: PromptKind;
  pendingPermission: PendingPermission | null;
  onSend: (body: SendBody) => Promise<void>;
  onUpload: (
    files: File[],
    onProgress?: (loaded: number, total: number) => void,
  ) => Promise<UploadedFile[]>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pasteFilePrompt, setPasteFilePrompt] = useState<string | null>(null);
  const [pasteAsFileOpen, setPasteAsFileOpen] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const attachWrapRef = useRef<HTMLDivElement>(null);
  // Track <html>-level drag state without a counter (browsers fire enter/leave
  // for every child element). We only really care that a drag is anywhere
  // over the composer.
  const dragDepth = useRef(0);
  const kbInset = useKeyboardInset();

  const isPlanMode = pendingPermission?.toolName === "ExitPlanMode";
  const showApproveDeny = promptKind === "permission" && !isPlanMode;
  const showPlanButtons = isPlanMode;
  const showInteractiveTools = !disabled && promptKind !== null;
  const autoOpenKeypad =
    promptKind === "permission" || promptKind === "elicitation";

  useEffect(() => {
    if (autoOpenKeypad) setKeypadOpen(true);
  }, [autoOpenKeypad]);
  useEffect(() => {
    if (!showInteractiveTools) setKeypadOpen(false);
  }, [showInteractiveTools]);

  // Close the attach menu on outside click.
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

  // Revoke object URLs when chips leave to avoid leaking memory.
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

  // ---- Uploads ----------------------------------------------------------

  const startUpload = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || disabled) return;
      setUploadError(null);
      const pending: PendingUpload[] = files.map((f) => ({
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
      setUploads((prev) => [...prev, ...pending]);
      const total = files.reduce((a, f) => a + f.size, 0);
      try {
        const uploaded = await onUpload(files, (loaded) => {
          // Approximate per-file progress by scaling the global byte ratio
          // — XHR doesn't break out per-part progress for multipart bodies.
          const ratio = total > 0 ? loaded / total : 1;
          setUploads((prev) =>
            prev.map((p) =>
              pending.some((q) => q.id === p.id)
                ? { ...p, loaded: Math.round(p.total * ratio) }
                : p,
            ),
          );
        });
        // Replace pending placeholders with the real attachments. We pair
        // up positionally with the request order; the server preserves it.
        setUploads((prev) => prev.filter((p) => !pending.some((q) => q.id === p.id)));
        setAttachments((prev) => [
          ...prev,
          ...uploaded.map((u, i) => ({
            ...u,
            id: pending[i]?.id ?? `at-${Date.now()}-${i}`,
            previewUrl: pending[i]?.previewUrl,
          })),
        ]);
      } catch (err) {
        setUploads((prev) => prev.filter((p) => !pending.some((q) => q.id === p.id)));
        for (const p of pending) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
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

  // ---- File pickers -----------------------------------------------------

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
    e.target.value = ""; // reset so picking the same file again still fires
    void startUpload(files);
  };

  // ---- Drag & drop ------------------------------------------------------

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

  // ---- Paste handling ---------------------------------------------------

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    // Image-in-clipboard → upload as an attachment instead of letting the
    // textarea swallow it as plain text (which it doesn't anyway).
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      void startUpload(files);
      return;
    }
    const pasted = e.clipboardData.getData("text");
    if (pasted.length >= PASTE_FILE_THRESHOLD) {
      // Don't preempt — let it land in the textarea, then offer the user a
      // one-tap "save as file" so they can swap it out if they want.
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

  // ---- Send -------------------------------------------------------------

  const canSend =
    !disabled &&
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
      // surfaced via errorMessage prop
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
    if (e.key === "Enter" && !e.shiftKey && !isTouch()) {
      e.preventDefault();
      void submitText();
    }
  };

  // ---- Render -----------------------------------------------------------

  const allChips: Array<
    | { kind: "attachment"; a: Attachment }
    | { kind: "upload"; u: PendingUpload }
  > = [
    ...attachments.map((a) => ({ kind: "attachment" as const, a })),
    ...uploads.map((u) => ({ kind: "upload" as const, u })),
  ];

  return (
    <div
      className={`composer-wrap ${disabled ? "is-disabled" : ""} ${
        dragging ? "is-dragover" : ""
      }`}
      style={{ paddingBottom: kbInset }}
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

      {(errorMessage || uploadError) && (
        <div className="composer-error" role="status">
          {errorMessage || uploadError}
        </div>
      )}

      <div className="composer">
        {pendingPermission && <PermissionCard pending={pendingPermission} />}

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
              Long paste ({pasteFilePrompt.length.toLocaleString()} chars).
              Send as file?
            </span>
            <div className="composer-paste-prompt-actions">
              <button
                type="button"
                className="btn btn-sm btn-approve"
                onClick={() => void convertPasteToFile()}
              >
                Save as file
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setPasteFilePrompt(null)}
              >
                Keep inline
              </button>
            </div>
          </div>
        )}

        <div className="composer-input">
          {/* Hidden file inputs — driven by the paperclip menu. */}
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

          {/* Paperclip with menu. Sits inside the textarea's bottom-left
           * corner, mirroring the send button on the right. */}
          <div className="composer-attach" ref={attachWrapRef}>
            <button
              type="button"
              className="composer-attach-btn"
              title="Attach files"
              aria-label="Attach files"
              aria-expanded={attachMenuOpen}
              disabled={disabled}
              onClick={() => setAttachMenuOpen((v) => !v)}
            >
              <ClipIcon />
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

          <textarea
            ref={taRef}
            rows={1}
            value={text}
            placeholder={
              disabled ? (disabledReason ?? "Disabled") : "Send a message…"
            }
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            aria-label="Message"
          />
          <button
            type="button"
            className="composer-send"
            onClick={() => void submitText()}
            disabled={!canSend}
            title={
              uploads.length > 0 ? "Waiting for upload…" : "Send (Enter)"
            }
            aria-label="Send"
          >
            <SendIcon />
          </button>
        </div>

        {(showInteractiveTools || (disabled && disabledReason)) && (
          <div className="composer-actions">
            <div className="composer-actions-primary">
              {showApproveDeny && (
                <>
                  <button
                    type="button"
                    className="btn btn-approve"
                    title="Send '1' then Enter (approve a permission prompt)"
                    onClick={() => void sendKeySequence(["1", "Enter"])}
                    disabled={disabled || busy}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn-deny"
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
                    className="btn btn-approve"
                    title="Send '1' then Enter — accept plan, auto-accept file edits"
                    onClick={() => void sendKeySequence(["1", "Enter"])}
                    disabled={disabled || busy}
                  >
                    Accept (auto)
                  </button>
                  <button
                    type="button"
                    className="btn btn-approve btn-approve-soft"
                    title="Send '2' then Enter — accept plan, review each edit"
                    onClick={() => void sendKeySequence(["2", "Enter"])}
                    disabled={disabled || busy}
                  >
                    Accept (review)
                  </button>
                  <button
                    type="button"
                    className="btn btn-deny"
                    title="Send '3' then Enter — keep planning"
                    onClick={() => void sendKeySequence(["3", "Enter"])}
                    disabled={disabled || busy}
                  >
                    Keep planning
                  </button>
                </>
              )}
            </div>

            <div className="composer-actions-secondary">
              {showInteractiveTools && (
                <>
                  <span
                    className={`composer-hint-prompt prompt-${promptKind}`}
                    title="What Claude Code is waiting for"
                  >
                    {PROMPT_LABEL[promptKind!]}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    title="Toggle raw key pad"
                    aria-expanded={keypadOpen}
                    aria-label={keypadOpen ? "Hide key pad" : "Show key pad"}
                    onClick={() => setKeypadOpen((v) => !v)}
                  >
                    {keypadOpen ? "▾ Keys" : "▸ Keys"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    title="Send Escape"
                    onClick={() => void sendKeySequence(["Escape"])}
                    disabled={busy}
                  >
                    Esc
                  </button>
                </>
              )}
              {disabled && disabledReason && (
                <span className="composer-hint">{disabledReason}</span>
              )}
            </div>
          </div>
        )}
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- Chips ----------------------------------------------------------------

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
    upload.total > 0 ? Math.min(100, Math.round((upload.loaded / upload.total) * 100)) : 0;
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
          <div className="attach-chip-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

// ---- Paste-as-file dialog -------------------------------------------------

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
    <div className="paste-dialog-overlay" onClick={onCancel} role="presentation">
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
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-approve"
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

// ---- Icons ----------------------------------------------------------------

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 13V3M8 3L4 7M8 3L12 7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClipIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 11.5l-8.5 8.5a5.5 5.5 0 01-7.78-7.78l9.19-9.19a3.67 3.67 0 015.19 5.19l-9.2 9.19a1.83 1.83 0 01-2.59-2.59L14.5 7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 8h3l2-2h6l2 2h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function PhotoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9" cy="10" r="1.5" fill="currentColor" />
      <path
        d="M3 17l5-5 4 4 3-3 6 6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function TextIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---- Permission card -------------------------------------------------------

type PermissionSummary = {
  badge: string;
  kind: "command" | "path" | "url" | "plan" | "raw";
  body: string;
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
      {summary.kind === "plan" ? (
        <div
          className="perm-card-body"
          style={{ maxHeight: PLAN_CARD_MAX_HEIGHT, overflow: "auto" }}
        >
          <Markdown source={display} tight />
        </div>
      ) : (
        <pre className="perm-card-body">{display}</pre>
      )}
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
