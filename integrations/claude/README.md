# Claude Code integration

Version-controlled, installable pieces that wire a Claude Code session up to
hark. There are two parts, deliberately split:

1. **The `/head` slash-command** — installed by `install.sh` (a symlink, so it
   auto-updates on `git pull`).
2. **The pure-PM tree-guard hooks** — added to `~/.claude/settings.json` *by
   hand* (listed below). The installer does **not** touch `settings.json`
   (Decision B, 2026-05-29: head command only, no settings.json automation).

## 1. Install the `/head` command

```sh
./integrations/claude/install.sh
```

This symlinks `head.md` into `~/.claude/commands/head.md`, so typing `/head` in
any Claude Code session in this project promotes it to the project's persistent
PM-head. Because it's a symlink into this repo, the command tracks whatever you
have checked out — `git pull` and the command is up to date.

The installer is idempotent and safe to re-run:

- If the link already points here, it reports "no changes" and exits.
- If some other `head.md` is already at the destination, it is moved aside to
  `head.md.bak-<timestamp>` before the link is created — nothing is clobbered.

Override the destination with `CLAUDE_COMMANDS_DIR` if your commands live
elsewhere:

```sh
CLAUDE_COMMANDS_DIR=/path/to/.claude/commands ./integrations/claude/install.sh
```

To uninstall, just remove the link: `rm ~/.claude/commands/head.md`.

## 2. The pure-PM tree-guard hooks (manual)

The `/head` command promotes a session to PM-head, but the **enforcement** that
a PM-head is read-only on the source tree lives in Claude Code hooks. Without
them, "pure PM" is only a guideline; with them it's a system property — a
`PreToolUse` hook denies any tool call that would write outside `PLAN.md` /
`.hark/` (see `src/lib/orch/pmGuard.ts`).

hark manages **12** hook entries. Each is one `curl` that POSTs the hook payload
to the running hark server (`http://localhost:3000/api/hook` by default) and is
tolerant of the server being down (`|| true` ⇒ empty stdout ⇒ no-op, so your
normal sessions are never blocked).

- **2 decision hooks** (`PreToolUse`, `UserPromptSubmit`) run *synchronously*
  and their stdout is read back as a decision — `PreToolUse` is the tree-guard
  that can deny a write; `UserPromptSubmit` injects the newsroom delta. Their
  command keeps stdout (`2>/dev/null || true`).
- **10 notification hooks** (`Notification`, `Stop`, `StopFailure`,
  `PermissionRequest`, `PermissionDenied`, `Elicitation`, `ElicitationResult`,
  `SubagentStart`, `SubagentStop`, `CwdChanged`) are fire-and-forget — they
  feed hark's UI and discard stdout (`>/dev/null 2>&1 || true`).

> Source of truth: `src/lib/installHook.ts` (`MANAGED_EVENTS` +
> `DECISION_EVENTS`). If those lists change, update this file.

### Add them by hand

Merge the following into the `hooks` object of `~/.claude/settings.json`. If a
hook is already present for one of these events, append this entry to its array
rather than replacing it. Replace the URL if your hark server is not on
`localhost:3000`.

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:3000/api/hook' >/dev/null 2>&1 || true" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:3000/api/hook' >/dev/null 2>&1 || true" }] }
    ],
    "StopFailure": [
      { "hooks": [{ "type": "command", "command": "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:3000/api/hook' >/dev/null 2>&1 || true" }] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:3000/api/hook' >/dev/null 2>&1 || true" }] }
    ],
    "PermissionDenied": [
      { "hooks": [{ "type": "command", "command": "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:3000/api/hook' >/dev/null 2>&1 || true" }] }
    ],
    "Elicitation": [
      { "hooks": [{ "type": "command", "command": "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:3000/api/hook' >/dev/null 2>&1 || true" }] }
    ],
    "ElicitationResult": [
      { "hooks": [{ "type": "command", "command": "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:3000/api/hook' >/dev/null 2>&1 || true" }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:3000/api/hook' >/dev/null 2>&1 || true" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:3000/api/hook' >/dev/null 2>&1 || true" }] }
    ],
    "CwdChanged": [
      { "hooks": [{ "type": "command", "command": "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:3000/api/hook' >/dev/null 2>&1 || true" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:3000/api/hook' 2>/dev/null || true" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:3000/api/hook' 2>/dev/null || true" }] }
    ]
  }
}
```

### Optional: the in-repo automated installer

The repo also ships a helper that performs exactly this `settings.json` merge
(idempotently) so you don't have to hand-edit JSON. It is **separate** from
`install.sh` by design — running it is your explicit opt-in to the
`settings.json` automation that `install.sh` intentionally avoids:

```sh
npm run install-hooks                          # add the 12 entries
npm run uninstall-hooks                         # remove them
npm run install-hooks -- --url=http://host:port/api/hook
```

(See `src/bin/install-hooks.ts` / the `install-hooks` script in
`package.json`.) Whether you hand-edit or run the helper, the result is the
same 12 entries shown above.
