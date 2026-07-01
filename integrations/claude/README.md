# Claude Code integration

hark learns what your Claude Code sessions are doing through Claude Code
**hooks**: each managed hook is one `curl` that POSTs the hook payload to the
running hark server (`http://localhost:3000/api/hook` by default). Every entry
is fire-and-forget and tolerant of the server being down
(`>/dev/null 2>&1 || true`), so your sessions are never blocked by hark.

## Install the hooks

```sh
npm run install-hooks                            # merge managed entries into ~/.claude/settings.json
npm run uninstall-hooks                          # remove them
npm run install-hooks -- --url=http://host:port/api/hook
```

The installer is idempotent — re-running it makes no changes if the entries
are already present, and it never touches hook entries it doesn't manage.

The managed events are the notification-style hooks hark renders in its UI
(`Notification`, `Stop`, `StopFailure`, `PermissionRequest`,
`PermissionDenied`, `Elicitation`, `ElicitationResult`, `SubagentStart`,
`SubagentStop`, `CwdChanged`).

> Source of truth: `MANAGED_EVENTS` in `src/lib/installHook.ts`. If that list
> changes, update this file.

## Legacy decision hooks (removed 2026-06)

The removed orchestration layer registered *synchronous* decision hooks under
`PreToolUse` and `UserPromptSubmit` — a blocking curl on every tool call of
every session. `npm run install-hooks` now actively **strips** any managed
entries left under those events (see `LEGACY_EVENTS` in
`src/lib/installHook.ts`), and the server answers them with an empty `{}` if
an old entry still fires. Re-run the installer after upgrading across the
refocus to clean them up.
