// Append-only capture into a project's PLAN.md. PLAN.md's `## Inbox`
// section is always the last section by skeleton design, so a capture
// is just an end-of-file append. We rely on O_APPEND (via fs.appendFile)
// so concurrent captures from multiple sessions interleave at line
// granularity instead of racing on read-modify-write. Sub-PIPE_BUF
// writes are atomic on Linux.

import fs from "node:fs/promises";
import path from "node:path";
import { PLAN_FILENAME } from "./projectConstants.js";
import { bootstrapPlanIfMissing } from "./projectPlan.js";

export interface CaptureDeps {
  // Wall-clock source. Injected so tests can pin time deterministically.
  now: () => Date;
}

export const defaultDeps: CaptureDeps = {
  now: () => new Date(),
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// `YYYY-MM-DD HH:MM` in local timezone — matches how a human reads the
// doc, not UTC.
export function formatCaptureTimestamp(d: Date): string {
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const da = pad2(d.getDate());
  const h = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${y}-${mo}-${da} ${h}:${mi}`;
}

// Full inbox line, no trailing newline (the writer adds it).
export function buildCaptureLine(text: string, when: Date): string {
  return `- [${formatCaptureTimestamp(when)}] ${text.trim()}`;
}

// Append a capture line to PLAN.md. Callers should validate input; we
// re-check and throw on empty so we never write a stamped-but-bodyless
// line into the doc.
export async function appendCapture(
  projectRoot: string,
  projectName: string,
  text: string,
  deps: CaptureDeps = defaultDeps,
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("capture text is empty");
  }
  await bootstrapPlanIfMissing(projectRoot, projectName);
  const planPath = path.join(projectRoot, PLAN_FILENAME);
  const line = buildCaptureLine(trimmed, deps.now());
  // fs.appendFile opens with O_APPEND under the hood — concurrent
  // writers interleave at the kernel level instead of stomping each
  // other.
  await fs.appendFile(planPath, `${line}\n`, "utf8");
}
