export type HookCommand = { type: "command"; command: string };
export type HookGroup = { matcher?: string; hooks: HookCommand[] };
export type HooksMap = Record<string, HookGroup[]>;
export type Settings = { hooks?: HooksMap; [k: string]: unknown };

// Hook events hark consumes — anything Claude Code can fire that we render
// in the UI. Adding an event here is the first step; the second is teaching
// PromptState what to do with it in src/lib/promptState.ts.
//
// - Notification: coarse "needs you" signal (idle_prompt, auth_success, ...)
// - Stop: turn boundary — clears pending state
// - StopFailure: turn ended with an error (rate_limit, auth, billing, …)
// - PermissionRequest: tool decision dialog (Bash/Edit/WebFetch/AskUserQuestion/ExitPlanMode/MCP)
// - PermissionDenied: auto-mode classifier rejected — surfaces as a toast
// - Elicitation / ElicitationResult: MCP server-driven form lifecycle
// - SubagentStart / SubagentStop: per-session running-agent badges
// - CwdChanged: header path tracking
// See docs/interactions.md and docs/prompts.md for the full catalog.
const MANAGED_EVENTS = [
  "Notification",
  "Stop",
  "StopFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Elicitation",
  "ElicitationResult",
  "SubagentStart",
  "SubagentStop",
  "CwdChanged",
] as const;

// LEGACY events — removal only. The removed orchestration harness registered
// SYNCHRONOUS decision hooks under these events (a curl whose stdout Claude
// Code read back as a permission decision / injected context). They cost a
// blocking curl on EVERY tool call / prompt of EVERY session, so install must
// actively STRIP any managed entries left under them — merely not re-adding
// them would leave the stale curls in settings.json forever.
const LEGACY_EVENTS = ["PreToolUse", "UserPromptSubmit"] as const;

export function buildHookCommand(url: string): string {
  return `curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- '${url}' >/dev/null 2>&1 || true`;
}

// The SessionStart hook is the one managed hook whose stdout MATTERS: Claude
// Code injects it into the new session's context, which is how sessions learn
// the hark:html artifact format (served by GET /api/artifact-contract, text
// owned by src/lib/artifactContract.ts). Unlike the legacy synchronous
// decision hooks this runs ONCE per session, and --max-time caps the cost
// when the server is down (empty stdout → no context, silently fine).
export function contractUrlFor(hookUrl: string): string {
  return hookUrl.replace(/\/api\/hook$/, "/api/artifact-contract");
}

export function buildContractCommand(url: string): string {
  return `curl -sS --max-time 2 '${contractUrlFor(url)}' 2>/dev/null || true`;
}

export function isManagedCommand(command: string, url: string): boolean {
  return command.includes(url) || command.includes(contractUrlFor(url));
}

function cloneSettings(s: Settings): Settings {
  return JSON.parse(JSON.stringify(s ?? {})) as Settings;
}

function ensureHooksMap(s: Settings): HooksMap {
  if (!s.hooks || typeof s.hooks !== "object") s.hooks = {};
  return s.hooks;
}

// SessionStart is managed but NOT in MANAGED_EVENTS: those all POST the event
// payload to /api/hook, while SessionStart curls the artifact contract and
// feeds its stdout back to Claude Code as session context.
const ALL_MANAGED_EVENTS = [
  ...MANAGED_EVENTS,
  "SessionStart",
  ...LEGACY_EVENTS,
] as const;

// Strip managed entries (matched by server URL) from the given events.
// Mutates `hooks` in place; deletes an event key whose groups empty out.
function stripManagedEvents(
  hooks: HooksMap,
  events: readonly string[],
  url: string,
): void {
  for (const event of events) {
    const groups: HookGroup[] | undefined = hooks[event];
    if (!Array.isArray(groups)) continue;
    const filtered = groups
      .map((g) => ({
        ...g,
        hooks: (g.hooks ?? []).filter(
          (h) => !isManagedCommand(h?.command ?? "", url),
        ),
      }))
      .filter((g) => g.hooks.length > 0);
    if (filtered.length === 0) delete hooks[event];
    else hooks[event] = filtered;
  }
}

export function installHooks(input: Settings, url: string): Settings {
  const next = cloneSettings(input);
  const hooks = ensureHooksMap(next);
  const fireAndForget = buildHookCommand(url);
  const commandFor = (event: string): string =>
    event === "SessionStart" ? buildContractCommand(url) : fireAndForget;
  for (const event of [...MANAGED_EVENTS, "SessionStart"]) {
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    const hasManaged = groups.some((g) =>
      Array.isArray(g.hooks) &&
      g.hooks.some((h) => isManagedCommand(h?.command ?? "", url)),
    );
    if (hasManaged) {
      hooks[event] = groups;
      continue;
    }
    hooks[event] = [
      ...groups,
      { hooks: [{ type: "command", command: commandFor(event) }] },
    ];
  }
  // Migration: clear stale synchronous decision hooks a previous version
  // registered under the legacy events — they'd otherwise block every tool
  // call with a curl forever.
  stripManagedEvents(hooks, LEGACY_EVENTS, url);
  return next;
}

export function uninstallHooks(input: Settings, url: string): Settings {
  const next = cloneSettings(input);
  if (!next.hooks) return next;
  stripManagedEvents(next.hooks, ALL_MANAGED_EVENTS, url);
  return next;
}
