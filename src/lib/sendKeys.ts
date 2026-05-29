import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

// ---- Pure argv builders ----------------------------------------------------
//
// Kept separate from the runtime so their shape is unit-testable without
// spawning tmux. Everything that actually drives a pane is composed from these.

export function buildKeyArgs(
  socket: string,
  paneId: string,
  key: string,
): string[] {
  return ["-S", socket, "send-keys", "-t", paneId, key];
}

export function buildPasteArgs(
  socket: string,
  paneId: string,
  bufferId: string,
): { loadBuffer: string[]; pasteBuffer: string[] } {
  return {
    loadBuffer: ["-S", socket, "load-buffer", "-b", bufferId, "-"],
    pasteBuffer: [
      "-S",
      socket,
      "paste-buffer",
      "-b",
      bufferId,
      "-t",
      paneId,
      "-p",
      "-d",
    ],
  };
}

// Probe a pane and report whether it's currently in a tmux mode (copy-mode,
// view-mode, the choose-* menus). `display-message -p` prints the format and
// exits non-zero if the pane no longer exists, so this doubles as an
// existence check. `#{pane_in_mode}` is "1" when the pane has captured the
// keyboard — keystrokes sent then are interpreted as mode navigation, not
// delivered to the program, which is the classic "I typed but Claude never
// saw it" failure when the user has scrolled the pane up.
export function buildPaneModeArgs(socket: string, paneId: string): string[] {
  return [
    "-S",
    socket,
    "display-message",
    "-p",
    "-t",
    paneId,
    "-F",
    "#{pane_in_mode}",
  ];
}

// Cancel any active pane mode (exit copy-mode/view back to the live prompt).
// `-X cancel` is a no-op when the pane isn't in a mode, but we only send it
// when the probe says we need to, to avoid an extra round-trip per keystroke.
export function buildCancelModeArgs(socket: string, paneId: string): string[] {
  return ["-S", socket, "send-keys", "-t", paneId, "-X", "cancel"];
}

// ---- Errors ----------------------------------------------------------------

export class TmuxSendError extends Error {
  constructor(
    message: string,
    readonly argv: string[],
    readonly stderr: string,
    readonly fatal: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TmuxSendError";
  }
}

// stderr substrings tmux emits when the target is gone. These are not worth
// retrying — the pane/session won't come back within a keystroke's lifetime,
// so we fail fast and let the caller surface a 404-ish error to the client.
const FATAL_PATTERNS = [
  "can't find pane",
  "can't find session",
  "can't find window",
  "no such",
  "pane not found",
  "session not found",
];

export function isFatalStderr(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return FATAL_PATTERNS.some((p) => s.includes(p));
}

// ---- Runtime ---------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;
// How long to let a multi-line bracketed paste settle in the TUI before the
// submit Enter (see sendInput). Imperceptible interactively; only multi-line
// payloads wait. Tuned against large agent briefings parking unsubmitted.
const PASTE_SETTLE_MS = 150;
// Backoff before retry attempt N (1-indexed). tmux transient failures
// ("resource temporarily unavailable", a server mid-restart) clear in tens
// of milliseconds, so the schedule stays short — a send-key must feel instant.
const BACKOFF_MS = [50, 150, 300];

interface RunOpts {
  stdin?: string;
  timeoutMs?: number;
  retries?: number;
}

function runOnce(
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "tmux",
      args,
      { timeout: timeoutMs, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { stderr?: string };
          e.stderr = stderr ?? "";
          reject(e);
        } else {
          resolve(stdout ?? "");
        }
      },
    );
    // If the pane is gone, writing to a buffer's stdin can EPIPE; swallow it so
    // the execFile callback (which carries the real tmux error) wins the race.
    child.stdin?.on("error", () => {});
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Run a tmux command with a timeout and bounded retries. Fatal failures
// (target gone) and timeouts are not retried with the same odds of success,
// but a timeout *is* retried once in case the first invocation wedged on a
// busy server. Throws TmuxSendError on final failure.
async function runTmux(args: string[], opts: RunOpts = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  let lastErr: NodeJS.ErrnoException & { stderr?: string };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await runOnce(args, opts.stdin, timeoutMs);
    } catch (err) {
      lastErr = err as NodeJS.ErrnoException & { stderr?: string };
      const stderr = lastErr.stderr ?? "";
      // A missing target won't fix itself — fail fast, don't burn retries.
      if (isFatalStderr(stderr)) {
        throw new TmuxSendError(
          `tmux target gone: ${stderr.trim() || lastErr.message}`,
          args,
          stderr,
          true,
          { cause: lastErr },
        );
      }
      if (attempt < retries) {
        await sleep(BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
        continue;
      }
    }
  }
  const stderr = lastErr!.stderr ?? "";
  throw new TmuxSendError(
    `tmux command failed after ${retries + 1} attempt(s): ${stderr.trim() || lastErr!.message}`,
    args,
    stderr,
    false,
    { cause: lastErr! },
  );
}

// ---- Per-pane serialization -------------------------------------------------
//
// Two clients (phone + laptop, or a rapid double-tap) can POST /send for the
// same session concurrently. Without serialization their tmux invocations
// interleave: client A's text, client B's text, A's Enter, B's Enter — sending
// a garbled merged prompt. We chain all work for a given pane through a
// promise queue so each logical send completes atomically before the next
// starts. The queue is keyed by socket+pane and self-evicts when idle so it
// doesn't grow without bound across a long-lived server.

const paneQueues = new Map<string, Promise<void>>();

function paneKey(socket: string, paneId: string): string {
  return `${socket}\0${paneId}`;
}

export async function withPaneLock<T>(
  socket: string,
  paneId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = paneKey(socket, paneId);
  const prior = paneQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((res) => (release = res));
  // Callers that arrive while we hold the lock will see `tail` and queue
  // behind it; we ourselves wait behind `prior`.
  const tail = prior.then(() => mine);
  paneQueues.set(key, tail);
  try {
    await prior;
    return await fn();
  } finally {
    release();
    // If no later caller replaced the tail, this pane is idle again — evict
    // the entry so the map stays bounded over the server's lifetime.
    if (paneQueues.get(key) === tail) paneQueues.delete(key);
  }
}

// ---- Preflight --------------------------------------------------------------

// Verify the pane exists and bring it out of any active mode so the keystrokes
// we're about to send land at the live prompt. Throws a fatal TmuxSendError
// if the pane is gone. Done once per logical send rather than per keystroke.
async function preflight(socket: string, paneId: string): Promise<void> {
  const out = await runTmux(buildPaneModeArgs(socket, paneId), { retries: 1 });
  if (out.trim() === "1") {
    await runTmux(buildCancelModeArgs(socket, paneId), { retries: 1 });
  }
}

// ---- Raw (unlocked) sends ---------------------------------------------------
//
// These assume the caller already holds the pane lock and ran preflight. They
// exist so composite operations (sendInput) can issue several keystrokes under
// a single lock without re-entrant deadlock.

async function rawSendKey(
  socket: string,
  paneId: string,
  key: string,
): Promise<void> {
  await runTmux(buildKeyArgs(socket, paneId, key));
}

async function rawSendLiteral(
  socket: string,
  paneId: string,
  text: string,
): Promise<void> {
  await runTmux(["-S", socket, "send-keys", "-t", paneId, "-l", text]);
}

async function rawSendText(
  socket: string,
  paneId: string,
  text: string,
): Promise<void> {
  const bufferId = `hark-${randomBytes(4).toString("hex")}`;
  const { loadBuffer, pasteBuffer } = buildPasteArgs(socket, paneId, bufferId);
  await runTmux(loadBuffer, { stdin: text });
  // paste-buffer carries `-d`, so the buffer is deleted after pasting; no
  // separate cleanup needed even when this throws mid-way (tmux GCs orphaned
  // buffers on its own, and the id is random so collisions are impossible).
  await runTmux(pasteBuffer);
}

// ---- Public API -------------------------------------------------------------

export async function sendKey(
  socket: string,
  paneId: string,
  key: string,
): Promise<void> {
  await withPaneLock(socket, paneId, async () => {
    await preflight(socket, paneId);
    await rawSendKey(socket, paneId, key);
  });
}

export async function sendText(
  socket: string,
  paneId: string,
  text: string,
): Promise<void> {
  await withPaneLock(socket, paneId, async () => {
    await preflight(socket, paneId);
    await rawSendText(socket, paneId, text);
  });
}

// Send a string as literal keystrokes (one char at a time, no bracketed
// paste). Used for attachment-path tokens like "@/abs/path file.png " —
// Claude Code's TUI scans for the `@` prefix per-keystroke, so paths sent
// inside a bracketed paste don't get converted to attachment chips.
export async function sendLiteral(
  socket: string,
  paneId: string,
  text: string,
): Promise<void> {
  await withPaneLock(socket, paneId, async () => {
    await preflight(socket, paneId);
    await rawSendLiteral(socket, paneId, text);
  });
}

export interface SendInput {
  // Absolute paths sent as literal `@<path> ` tokens before the text so the
  // TUI converts them to attachment chips.
  attachments?: string[];
  text?: string;
  // Press Enter after the text/attachments. Defaults to true.
  submit?: boolean;
}

// Deliver a full composer payload — attachments, then text, then an optional
// Enter — as ONE atomic operation under a single pane lock and a single
// preflight. This is the path the /send endpoint uses; doing the whole
// sequence under one lock is what prevents two concurrent clients from
// interleaving their prompts into one garbled line.
export async function sendInput(
  socket: string,
  paneId: string,
  input: SendInput,
): Promise<void> {
  const attachments = (input.attachments ?? []).filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const text = typeof input.text === "string" ? input.text : "";
  await withPaneLock(socket, paneId, async () => {
    await preflight(socket, paneId);
    for (const p of attachments) {
      await rawSendLiteral(socket, paneId, `@${p} `);
    }
    if (text.length > 0) {
      await rawSendText(socket, paneId, text);
    }
    if (input.submit !== false) {
      // A multi-line bracketed paste lands in the TUI as a "[Pasted text]"
      // block that the app ingests asynchronously; an Enter sent immediately
      // after `paste-buffer` returns races that ingestion and gets swallowed,
      // leaving the prompt parked unsubmitted (observed with large agent
      // briefings — 40+ lines). Let the paste settle before the submit Enter.
      // Single-line text submits instantly, so only multi-line pays the wait.
      if (text.includes("\n")) {
        await sleep(PASTE_SETTLE_MS);
      }
      await rawSendKey(socket, paneId, "Enter");
    }
  });
}
