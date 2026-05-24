import fs from "node:fs/promises";

export type TmuxPane = {
  paneId: string;
  socket: string;
};

export function parseEnviron(environ: string): TmuxPane | null {
  let paneId: string | undefined;
  let tmux: string | undefined;
  for (const entry of environ.split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (key === "TMUX_PANE") paneId = entry.slice(eq + 1);
    else if (key === "TMUX") tmux = entry.slice(eq + 1);
  }
  if (!paneId || !tmux) return null;
  const socket = tmux.split(",")[0];
  return { paneId, socket };
}

export async function resolveTmuxPaneForPid(
  pid: number,
): Promise<TmuxPane | null> {
  try {
    const environ = await fs.readFile(`/proc/${pid}/environ`, "utf8");
    return parseEnviron(environ);
  } catch {
    return null;
  }
}
