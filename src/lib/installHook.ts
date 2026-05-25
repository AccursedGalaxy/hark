export type HookCommand = { type: "command"; command: string };
export type HookGroup = { matcher?: string; hooks: HookCommand[] };
export type HooksMap = Record<string, HookGroup[]>;
export type Settings = { hooks?: HooksMap; [k: string]: unknown };

// Notification + Stop signal "needs attention"; PermissionRequest carries
// the tool name + input so hark can render "Allow `npm test`?" instead of
// a generic "needs you". See docs/interactions.md.
const MANAGED_EVENTS = ["Notification", "Stop", "PermissionRequest"] as const;

export function buildHookCommand(url: string): string {
  return `curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- '${url}' >/dev/null 2>&1 || true`;
}

export function isManagedCommand(command: string, url: string): boolean {
  return command.includes(url);
}

function cloneSettings(s: Settings): Settings {
  return JSON.parse(JSON.stringify(s ?? {})) as Settings;
}

function ensureHooksMap(s: Settings): HooksMap {
  if (!s.hooks || typeof s.hooks !== "object") s.hooks = {};
  return s.hooks;
}

export function installHooks(input: Settings, url: string): Settings {
  const next = cloneSettings(input);
  const hooks = ensureHooksMap(next);
  const command = buildHookCommand(url);
  for (const event of MANAGED_EVENTS) {
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    const hasManaged = groups.some((g) =>
      Array.isArray(g.hooks) &&
      g.hooks.some((h) => isManagedCommand(h?.command ?? "", url)),
    );
    if (hasManaged) {
      hooks[event] = groups;
      continue;
    }
    hooks[event] = [...groups, { hooks: [{ type: "command", command }] }];
  }
  return next;
}

export function uninstallHooks(input: Settings, url: string): Settings {
  const next = cloneSettings(input);
  if (!next.hooks) return next;
  for (const event of MANAGED_EVENTS) {
    const groups: HookGroup[] | undefined = next.hooks[event];
    if (!Array.isArray(groups)) continue;
    const filtered = groups
      .map((g) => ({
        ...g,
        hooks: (g.hooks ?? []).filter(
          (h) => !isManagedCommand(h?.command ?? "", url),
        ),
      }))
      .filter((g) => g.hooks.length > 0);
    if (filtered.length === 0) delete next.hooks[event];
    else next.hooks[event] = filtered;
  }
  return next;
}
