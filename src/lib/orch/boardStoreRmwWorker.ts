// Test-only worker for boardStore.stress.test.ts. Runs ONE real read-modify-
// write op (setTask of a single field, or link of one edge) against a shared
// db file in its own OS thread, so the concurrency tests exercise the ACTUAL
// BoardStore transaction code rather than a raw-SQL re-implementation. Lives in
// its own ESM file (not an inline eval worker) because tsx only rewrites the
// nested `.js`→`.ts` imports in ESM mode. Excluded from the tsc build via
// tsconfig — it is never shipped, only loaded by the test under `--import tsx`.
import { workerData, parentPort } from "node:worker_threads";
import { BoardStore } from "./boardStore.js";

interface RmwJob {
  dbPath: string;
  op: "set" | "link";
  taskId: string;
  field?: string;
  value: string;
}

const job = workerData as RmwJob;
const db = new BoardStore(job.dbPath);
try {
  if (job.op === "link") {
    db.link(job.taskId, job.value);
  } else {
    db.setTask(job.taskId, { [job.field as string]: job.value });
  }
  parentPort?.postMessage("ok");
} catch (e) {
  parentPort?.postMessage(`err:${e instanceof Error ? e.message : String(e)}`);
} finally {
  db.close();
}
