import {
  BOARD_STATUSES,
  newTaskId,
  parseFieldAssignments,
  type BoardStore,
  type ListFilter,
  type TaskEventRow,
  type TaskFields,
  type TaskRow,
} from "./boardStore.js";

// The `hark board …` command surface — the PM's keyed-task operations, mirroring
// the shape of `hark agent …`. UNLIKE the agent/orch/head commands (thin HTTP
// clients onto the running server), the board is a self-contained SQLite SOURCE
// OF TRUTH the PM acts on DIRECTLY — no server round-trip, offline, the design
// doc's "native SoT". So this module owns the full loop for board commands:
//   planBoard(argv)        — PURE: argv → a BoardOp (unit-tested, no DB)
//   applyBoardOp(store,op) — run the op against a BoardStore
//   renderBoardResult(r)   — PURE: result → human text
// bin/hark wires them: plan → open store → apply → render.

export type BoardOp =
  | { verb: "add"; title: string; fields: TaskFields }
  | { verb: "list"; filter: ListFilter }
  | { verb: "show"; id: string }
  | { verb: "set"; id: string; fields: TaskFields }
  | { verb: "link"; id: string; dependsOn: string }
  | { verb: "assign"; id: string; assignee: string }
  | { verb: "close"; id: string; by?: string };

export type BoardPlan =
  | { kind: "op"; op: BoardOp }
  | { kind: "message"; text: string }
  | { kind: "error"; message: string };

export const BOARD_USAGE = `hark board — the PM's keyed task store (a SQLite source of truth)

  hark board add "<title>" [field=value ...]   create a task (status defaults to backlog); prints its id
  hark board list [field=value ...]             list tasks; filter by status/assignee/workstream/orch_id
  hark board show <id>                          a task's fields + its append-only event history
  hark board set <id> field=value [field=value …]   keyed UPSERT — idempotent; re-applying is safe
  hark board link <id> <taskId>                 add a depends_on edge (idempotent — re-linking is a no-op)
  hark board assign <id> <assignee>             set assignee (role | agentId | workstream)
  hark board close <id> [by=<who>]               mark done (stamps closed_at + closed_by)

Settable fields: title, body, status, assignee, workstream, priority, depends_on, orch_id, agent_id
Statuses: ${BOARD_STATUSES.join(", ")}

The board is the per-project task store — it replaces PLAN.md's old Inbox/Shipped
prose. New captures land as \`inbox\` tasks (triage → backlog/ready, or close as
noise). Done tasks ARE the shipped log: \`hark board list status=done\` with each
row's closed_at + closed_by (the session/PM that landed it).`;

function err(message: string): BoardPlan {
  return { kind: "error", message };
}

// PURE. Parse the `board` argv (everything AFTER the `board` group token) into a
// BoardOp. `positionals` excludes flags; flags is only consulted for --help.
export function planBoard(
  positionals: string[],
  flags: Record<string, string | true>,
): BoardPlan {
  if (positionals.length === 0 || flags["--help"] || flags["-h"]) {
    return { kind: "message", text: BOARD_USAGE };
  }
  const [sub, ...rest] = positionals;

  switch (sub) {
    case "add": {
      const title = rest[0];
      if (!title || !title.trim()) {
        return err('add needs a title: hark board add "<title>" [field=value …]');
      }
      const parsed = parseFieldAssignments(rest.slice(1));
      if ("error" in parsed) return err(parsed.error);
      return { kind: "op", op: { verb: "add", title, fields: parsed.fields } };
    }
    case "list": {
      const parsed = parseFieldAssignments(rest);
      if ("error" in parsed) return err(parsed.error);
      // Only a subset of fields make sense as filters; reject the rest so a typo
      // (`stats=…`) doesn't silently match nothing.
      const f = parsed.fields;
      const filter: ListFilter = {};
      if (f.status !== undefined) filter.status = f.status ?? undefined;
      if (f.assignee !== undefined) filter.assignee = f.assignee ?? undefined;
      if (f.workstream !== undefined) filter.workstream = f.workstream ?? undefined;
      if (f.orchId !== undefined) filter.orchId = f.orchId ?? undefined;
      for (const k of Object.keys(f) as (keyof TaskFields)[]) {
        if (!["status", "assignee", "workstream", "orchId"].includes(k)) {
          return err(`cannot filter list by "${k}" (use status/assignee/workstream/orch_id)`);
        }
      }
      return { kind: "op", op: { verb: "list", filter } };
    }
    case "show": {
      const id = rest[0];
      if (!id) return err("show needs a task id: hark board show <id>");
      return { kind: "op", op: { verb: "show", id } };
    }
    case "set": {
      const id = rest[0];
      if (!id) return err("set needs a task id: hark board set <id> field=value …");
      const parsed = parseFieldAssignments(rest.slice(1));
      if ("error" in parsed) return err(parsed.error);
      if (Object.keys(parsed.fields).length === 0) {
        return err("set needs at least one field=value");
      }
      return { kind: "op", op: { verb: "set", id, fields: parsed.fields } };
    }
    case "link": {
      const id = rest[0];
      const dep = rest[1];
      if (!id || !dep) return err("link needs: hark board link <id> <taskId>");
      return { kind: "op", op: { verb: "link", id, dependsOn: dep } };
    }
    case "assign": {
      const id = rest[0];
      const assignee = rest[1];
      if (!id || !assignee) return err("assign needs: hark board assign <id> <assignee>");
      return { kind: "op", op: { verb: "assign", id, assignee } };
    }
    case "close": {
      const id = rest[0];
      if (!id) return err("close needs a task id: hark board close <id> [by=<who>]");
      // Optional `by=<who>` records the closer in closed_by; anything else is a
      // misuse (close takes no other fields — promote/edit via `set`).
      let by: string | undefined;
      for (const tok of rest.slice(1)) {
        if (tok.startsWith("by=")) {
          by = tok.slice(3) || undefined;
        } else {
          return err(`close takes only an optional by=<who>, got "${tok}"`);
        }
      }
      return { kind: "op", op: { verb: "close", id, by } };
    }
    default:
      return err(`unknown board command: ${sub}`);
  }
}

// ---- Execution against a BoardStore ----------------------------------------

export type BoardResult =
  | { kind: "task"; task: TaskRow; changed: boolean; created?: boolean }
  | { kind: "show"; id: string; task: TaskRow | null; events: TaskEventRow[] }
  | { kind: "list"; tasks: TaskRow[] };

// PURE-of-IO except for the store calls. Mints the task id for `add` here (not
// in planBoard) so planning stays deterministic + testable. `link` reads the
// current edges and merges — adding an already-present id is a no-op (so re-link
// is idempotent, like every other write).
export function applyBoardOp(store: BoardStore, op: BoardOp): BoardResult {
  switch (op.verb) {
    case "add": {
      const id = newTaskId();
      const { task, changed } = store.setTask(id, {
        ...op.fields,
        title: op.title,
      });
      return { kind: "task", task, changed, created: true };
    }
    case "list":
      return { kind: "list", tasks: store.listTasks(op.filter) };
    case "show":
      return {
        kind: "show",
        id: op.id,
        task: store.getTask(op.id),
        events: store.getEvents(op.id),
      };
    case "set": {
      const { task, changed } = store.setTask(op.id, op.fields);
      return { kind: "task", task, changed };
    }
    case "link": {
      // Atomic read-merge-write lives in the store (transaction-wrapped) so a
      // concurrent linker can't lose an edge.
      const { task, changed } = store.link(op.id, op.dependsOn);
      return { kind: "task", task, changed };
    }
    case "assign": {
      const { task, changed } = store.setTask(op.id, { assignee: op.assignee });
      return { kind: "task", task, changed };
    }
    case "close": {
      // Attribution falls back to the ambient session id so a bare `close`
      // from inside a hark-managed session still records who landed it.
      const by =
        op.by ?? process.env.HARK_SESSION_ID ?? process.env.HARK_PM_ID ?? undefined;
      const { task, changed } = store.setTask(op.id, {
        status: "done",
        closedBy: by ?? null,
      });
      return { kind: "task", task, changed };
    }
  }
}

// ---- Rendering --------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function flat(s: string, max = 60): string {
  const f = s.replace(/\s+/g, " ").trim();
  return f.length <= max ? f : f.slice(0, max) + "…";
}

// PURE. ms-epoch → a compact local `YYYY-MM-DD HH:MM`, or "" for null. Used in
// the shipped view (done rows) and `show`.
export function formatBoardTimestamp(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// One compact line per task for `list`. id · status · assignee · title. Done
// rows append the shipped-log record (when + who closed it) so a plain
// `list status=done` reads as the shipped log.
function taskLine(t: TaskRow): string {
  const base = `${pad(t.id, 22)} ${pad(t.status ?? "", 12)} ${pad(t.assignee ?? "-", 14)} ${flat(t.title ?? "")}`;
  if (t.status === "done" && (t.closedAt != null || t.closedBy)) {
    const when = formatBoardTimestamp(t.closedAt);
    const who = t.closedBy ? ` by ${t.closedBy}` : "";
    return `${base}  ✓ ${when}${who}`.trimEnd();
  }
  return base;
}

export function renderBoardResult(r: BoardResult): string {
  switch (r.kind) {
    case "task": {
      const t = r.task;
      if (r.created) return `added ${t.id} [${t.status}] ${flat(t.title ?? "")}`;
      const tail = r.changed ? "" : " (unchanged)";
      return `${t.id} [${t.status}] ${flat(t.title ?? "")}${tail}`;
    }
    case "list": {
      if (r.tasks.length === 0) return "(no tasks)";
      return r.tasks.map(taskLine).join("\n");
    }
    case "show": {
      if (!r.task) return `(no task ${r.id})`;
      const t = r.task;
      const lines: string[] = [];
      lines.push(`${t.id} [${t.status}]`);
      if (t.title) lines.push(`  title:      ${t.title}`);
      if (t.assignee) lines.push(`  assignee:   ${t.assignee}`);
      if (t.workstream) lines.push(`  workstream: ${t.workstream}`);
      if (t.priority) lines.push(`  priority:   ${t.priority}`);
      if (t.dependsOn) lines.push(`  depends_on: ${t.dependsOn}`);
      if (t.orchId) lines.push(`  orch_id:    ${t.orchId}`);
      if (t.agentId) lines.push(`  agent_id:   ${t.agentId}`);
      if (t.closedAt != null) lines.push(`  closed:     ${formatBoardTimestamp(t.closedAt)}${t.closedBy ? ` by ${t.closedBy}` : ""}`);
      if (t.body) lines.push(`  body:       ${t.body}`);
      if (r.events.length > 0) {
        lines.push("  events:");
        for (const e of r.events) {
          lines.push(`    [${e.kind}] ${e.message ?? ""}`);
        }
      }
      return lines.join("\n");
    }
  }
}
