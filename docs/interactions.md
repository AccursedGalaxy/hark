# Claude Code Interactive Prompts — Index

Every state where Claude Code stops and waits for a keystroke, indexed for
hark's frontend. Each entry records what triggers the prompt, what the user
sees, the exact keys to send, how (or whether) hark can detect the state from
outside the TUI, and the recommended frontend treatment.

The current Composer only renders **Approve / Deny / Esc** (`1\r` / `2\r` /
`Escape`) — sufficient for the vanilla Bash/Edit permission prompt, blind to
everything else. This doc is the spec for fixing that.

## How hark sees prompts

There is no single "what's on screen" API. Combine three signals:

1. **`Notification` hook** — already wired (`src/lib/hookState.ts`). Payload
   has `notification_type` (string) and `message` (string). Documented values:
   `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`,
   `elicitation_complete`, `elicitation_response`. Today hark stores only
   `message` and a generic `needsAttention` bit — `notification_type` is
   thrown away. **Fixing that is the highest-leverage first step.**
2. **`PermissionRequest` hook** (not yet wired) — fires the moment a
   permission dialog appears, with `tool_name` and `tool_input`. Lets hark
   show "Claude wants to run `npm test`" instead of a generic "needs you".
3. **`tmux capture-pane`** (not yet wired) — reads the visible terminal
   buffer for the session's pane. Last-resort signal for prompts no hook
   covers (model picker, resume picker, `/clear` confirm, image paste).

JSONL transcript alone is **not enough** — it shows tool calls but not the
permission dialog itself, and CLI menus (model picker, resume picker, slash
autocomplete) never touch JSONL at all.

## Categories at a glance

| # | Category | Detection | Keys | Priority |
|---|----------|-----------|------|----------|
| A | Tool-permission prompts (Bash/Edit/Write/WebFetch/MCP) | `Notification.notification_type="permission_prompt"` + `PermissionRequest` hook | `1` / `2` / `3` / `Esc` | **P0** — most common |
| B | Plan-mode acceptance (`ExitPlanMode`) | `PermissionRequest` with `tool_name="ExitPlanMode"` | `1`–`4` / `Esc` | **P0** — plan workflows |
| C | Yes/no confirmations (`/clear`, `/exit`, trust folder) | `capture-pane` regex | `y` / `n` / `Enter` / `Esc` | P1 |
| D | List pickers (resume, model, `/permissions`, `/mcp`) | `capture-pane` heuristic | `↑` `↓` `Enter` `Esc`, sometimes `Tab` | P2 — niche on mobile |
| E | Text + autocomplete (`/`, `@`) | Local typing — no detection needed | regular text | P3 — composer already covers |
| F | Auth & elicitation (MCP OAuth, MCP elicitation form) | `Notification.notification_type="elicitation_dialog"` / `auth_success` | varies; mostly browser | P2 |
| G | Idle/awaiting prompt | `Notification.notification_type="idle_prompt"` (or `Stop` hook) | none — user types | already handled |
| H | Image paste, pager scroll, voice dictation | `capture-pane` only | varies | P3 — not worth in MVP |

The rest of the doc is per-prompt detail.

---

## A. Tool-permission prompts

The standard "Claude wants to do X" dialog. Same shape across Bash, Edit,
Write, WebFetch, and MCP tools — only the rendered detail changes.

### A.1 Bash / shell-command permission

- **Trigger** — Claude calls `Bash` with a command not pre-approved by
  `permissions.allow`, in any mode other than `bypassPermissions` /
  `acceptEdits`-with-match.
- **What user sees** — command preview + numbered options. Typically:
  - `1) Yes`
  - `2) Yes, and don't ask again for <command> in <cwd>`
  - `3) No, and tell Claude what to do differently (esc)`
- **Keys** — `1` / `2` / `3`, or `Esc` (equivalent to 3, leaves cursor in
  composer for a "don't, do X instead" reply).
- **Detection**
  - `Notification` hook fires with `notification_type="permission_prompt"`
    and a `message` like `Claude needs your permission to use Bash`.
  - `PermissionRequest` hook fires with `tool_name="Bash"` and
    `tool_input.command`.
- **Frontend** — render Allow / Allow-and-remember / Deny buttons; show the
  command from `tool_input.command`; on Deny, leave focus in composer so
  user can immediately type rationale.

### A.2 Edit / Write / NotebookEdit permission

- **Trigger** — Claude calls `Edit`, `Write`, or `NotebookEdit` in
  `default` or `plan` mode, or on a protected path (`.git`, `.claude`,
  `.env`) in any mode.
- **What user sees** — file path + first lines of diff + the same 3-option
  numbered list as A.1, sometimes with a 4th option to open the diff in
  `$EDITOR`.
- **Keys** — `1` / `2` / `3` / `Esc`, occasionally `4`.
- **Detection** — same hooks as A.1; `tool_name` is `Edit` / `Write` /
  `NotebookEdit`, `tool_input.file_path` is the file.
- **Frontend** — same as A.1, plus show the file path. If `tool_input`
  contains `old_string`/`new_string`, show a tiny diff snippet.

### A.3 WebFetch / WebSearch permission

- **Trigger** — fetch to a domain not on the allow-list, or first time
  using WebSearch in a session.
- **What user sees** — URL + 3-option list (Yes / Yes, always for this
  domain / No).
- **Keys** — `1` / `2` / `3` / `Esc`.
- **Detection** — `PermissionRequest` with `tool_name="WebFetch"` and
  `tool_input.url`.
- **Frontend** — same as A.1, render the URL.

### A.4 MCP tool permission

- **Trigger** — Claude calls any `mcp__<server>__<tool>` not pre-approved.
- **What user sees** — server name + tool name + a serialized snippet of
  arguments + 3-option list.
- **Keys** — `1` / `2` / `3` / `Esc`.
- **Detection** — `PermissionRequest` with `tool_name` matching
  `mcp__*__*`.
- **Frontend** — same as A.1; split the tool name into server/tool for
  readability.

### A.5 Subagent / Agent spawn permission

- **Trigger** — Claude calls the `Agent` / `Task` tool to spawn a subagent
  in a configuration that requires approval.
- **What user sees** — subagent type + task description + 3-option list.
- **Keys** — `1` / `2` / `3` / `Esc`.
- **Detection** — `PermissionRequest` with `tool_name="Agent"` (or
  `"Task"` on older versions); `tool_input.subagent_type` and `prompt`.
- **Frontend** — same as A.1; truncate the prompt aggressively (it can be
  large) with a "show more" expander.

---

## B. Plan-mode acceptance (`ExitPlanMode`)

### B.1 Plan review

- **Trigger** — in plan mode (`/plan`, or `--permission-mode=plan`),
  Claude finishes its plan and calls `ExitPlanMode` with the plan body.
- **What user sees** — rendered plan + a numbered list, currently
  something like:
  - `1) Yes, and auto-accept edits`
  - `2) Yes, and manually approve edits`
  - `3) No, keep planning`
  - (`Esc` to cancel)
- **Keys** — `1` / `2` / `3`, `Esc`.
- **Detection** — `PermissionRequest` with `tool_name="ExitPlanMode"`;
  `tool_input.plan` contains the full markdown plan. Also visible in JSONL
  as a `tool_use` block on the assistant message preceding the prompt.
- **Frontend** — distinct UI from A.* because the *content* matters: render
  the plan markdown in a scroll panel above three labelled buttons
  ("Accept (auto)", "Accept (review each)", "Keep planning"). This is the
  one prompt where a phone-friendly rendering pays off most.

---

## C. Yes/No confirmation dialogs

These are CLI-level prompts, not tool calls. No `PermissionRequest` fires;
detection depends on `capture-pane` regex against the bottom of the pane.

### C.1 Workspace trust on first open

- **Trigger** — first launch in a directory containing `.mcp.json`,
  `.claude/settings.json`, or hook configs.
- **What user sees** — banner about trusting the workspace, prompt like
  `Do you trust the files in this folder? (y/n)`.
- **Keys** — `y` / `n` / `Enter` (= y) / `Esc` (= n).
- **Detection** — `capture-pane` for the banner string. No hook fires
  before this (the session hasn't started yet).
- **Frontend** — show a Trust / Don't-trust dialog; only relevant once per
  cwd so can be a fallback in the "raw keys" surface rather than
  first-class UI.

### C.2 `/clear`, `/exit`, `/quit` confirmation

- **Trigger** — those slash commands.
- **What user sees** — single-line `Clear conversation? (y/n)` or similar.
- **Keys** — `y` / `n`.
- **Detection** — `capture-pane`.
- **Frontend** — don't bother. If the user typed `/clear` on the desktop
  TUI they'll answer on the desktop TUI. Cover via the generic raw-key
  pad.

### C.3 Auto-mode opt-in

- **Trigger** — first time cycling permission modes (`Shift+Tab`) into
  `bypassPermissions` / "auto" without `--allow-dangerously-skip-permissions`.
- **What user sees** — warning + `(y/n)` confirmation.
- **Keys** — `y` / `n`.
- **Detection** — `capture-pane`.
- **Frontend** — same as C.2.

---

## D. List pickers

Interactive ncurses-style menus driven by arrow keys. These never touch the
JSONL transcript and don't fire `PermissionRequest`. Detection is
`capture-pane` only.

### D.1 `claude --resume` / `/resume` session picker

- **What user sees** — scrollable list of past sessions (summary, time,
  branch).
- **Keys** — `↑` `↓` `Enter` `Esc`; also `→`/`←` to expand forks, `/` to
  search, `Ctrl+R` to rename, `Ctrl+A` to widen scope.
- **Frontend** — low priority; users on a remote tablet rarely browse
  picker. Cover with raw-key pad (arrows + Enter).

### D.2 `/model` model+effort picker

- **What user sees** — table of models × effort levels.
- **Keys** — `↑` `↓` to pick model, `←` `→` to pick effort, `d` to set
  default, `Enter` to confirm, `Esc` to cancel.
- **Frontend** — raw-key pad. If we later want a native picker, hark would
  have to know the model list (`claude --list-models` or similar — TBD).

### D.3 `/permissions` rules manager

- **What user sees** — tabbed list (Allow / Ask / Deny / Recently denied).
- **Keys** — `Tab`/`Shift+Tab` between tabs; `↑` `↓` list nav; `a` add,
  `d` delete, `Enter` edit, `r` retry, `Esc` close.
- **Frontend** — raw-key pad.

### D.4 `/mcp` server browser

- **What user sees** — list of MCP servers + status.
- **Keys** — `↑` `↓` `Enter` `Esc`; `o` to start OAuth, `x` to clear auth.
- **Frontend** — raw-key pad; `Esc` always exits.

### D.5 `/plugin` marketplace UI

- **What user sees** — tabbed plugin manager.
- **Keys** — `Tab`/`Shift+Tab` tabs, `↑`/`↓` list, `Space` toggle, `f`
  favourite, `Enter` install, `Esc` close.
- **Frontend** — raw-key pad.

### D.6 `/agents` / agent picker (subagent select for `/run`)

- **What user sees** — list of available agent types.
- **Keys** — `↑` `↓` `Enter` `Esc`.
- **Frontend** — raw-key pad.

### D.7 `/doctor` / `/hooks` / `/config` panels

- Diagnostic and settings panels. Same `↑` `↓` `Enter` `Esc` pattern;
  treat as a single class. Raw-key pad covers them all.

---

## E. Text + inline autocomplete

These are not "Claude waiting for the user" — they're the user typing in the
composer. hark's existing text composer + Send button handles them fine; the
TUI just *previews* options.

- **`/` slash-command picker** — type after `/` to filter; `↑` `↓` `Enter`
  to pick, `Esc` to dismiss. On hark, the user types the full command
  including args and sends as plain text.
- **`@` file-mention picker** — same shape, paths instead of commands.
- **`#` memory tag / `!` bash passthrough** — similar.

No new UI needed. (Maybe a P4 nicety: a `/` and `@` button on the composer
toolbar that inserts the char and focuses the textarea.)

---

## F. Auth & elicitation

### F.1 MCP OAuth flow

- **Trigger** — first use of an OAuth-protected MCP server, or `/login`.
- **What user sees** — `Open browser to authenticate? (y/n)`, then a
  "waiting…" indicator until the callback fires; sometimes followed by
  "Paste callback URL:" if the browser handoff fails.
- **Keys** — `y` / `n`; then `Esc` to abort while waiting; then optional
  text input.
- **Detection** — `Notification.notification_type="auth_success"` fires
  on completion. Start of the flow is captured via `permission_prompt` or
  via the visible `(y/n)`.
- **Frontend** — don't replicate the browser flow in hark; surface a "this
  session is waiting for OAuth on the desktop" badge and let the user go to
  the desktop. Add a Cancel button (`Esc`).

### F.2 MCP elicitation (server-requested form)

- **Trigger** — MCP server calls the `elicitation` capability to ask the
  user a structured question mid-task (form fields or "open this URL").
- **What user sees** — either an inline form (text fields, dropdowns) or
  "Open <url> and confirm here when done? (y/n)".
- **Keys** — `Tab` between fields, `Enter` to submit, `Esc` to cancel; or
  `y`/`n` for the URL variant.
- **Detection** — `Notification.notification_type="elicitation_dialog"`
  fires when the form appears; `elicitation_complete` and
  `elicitation_response` fire on resolution.
- **Frontend** — P2. For MVP, surface as a "form prompt — answer on
  desktop" badge with raw-key fallback (the form fields are not
  introspectable from the hook payload AFAICT).

---

## G. Idle / awaiting prompt

- **Trigger** — Claude finishes its turn cleanly with no pending tool
  call.
- **Detection** — `Stop` hook fires; `Notification.notification_type=
  "idle_prompt"` may also fire.
- **Frontend** — already handled: sidebar marks the session "needs you",
  the composer is enabled, and the user types a follow-up.

---

## H. Long output / image paste / voice — out of scope for MVP

- **Pager** (`less`-style `--More--`) — `Space` / `j` / `q`. Cover via raw
  keypad if needed.
- **Image paste confirmation** — `Ctrl+V` in the TUI shows a tiny "Add
  image? (y/n)". Not reachable from hark (no clipboard), skip.
- **Voice dictation** (`/voice`) — local-only; skip.
- **Fullscreen search** (`Ctrl+F` after `/fullscreen`) — local-only; skip.

---

## Recommended frontend plan

Reading the above, the work splits into three layers, smallest first:

1. **Expose more raw keys** — extend the Composer's button row from
   `Approve` / `Deny` / `Esc` to a small key pad that covers
   `1`–`5`, `y`, `n`, `↑`, `↓`, `←`, `→`, `Tab`, `Enter`, `Esc`, `Ctrl+C`.
   Unblocks every prompt above as a manual fallback, even without smarter
   detection. **Do this first.**
2. **Use `notification_type`** — capture and store the field in
   `HookState` so the frontend can render the right verb ("permission",
   "auth", "elicitation", "idle") and pick the right default action.
   Change `Notification` hook payload pass-through in `src/lib/hookState.ts`
   and propagate to the SSE event shape.
3. **Wire `PermissionRequest` hook + the rich prompt UI** — gives us
   tool name + input, so we can render proper "Allow `npm test`?"
   buttons and (for `ExitPlanMode`) render the plan inline before the
   accept buttons. This is the biggest UX win and the one that makes
   hark feel native.

`tmux capture-pane` parsing is the long-tail fallback for prompts no hook
covers (model picker, trust dialog, `/clear` confirm). Don't build it
until the first three layers are shipped — most users will reach for the
key pad in the meantime.

## Sources

- `code.claude.com/docs/en/hooks` (Notification, PermissionRequest, full
  hook event list as of May 2026).
- Direct observation of `~/.claude/projects/<cwd>/<sid>.jsonl` and the
  live Claude Code TUI on this machine.
- `src/lib/hookState.ts`, `src/lib/transcript.ts`, `src/server.ts`,
  `web/src/components/Composer.tsx` (existing hark surface).
