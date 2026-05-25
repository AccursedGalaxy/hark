// Pure formatters for the rich PromptPanel — extracted so the logic that
// shapes the "what we send back to Claude" text is unit-testable without a
// JSX renderer. Consumers: web/src/components/PromptPanel.tsx.

import type {
  AskQuestion,
  ElicitationField,
} from "./protocol";

// Sentinel that maps to the auto-injected "Other → free text" option the
// AskUserQuestion TUI offers under every question.
export const OTHER_SENTINEL = "__other__";

/**
 * Has the user filled in enough of an AskUserQuestion form to submit it?
 * - every question must have at least one selection
 * - if "Other" is selected, the corresponding free-text input must be non-blank
 */
export function isAskAnswerComplete(
  questions: AskQuestion[],
  selections: string[][],
  others: string[],
): boolean {
  return questions.every((_q, i) => {
    const sel = selections[i] ?? [];
    if (sel.length === 0) return false;
    if (sel.includes(OTHER_SENTINEL) && !(others[i] ?? "").trim())
      return false;
    return true;
  });
}

/**
 * Build the deterministic tmux key sequence that drives the AskUserQuestion
 * TUI widget to the user's selection. Returns null when the answer can't be
 * delivered via keys alone — in which case the caller falls back to the
 * Escape + free-text path. The only such case today is "Other" picks, where
 * the free-text input needs the widget's text-input mode.
 *
 * The TUI widget layout (per the multi-select screenshot in issue #10):
 *
 *   Single-select question rows (top to bottom):
 *     [0..n-1] declared options
 *     [n]     "Type something" (auto-injected Other)
 *   Total rows: n + 1. Enter on an option auto-submits and advances.
 *
 *   Multi-select question rows (top to bottom):
 *     [0..n-1] declared options
 *     [n]     "Type something" (auto-injected Other)
 *     [n+1]   "Submit"
 *   Total rows: n + 2. Enter on an option TOGGLES it (per the widget hint
 *   "Enter to select · ↑/↓ to navigate"). Commit requires stepping to the
 *   Submit row and pressing Enter.
 *
 * Single-select per question we emit:
 *   1. N×Up   — idempotent reset to row 0 (option 0 is highlighted when the
 *               question first appears, but a human in the desktop TUI may
 *               have moved focus already. Up past the top is a no-op, so
 *               over-sending is safe).
 *   2. K×Down — step to the target option index.
 *   3. Enter  — confirm the question (also advances to the next one).
 *
 * Multi-select per question:
 *   For each pick:
 *     1. N×Up — reset to row 0.
 *     2. K×Down — step to the option index.
 *     3. Enter — toggle this option.
 *   After all picks:
 *     4. N×Up — reset to row 0.
 *     5. (n+1)×Down — step to the Submit row.
 *     6. Enter — commit and advance to next question (or close the form).
 *
 * See GitHub issue #10 — the prior implementation used Space to toggle and a
 * single trailing Enter, which silently submitted only the focused option
 * because the TUI ignores Space in this widget.
 */
export function formatAskKeySequence(
  questions: AskQuestion[],
  selections: string[][],
  others: string[],
): string[] | null {
  const keys: string[] = [];
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const sel = selections[qi] ?? [];
    const other = (others[qi] ?? "").trim();
    // Free-text "Other" can't be driven by arrow keys alone — bail and let
    // the caller fall back to the Escape+text path.
    if (sel.includes(OTHER_SENTINEL)) {
      void other;
      return null;
    }
    const indices = sel
      .map((label) => q.options.findIndex((o) => o.label === label))
      .filter((i) => i >= 0);
    // Sanity: at least one selection mapped to a real option index. An empty
    // result here means the form let through a label we don't know about —
    // bail rather than send keys to an unknown row.
    if (indices.length === 0) return null;

    if (!q.multiSelect) {
      // Single-select: declared options + Other ("Type something") row.
      // Enter on an option both selects it and advances.
      const total = q.options.length + 1;
      pushRepeated(keys, "Up", total);
      pushRepeated(keys, "Down", indices[0]);
      keys.push("Enter");
      continue;
    }

    // Multi-select: declared options + Other + Submit row.
    // Toggling and commit are separate keystrokes; commit lives at the
    // bottom of the row list.
    const total = q.options.length + 2;
    const submitIdx = q.options.length + 1;
    for (let i = 0; i < indices.length; i++) {
      pushRepeated(keys, "Up", total);
      pushRepeated(keys, "Down", indices[i]);
      keys.push("Enter");
    }
    pushRepeated(keys, "Up", total);
    pushRepeated(keys, "Down", submitIdx);
    keys.push("Enter");
  }
  return keys;
}

function pushRepeated(out: string[], key: string, n: number): void {
  for (let i = 0; i < n; i++) out.push(key);
}

/**
 * Render selected answers as the text we send back to Claude after pressing
 * Escape. Single-question prompts get a terse one-liner; multi-question
 * prompts get "Header: value" lines so Claude can map answer → question
 * unambiguously.
 *
 * "Other" expands to the user-typed free-text value rather than the sentinel.
 */
export function formatAskAnswerText(
  questions: AskQuestion[],
  selections: string[][],
  others: string[],
): string {
  const lines: string[] = [];
  questions.forEach((q, i) => {
    const sel = selections[i] ?? [];
    const other = (others[i] ?? "").trim();
    const answers = sel.map((l) => (l === OTHER_SENTINEL ? other : l));
    const value = answers.length === 1 ? answers[0] : answers.join(", ");
    if (questions.length === 1) {
      lines.push(value);
    } else {
      const header = q.header ?? q.question;
      lines.push(`${header}: ${value}`);
    }
  });
  return lines.join("\n");
}

/** Has the user filled all required fields on an elicitation form? */
export function isElicitationComplete(
  fields: ElicitationField[],
  values: Record<string, string>,
): boolean {
  return fields.every(
    (f) => !f.required || (values[f.name] ?? "").length > 0,
  );
}

/**
 * Format elicitation answers as YAML-ish "name: value" lines. MCP servers
 * are robust enough to parse this from a normal user reply; Claude routes
 * the text into the same response channel the structured form would.
 */
export function formatElicitationText(
  fields: ElicitationField[],
  values: Record<string, string>,
): string {
  return fields.map((f) => `${f.name}: ${values[f.name] ?? ""}`).join("\n");
}

// ---- Per-tool permission descriptor --------------------------------------

export type ToolTone =
  | "command"
  | "path"
  | "url"
  | "agent"
  | "mcp"
  | "raw"
  | "search";

export interface ToolDescriptorSpec {
  badge: string;
  badgeDetail?: string;
  hint?: string;
  tone: ToolTone;
}

/**
 * Split an MCP tool name (`mcp__<server>__<tool>`) into server + tool.
 * Returns null for non-MCP names.
 */
export function splitMcpToolName(
  name: string,
): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  return {
    server: parts[1] ?? "?",
    tool: parts.slice(2).join("__") || "?",
  };
}

/**
 * Pretty path: shorten an absolute path for display in tight rows. Keep the
 * last three segments and prefix with `…/`. Short paths pass through.
 */
export function prettyPath(p: string): string {
  if (p.length <= 60) return p;
  const parts = p.split("/").filter((x) => x.length > 0);
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-3).join("/")}`;
}

/**
 * Extract just the host portion of a URL for the WebFetch badge. Returns
 * undefined for malformed URLs; the renderer should fall through to showing
 * the raw URL in the body.
 */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Pure header data for a given tool's permission card. The body (which
 * involves React nodes) stays in the component; this gives tests a single
 * function to assert against for badge/tone/hint shape.
 */
export function describeToolHeader(
  toolName: string,
  toolInput: unknown,
): ToolDescriptorSpec {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string =>
    typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);

  switch (toolName) {
    case "Bash":
    case "PowerShell": {
      const timeout = str(input.timeout);
      const bg = input.run_in_background ? "background" : null;
      const hint = [timeout && `timeout ${timeout}ms`, bg]
        .filter(Boolean)
        .join(" · ");
      return {
        badge: toolName,
        tone: "command",
        ...(hint ? { hint } : {}),
      };
    }
    case "Edit":
    case "NotebookEdit":
    case "Write":
    case "Read": {
      const file = str(input.file_path ?? input.notebook_path ?? input.path);
      const off = input.offset ? `offset ${input.offset}` : "";
      const lim = input.limit ? `limit ${input.limit}` : "";
      const hint = [off, lim].filter(Boolean).join(" · ");
      return {
        badge: toolName,
        tone: "path",
        ...(file ? { badgeDetail: prettyPath(file) } : {}),
        ...(hint ? { hint } : {}),
      };
    }
    case "WebFetch": {
      const url = str(input.url);
      return {
        badge: "WebFetch",
        tone: "url",
        ...(url ? { badgeDetail: hostOf(url) ?? url } : {}),
      };
    }
    case "WebSearch": {
      return { badge: "WebSearch", tone: "search" };
    }
    case "Agent":
    case "Task": {
      const subagent = str(input.subagent_type) || "agent";
      const isolation = str(input.isolation);
      return {
        badge: "Agent",
        badgeDetail: subagent,
        tone: "agent",
        ...(isolation ? { hint: `isolation: ${isolation}` } : {}),
      };
    }
    default: {
      const mcp = splitMcpToolName(toolName);
      if (mcp) {
        return {
          badge: "MCP",
          badgeDetail: `${mcp.server} · ${mcp.tool}`,
          tone: "mcp",
        };
      }
      return { badge: toolName, tone: "raw" };
    }
  }
}

// ---- StopFailure error → human label -------------------------------------

export const ERROR_HINT: Record<string, string> = {
  rate_limit: "Rate limited — wait or switch model",
  authentication_failed: "Auth needed on desktop",
  oauth_org_not_allowed: "Org not allowed",
  billing_error: "Billing — visit console.anthropic.com",
  invalid_request: "Invalid request",
  model_not_found: "Model unavailable",
  max_output_tokens: "Output truncated — say 'continue'",
  server_error: "Anthropic server error — retry",
  unknown: "Stopped with an error",
};

export function errorHint(errorType: string): string {
  return ERROR_HINT[errorType] ?? ERROR_HINT.unknown;
}
