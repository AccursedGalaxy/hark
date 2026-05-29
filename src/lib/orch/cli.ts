import { AGENT_ROLES, AUTONOMY_LEVELS, type AgentRole } from "../../shared/protocol.js";
import type { OrchStatusView } from "../../shared/protocol.js";
import { renderPrResult, type PrResult } from "./pr.js";

// The `hark` CLI is the head's action surface (Bash-invokable). A Claude Code
// session can't call hark's HTTP API out of the box, so the head acts through
// this thin client which hits the existing localhost API. hark sets HARK_ORCH_ID
// / HARK_ROLE / HARK_API on the head + worker sessions so the CLI auto-targets
// the right run.
//
// As elsewhere in hark, the IO-free logic — argument parsing → request spec,
// and response → human-readable text — lives here and is unit-tested; the
// runner (bin/hark) only performs fetch + console IO.

export interface CliEnv {
  // The orchestration the CLI targets (HARK_ORCH_ID). Absent → resolved via the
  // env-fallback (GET /api/head/resolve) from cwd for a promoted PM-head; if
  // that also fails, most commands error since there's nothing to act on.
  orchId?: string;
  // Base URL of the hark API (HARK_API).
  api: string;
  // The caller's role (HARK_ROLE). "head" unlocks `agent spawn`; workers can't
  // spawn (Sharp Edge 5 — no recursive fork-bombing). Filled by the env-fallback
  // for a promoted head when HARK_ROLE is unset.
  role?: string;
  // The promoting session id (CLAUDE_CODE_SESSION_ID), set by Claude Code in
  // the Bash environment. Used by `hark head init` to attach THIS session as
  // the project's PM-head, and by the env-fallback to identify the head.
  sessionId?: string;
  // The session's cwd — the project dir. Used by `hark head init` + the
  // env-fallback resolve.
  cwd?: string;
}

export interface RequestSpec {
  method: "GET" | "POST";
  // Path + query relative to the API base.
  path: string;
  body?: unknown;
}

export type RenderKind =
  | "status"
  | "spawn"
  | "send"
  | "brief"
  | "diff"
  | "log"
  | "watch"
  | "promote"
  | "autonomy"
  | "pr";

export type CliPlan =
  | { kind: "request"; request: RequestSpec; render: RenderKind }
  // Help / version text — print to stdout, exit 0.
  | { kind: "message"; text: string }
  // A usage error — print to stderr, exit 2.
  | { kind: "error"; message: string };

const USAGE = `hark — orchestration head CLI

  hark head init                            promote THIS session to the project's PM-head
  hark head autonomy <L0|L1|L2|L3>          set the project's autonomy dial
  hark orch status                          show every agent + the head (compact)
  hark orch watch                           block until the next event, print it, exit
  hark agent spawn <role> --task "…" [--depends-on <id>]   spawn a worker (head only)
  hark agent send  <id> "<message>"         steer a worker
  hark agent brief <id> "<task>"            assign a worker its next task
  hark agent diff  <id> [--stat|--full]     worker branch vs base (--stat default)
  hark agent log   <id>                     recent commits on the worker branch
  hark pr          <id> [--title "…"] [--base <ref>]   push the worker branch + open a PR (human lands)

Roles: ${AGENT_ROLES.join(", ")}
Targets the orchestration in $HARK_ORCH_ID against $HARK_API; if unset, the
project's promoted PM-head is resolved from the cwd.`;

// Split argv into positionals + flags. Value flags (--task, --depends-on) take
// the next token; boolean flags (--stat, --full) don't.
const VALUE_FLAGS = new Set(["--task", "--depends-on", "--title", "--base"]);
interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}
function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a)) {
        flags[a] = args[i + 1] ?? "";
        i++;
      } else {
        flags[a] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function err(message: string): CliPlan {
  return { kind: "error", message };
}

export function planCommand(argv: string[], env: CliEnv): CliPlan {
  const { positionals, flags } = parseArgs(argv);
  if (positionals.length === 0 || flags["--help"] || flags["-h"]) {
    return { kind: "message", text: USAGE };
  }

  const [group, sub, ...rest] = positionals;

  if (group === "head") {
    if (sub === "init") {
      if (!env.sessionId) {
        return err(
          "head init must run inside a Claude Code session (CLAUDE_CODE_SESSION_ID unset)",
        );
      }
      if (!env.cwd) return err("head init needs a working directory");
      return {
        kind: "request",
        request: {
          method: "POST",
          path: `/api/head/promote`,
          body: { sessionId: env.sessionId, cwd: env.cwd },
        },
        render: "promote",
      };
    }
    if (sub === "autonomy") {
      if (!env.orchId) return err("no PM-head for this project (run `hark head init`)");
      const level = (rest[0] ?? "").toUpperCase();
      if (!(AUTONOMY_LEVELS as string[]).includes(level)) {
        return err(`autonomy needs a level: ${AUTONOMY_LEVELS.join(", ")}`);
      }
      return {
        kind: "request",
        request: {
          method: "POST",
          path: `/api/orchestrations/${env.orchId}/autonomy`,
          body: { level },
        },
        render: "autonomy",
      };
    }
    return err(`unknown head command: ${sub ?? "(none)"}`);
  }

  if (group === "pr") {
    if (!env.orchId) return err("HARK_ORCH_ID is not set");
    const id = sub; // `hark pr <agentId> [--title "…"] [--base <ref>]`
    if (!id) return err('pr needs an agentId: hark pr <agentId> [--title "…"]');
    const title = typeof flags["--title"] === "string" ? flags["--title"] : undefined;
    const base = typeof flags["--base"] === "string" ? flags["--base"] : undefined;
    const body: Record<string, unknown> = {};
    if (title) body.title = title;
    if (base) body.base = base;
    return {
      kind: "request",
      request: {
        method: "POST",
        path: `/api/orchestrations/${env.orchId}/agents/${id}/pr`,
        body,
      },
      render: "pr",
    };
  }

  if (group === "orch") {
    if (sub === "status") {
      if (!env.orchId) return err("HARK_ORCH_ID is not set");
      return {
        kind: "request",
        request: { method: "GET", path: `/api/orchestrations/${env.orchId}/status` },
        render: "status",
      };
    }
    if (sub === "watch") {
      if (!env.orchId) return err("HARK_ORCH_ID is not set");
      // Long-poll: blocks server-side until the next event is appended, then
      // returns it and exits. Lets the head wait for a worker marker without
      // busy-polling.
      return {
        kind: "request",
        request: {
          method: "GET",
          path: `/api/orchestrations/${env.orchId}/events?wait=1`,
        },
        render: "watch",
      };
    }
    return err(`unknown orch command: ${sub ?? "(none)"}`);
  }

  if (group === "agent") {
    if (!env.orchId) return err("HARK_ORCH_ID is not set");
    const base = `/api/orchestrations/${env.orchId}/agents`;
    switch (sub) {
      case "spawn": {
        if (env.role !== "head") {
          return err("only the head may spawn workers (HARK_ROLE != head)");
        }
        const role = rest[0];
        if (!role || !(AGENT_ROLES as string[]).includes(role)) {
          return err(`spawn needs a valid role (${AGENT_ROLES.join(", ")})`);
        }
        const task = typeof flags["--task"] === "string" ? flags["--task"] : "";
        if (!task.trim()) return err('spawn needs a task: --task "…"');
        const body: Record<string, unknown> = { role, task };
        if (typeof flags["--depends-on"] === "string") {
          body.dependsOn = flags["--depends-on"];
        }
        return {
          kind: "request",
          request: { method: "POST", path: base, body },
          render: "spawn",
        };
      }
      case "send": {
        const id = rest[0];
        const text = rest.slice(1).join(" ");
        if (!id || !text.trim()) return err('send needs: <agentId> "<message>"');
        return {
          kind: "request",
          request: { method: "POST", path: `${base}/${id}/send`, body: { text } },
          render: "send",
        };
      }
      case "brief": {
        const id = rest[0];
        const task = rest.slice(1).join(" ");
        if (!id || !task.trim()) return err('brief needs: <agentId> "<task>"');
        return {
          kind: "request",
          request: { method: "POST", path: `${base}/${id}/brief`, body: { task } },
          render: "brief",
        };
      }
      case "diff": {
        const id = rest[0];
        if (!id) return err("diff needs an agentId");
        const mode = flags["--full"] ? "full" : "stat";
        return {
          kind: "request",
          request: { method: "GET", path: `${base}/${id}/diff?mode=${mode}` },
          render: "diff",
        };
      }
      case "log": {
        const id = rest[0];
        if (!id) return err("log needs an agentId");
        return {
          kind: "request",
          request: { method: "GET", path: `${base}/${id}/log` },
          render: "log",
        };
      }
      default:
        return err(`unknown agent command: ${sub ?? "(none)"}`);
    }
  }

  return err(`unknown command: ${group}`);
}

// ---- Env-fallback resolution ------------------------------------------------

// When HARK_ORCH_ID is unset (a promoted PM-head — never spawned by hark, so it
// has none of the orchestration env vars), the runner first resolves the
// project's active managed head from the cwd. Returns the GET request to make,
// or null when there's nothing to resolve (orchId already known, or no cwd).
export function buildResolveRequest(env: CliEnv): RequestSpec | null {
  if (env.orchId) return null;
  if (!env.cwd) return null;
  const params = new URLSearchParams({ cwd: env.cwd });
  if (env.sessionId) params.set("sessionId", env.sessionId);
  return { method: "GET", path: `/api/head/resolve?${params.toString()}` };
}

// Merge a successful resolve response into the env (orchId + role), so the
// subsequent planCommand targets the head and unlocks `agent spawn`.
export function mergeResolved(env: CliEnv, data: unknown): CliEnv {
  const d = (data ?? {}) as { orchId?: unknown; role?: unknown };
  return {
    ...env,
    orchId: typeof d.orchId === "string" ? d.orchId : env.orchId,
    role: typeof d.role === "string" ? d.role : env.role,
  };
}

// ---- Response rendering -----------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function shortTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function renderStatus(view: OrchStatusView): string {
  const lines: string[] = [];
  lines.push(`${view.name} [${view.status}] — ${view.goal}`);
  if (view.head) {
    const h = view.head;
    lines.push(
      `head   ${pad(h.briefed ? "briefed" : "starting", 9)} ${pad(h.branch, 28)} ${h.turns}t ${shortTokens(h.tokens)}`,
    );
  }
  if (view.agents.length === 0) {
    lines.push("(no workers spawned yet)");
  }
  for (const a of view.agents) {
    const diff = a.diffstat ? ` | ${a.diffstat}` : "";
    const task = a.task ? ` — ${a.task}` : "";
    lines.push(
      `${pad(a.role, 11)} ${pad(a.lifecycle, 9)} ${pad(a.id, 22)} ${pad(a.branch, 28)} ${a.turns}t ${shortTokens(a.tokens)}${diff}${task}`,
    );
  }
  return lines.join("\n");
}

// Render an API response for a given command into human-facing text. `data` is
// the parsed JSON body; shapes are narrow and known per render kind.
export function renderResponse(render: RenderKind, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (render) {
    case "status":
      return renderStatus(data as OrchStatusView);
    case "spawn": {
      const agent = d.agent as { id?: string; role?: string } | undefined;
      if (agent?.id) return `spawned ${agent.role ?? "worker"}: ${agent.id}`;
      return JSON.stringify(d);
    }
    case "diff": {
      const diff = typeof d.diff === "string" ? d.diff : "";
      return diff.trim().length > 0 ? diff : "(no changes vs base)";
    }
    case "log": {
      const log = typeof d.log === "string" ? d.log : "";
      return log.trim().length > 0 ? log : "(no commits)";
    }
    case "promote": {
      // The PM charter is the command's stdout: the promoting session reads it
      // as the Bash tool result and adopts the role.
      const charter = typeof d.charter === "string" ? d.charter : "";
      const reattached = d.reattached === true;
      const header = reattached
        ? "Re-attached this session as the project PM-head.\n\n"
        : "Promoted this session to the project PM-head.\n\n";
      return charter ? header + charter : JSON.stringify(d);
    }
    case "autonomy":
      return d.ok ? `autonomy → ${d.autonomyLevel}` : JSON.stringify(d);
    case "pr": {
      const result = d.result as PrResult | undefined;
      return result ? renderPrResult(result) : JSON.stringify(d);
    }
    case "send":
    case "brief":
      return d.ok ? "ok" : JSON.stringify(d);
    case "watch": {
      const events = Array.isArray(d.events)
        ? (d.events as { kind?: string; message?: string }[])
        : [];
      if (events.length === 0) return "(no new events — timed out)";
      return events
        .map((e) => `[${e.kind ?? "event"}] ${e.message ?? ""}`)
        .join("\n");
    }
    default:
      return JSON.stringify(d);
  }
}

// Resolve the CLI env from process.env + cwd (used by bin/hark).
export function envFromProcess(
  procEnv: Record<string, string | undefined>,
  cwd?: string,
): CliEnv {
  return {
    orchId: procEnv.HARK_ORCH_ID,
    api: procEnv.HARK_API || "http://localhost:3000",
    role: procEnv.HARK_ROLE,
    sessionId: procEnv.CLAUDE_CODE_SESSION_ID,
    cwd,
  };
}
