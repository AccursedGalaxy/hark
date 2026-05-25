import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

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

function run(args: string[], stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("tmux", args, (err) => {
      if (err) reject(err);
      else resolve();
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

export async function sendKey(
  socket: string,
  paneId: string,
  key: string,
): Promise<void> {
  await run(buildKeyArgs(socket, paneId, key));
}

export async function sendText(
  socket: string,
  paneId: string,
  text: string,
): Promise<void> {
  const bufferId = `hark-${randomBytes(4).toString("hex")}`;
  const { loadBuffer, pasteBuffer } = buildPasteArgs(socket, paneId, bufferId);
  await run(loadBuffer, text);
  await run(pasteBuffer);
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
  // `send-keys -l` sends raw bytes without trying to parse named keys.
  await run(["-S", socket, "send-keys", "-t", paneId, "-l", text]);
}
