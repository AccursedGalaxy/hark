import fs from "node:fs/promises";
import path from "node:path";
import { PLAN_FILENAME, buildPlanSkeleton } from "./projectConstants.js";

export interface PlanReadResult {
  // The current PLAN.md contents. Never null — if missing, the caller
  // either bootstrapped (use bootstrapPlanIfMissing) or doesn't need
  // the content. Use planExists in ProjectInfo to discriminate.
  content: string;
  mtimeMs: number;
}

function planPath(projectRoot: string): string {
  return path.join(projectRoot, PLAN_FILENAME);
}

export async function readPlan(projectRoot: string): Promise<PlanReadResult> {
  const p = planPath(projectRoot);
  const [content, stat] = await Promise.all([
    fs.readFile(p, "utf8"),
    fs.stat(p),
  ]);
  return { content, mtimeMs: stat.mtimeMs };
}

export async function planExists(projectRoot: string): Promise<boolean> {
  try {
    await fs.stat(planPath(projectRoot));
    return true;
  } catch {
    return false;
  }
}

export async function planMtime(projectRoot: string): Promise<number | null> {
  try {
    const stat = await fs.stat(planPath(projectRoot));
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

export async function bootstrapPlanIfMissing(
  projectRoot: string,
  projectName: string,
): Promise<boolean> {
  // Exclusive-create flag guards the racing-bootstraps case: only one
  // writer wins, the loser sees EEXIST and treats the file as already
  // present.
  try {
    await fs.writeFile(
      planPath(projectRoot),
      buildPlanSkeleton(projectName),
      { encoding: "utf8", flag: "wx" },
    );
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}
