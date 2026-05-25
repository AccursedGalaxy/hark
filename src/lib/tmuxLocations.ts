import { execFile } from "node:child_process";

// Where a pane lives inside tmux. We surface this to the UI so the user can
// tell sibling Claude sessions in the same cwd apart (one per pane).
export interface PaneLocation {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
}

// Compact display string. Includes the pane index because the user commonly
// runs multiple Claude sessions in different panes of the same window — without
// the `.N` suffix, siblings would still collide. Matches the tmux target form
// `dev:2.1`, which the user can paste directly into `tmux select-pane -t`.
export function formatLocation(loc: PaneLocation): string {
  return `${loc.sessionName}:${loc.windowIndex}.${loc.paneIndex}`;
}

// ASCII Unit Separator (0x1F) — not legal in tmux session/window names so
// we can split safely even when names contain colons or spaces.
const SEP = String.fromCharCode(0x1f);
const FMT =
  `#{pane_id}${SEP}#{session_name}${SEP}#{window_index}${SEP}` +
  `#{window_name}${SEP}#{pane_index}`;

export function parsePaneList(stdout: string): Map<string, PaneLocation> {
  const out = new Map<string, PaneLocation>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(SEP);
    if (parts.length !== 5) continue;
    const [paneId, sessionName, windowIndex, windowName, paneIndex] = parts;
    const wi = Number(windowIndex);
    const pi = Number(paneIndex);
    if (!paneId || !Number.isFinite(wi) || !Number.isFinite(pi)) continue;
    out.set(paneId, {
      sessionName,
      windowIndex: wi,
      windowName,
      paneIndex: pi,
    });
  }
  return out;
}

// ---- runtime ----

function runWithStdout(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// One subprocess for the entire pane→location map. Cheaper than per-pane
// lookups and avoids any thundering-herd shape on the sessions endpoint.
export async function listPaneLocations(): Promise<Map<string, PaneLocation>> {
  try {
    const out = await runWithStdout(["list-panes", "-a", "-F", FMT]);
    return parsePaneList(out);
  } catch {
    return new Map();
  }
}
