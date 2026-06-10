// Quick-capture into a project's BOARD, as an `inbox` task. This is the keyed
// replacement for the old PLAN.md `## Inbox` append: a capture is now a real
// board row (status=inbox), not a line of prose. The board's `created_at`
// carries the timestamp the old `- [YYYY-MM-DD HH:MM]` line used to, and the PM
// triages inbox → backlog/ready (or closes it as noise) instead of draining
// prose. Concurrency + idempotency are the board's (WAL + keyed upsert), so the
// capture path itself stays trivial.

import {
  BoardStore,
  ensureProjectBoardDb,
  newTaskId,
} from "./board/boardStore.js";

export interface CaptureDeps {
  // Factory for a board store bound to a project root. Injected so tests can
  // point at a temp board file without touching the real per-project board.
  openBoard: (projectRoot: string) => BoardStore;
}

export const defaultDeps: CaptureDeps = {
  openBoard: (projectRoot) => new BoardStore(ensureProjectBoardDb(projectRoot)),
};

export interface CaptureResult {
  // The minted task id, so the caller (UI / CLI) can echo or deep-link it.
  taskId: string;
}

// Capture a raw note onto the project board as an `inbox` task. Callers should
// validate input; we re-check and throw on empty so we never mint a titleless
// task. The task lands in `inbox` for the PM to triage.
export async function captureToBoard(
  projectRoot: string,
  text: string,
  deps: CaptureDeps = defaultDeps,
): Promise<CaptureResult> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("capture text is empty");
  }
  const store = deps.openBoard(projectRoot);
  try {
    const id = newTaskId();
    store.setTask(id, { title: trimmed, status: "inbox" });
    return { taskId: id };
  } finally {
    store.close();
  }
}
