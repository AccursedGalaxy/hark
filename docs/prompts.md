# Prompt-handling catalog

Companion to [`interactions.md`](./interactions.md). That doc is the *survey*
of every place Claude Code stops and waits for a keystroke. This doc is the
*build plan*: for each prompt class, what hark detects, what hark renders,
what keys hark sends, and in what order to ship it.

The current Composer (`web/src/components/Composer.tsx`) recognises exactly
two prompt classes — generic "permission" (Approve = `1\r`, Deny = `2\r`)
and `ExitPlanMode` (three buttons). Every other interactive state in
Claude Code is funnelled through the same generic UI or the raw key pad.
That's the gap to close.

A note on scope: Claude Code is a moving target. Anthropic has shipped at
least 27 hook events and a long list of TUI modes as of May 2026; the
priority order below is what matters most for a mobile user driving a
remote session, not exhaustive parity with the desktop TUI.

---

## Detection signals (layered)

Everything below is built on the same five signals, ordered from highest
fidelity to lowest:

1. **`PermissionRequest` hook** — fires whenever Claude wants user
   approval for a tool. Payload has `tool_name`, `tool_input`,
   `tool_use_id`, `permission_mode`, and an HTTP response can return
   `decision: { behavior, updatedInput, permissionRules }`. **This is
   the highest-leverage signal — most "needs you" states surface here,
   including `AskUserQuestion` and `ExitPlanMode`.** Already wired
   (`src/lib/hookState.ts`); `pendingPermission` survives across follow-up
   notifications.
2. **`Notification` hook with `notification_type`** — coarse signal:
   `permission_prompt`, `idle_prompt`, `auth_success`,
   `elicitation_dialog`, `elicitation_complete`, `elicitation_response`.
   Already wired; `notificationType` propagates to the UI.
3. **`Elicitation` / `ElicitationResult` hooks** — MCP-driven forms.
   Carry `server_name` and `form_fields[{name, type, required}]`. Not yet
   wired (still treated as a generic Notification).
4. **`Stop` / `StopFailure` / `SubagentStop` / `PostCompact` /
   `SessionEnd` hooks** — turn-boundary status. `StopFailure` is
   critical UX: `error_type` is one of `rate_limit`,
   `authentication_failed`, `oauth_org_not_allowed`, `billing_error`,
   `invalid_request`, `model_not_found`, `server_error`,
   `max_output_tokens`, `unknown`. Not yet wired.
5. **`tmux capture-pane`** — visible terminal buffer. Last-resort signal
   for CLI-only state (model picker, resume picker, trust dialog,
   rewind menu, vim mode). Not yet wired.

JSONL transcript supplements layer 1: a `tool_use` block lands on the
assistant message *before* a `PermissionRequest` would fire, so the
input can be rendered for context even on the read path.

---

## Tier 0 — blocked on user (must render natively)

These are the prompts where Claude has *paused* and won't continue
without input. The current Approve/Deny pair is wrong for most of them.

### 0.1 Tool-permission prompts (Bash / Edit / Write / Read / WebFetch / WebSearch / MCP / Agent)

- **Detection.** `PermissionRequest` with `tool_name` ∈ {`Bash`, `Edit`,
  `Write`, `NotebookEdit`, `Read`, `WebFetch`, `WebSearch`, `Agent`,
  `mcp__*__*`} and a tool-specific `tool_input`. `Notification` with
  `notification_type="permission_prompt"` may also fire.
- **Keys.** `1\r` allow once, `2\r` allow + remember (cwd or domain),
  `3\r` deny (TUI shows "tell Claude what to do differently"), `Esc`
  same as deny but leaves the composer focused for a follow-up.
- **Render.** Distinct card per tool family, all sharing the same
  three-button row:
  - **Bash**: command (monospace, wrap), optional `description`,
    `timeout`, `run_in_background` badge.
  - **Edit / NotebookEdit**: file path + inline diff of
    `old_string` → `new_string` (use the existing tool-call renderer
    in `web/src/components/ToolCall.tsx`, which already pretty-prints
    diffs).
  - **Write**: file path + line count + first ~20 lines of `content`,
    with an expander for the rest.
  - **Read**: file path + offset/limit if present. Low-risk; default
    button focus on Allow.
  - **WebFetch / WebSearch**: URL or query, host highlighted.
  - **MCP tool**: split `mcp__<server>__<tool>` into server + tool
    headings; render `tool_input` as a JSON tree with collapsible
    nested objects.
  - **Agent / Task**: subagent type, prompt preview (truncate to ~5
    lines with "show more"), `isolation` badge if `worktree`.
- **Open question.** Does the TUI's "2) Yes, and don't ask again …"
  scope match what hark sends? `2\r` should be safe — it picks the
  default "remember" scope (cwd or domain) which the user can later
  edit via `/permissions`.

### 0.2 `AskUserQuestion` — multiple-choice clarification ⭐ priority

This is the one the current UI fails most visibly on. Claude can ask
1–4 questions in a single call, each with 2–4 options, optional
`multiSelect`, optional HTML/markdown `preview` blocks per option, and
implicit "Other → free text".

- **Detection.** `PermissionRequest` with `tool_name="AskUserQuestion"`
  and `tool_input.questions = [{question, header, options[{label,
  description, preview?}], multiSelect}]`. Confirmed schema from the
  Agent SDK docs and from Anthropic's own bug
  [#33625](https://github.com/anthropics/claude-code/issues/33625)
  noting Remote Control still renders "awaiting input" instead of the
  options.
- **Keys.** Not a numbered prompt at the TUI level — it's a custom
  TUI widget. From hark's side we don't send keys; we POST the answers
  back via the PermissionRequest decision channel:

  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "PermissionRequest",
      "decision": {
        "behavior": "allow",
        "updatedInput": {
          "questions": [...original...],
          "answers": {
            "How should I format the output?": "Summary",
            "Which sections should I include?": ["Introduction", "Conclusion"]
          }
        }
      }
    }
  }
  ```

  This means hark's HTTP hook endpoint needs to **return a JSON body
  with `hookSpecificOutput`** rather than fire-and-forget. Today the
  install-hooks command pipes through `curl … || true` and discards
  output. **This is a server-side change, not just a frontend change.**
- **Render.** A multi-question form:
  - For each question: `header` chip → question text → option list.
  - Single-select: radio buttons; first option marked "(Recommended)"
    if the label says so. Auto-focus the first option.
  - Multi-select: checkboxes; submit collects `[label, …]`.
  - "Other" row at the bottom of every question with a text input.
  - If `preview` is present: render the markdown/HTML inline next to
    the label (HTML pre-sanitised by the SDK, but we DOMPurify again
    server-side to be safe).
  - Single Submit button at the bottom (disabled until every question
    has an answer).
- **Fallback.** If hark's hook endpoint can't reach Claude in time
  (response timeout = 600s by default, plenty), the user can still
  bail with `Esc` from the desktop.

### 0.3 `ExitPlanMode` — plan acceptance

- **Detection.** `PermissionRequest` with `tool_name="ExitPlanMode"`
  and `tool_input.plan` (markdown).
- **Keys.** Same three-button TUI prompt as 0.1, with distinct labels:
  - `1\r` accept + auto-edit
  - `2\r` accept + manual approval each edit
  - `3\r` keep planning
  - `Esc` cancel
- **Render.** *The* signature mobile-friendly view: render the markdown
  plan in a scroll panel at the top, three labelled action buttons
  pinned to the bottom. Use the existing `Markdown.tsx` component.
  Already partially handled in Composer (`isPlanMode`); the missing
  piece is rendering the plan body, not just the buttons.

### 0.4 MCP elicitation forms

- **Detection.** `Elicitation` hook fires with `server_name` and
  `form_fields = [{name, type, required}]`. Today we only see
  `Notification` with `notification_type="elicitation_dialog"`, which
  doesn't carry the field schema. **Wire `Elicitation`/
  `ElicitationResult` hooks to capture the fields.**
- **Response.** HTTP hook returns:
  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "Elicitation",
      "action": "accept|decline|cancel",
      "content": { "<field_name>": "<user_value>", ... }
    }
  }
  ```
- **Render.** A simple form generator: render each `form_fields[i]`
  with input type derived from `type` (string → text, number → number,
  boolean → checkbox, enum → select). Three buttons: Accept, Decline,
  Cancel.
- **Fallback.** If `type` is opaque (e.g., a JSON Schema we don't
  recognise), render `type` + a generic text field per name, with a
  "Open on desktop" link as escape hatch.

### 0.5 Auth — MCP OAuth + first-run auth

- **Detection.** Start of flow: `Notification` with `notification_type=
  "permission_prompt"` and a `message` mentioning OAuth, *or* the TUI's
  raw `(y/n)` for "Open browser to authenticate?". Completion:
  `Notification` with `notification_type="auth_success"`.
- **Render.** OAuth requires a *browser* not a button; hark cannot
  complete the flow. Render a badge "Session waiting for OAuth on
  desktop" with a Cancel button (`Esc`) and an auto-dismiss on
  `auth_success`.

### 0.6 Trust dialog (first open of a workspace with `.mcp.json` / hooks)

- **Detection.** No hook fires (the session hasn't fully started yet).
  Only `capture-pane` regex (`Do you trust the files in this folder\?`).
- **Keys.** `y` / `n` / `Enter` (=y) / `Esc` (=n).
- **Render.** Tier-2 treatment for MVP — show a "Session needs trust
  decision on desktop" badge and the raw key pad. The trust dialog is
  one-time-per-cwd and rare in practice.

### 0.7 Auto-mode opt-in (`Shift+Tab` cycle into bypassPermissions)

- **Detection.** `capture-pane` only (the warning + `(y/n)`).
- **Render.** Raw key pad; this is initiated from the desktop and the
  user will be at the desktop when it fires.

---

## Tier 1 — status-only (badge, no input UI)

Surface in the sidebar; don't block the composer.

### 1.1 Idle / awaiting prompt

- **Detection.** `Stop` hook, *and/or* `Notification` with
  `notification_type="idle_prompt"`. Already handled.
- **Render.** Sidebar "needs you" + composer enabled.

### 1.2 Stop with failure ⭐ new, important

- **Detection.** `StopFailure` hook with `error_type` and `error_message`.
- **Render.** Sidebar marks session "errored" with a distinct colour
  (not the same as "needs attention"). Surface the error category as a
  chip:
  - `rate_limit` → "Rate limited — wait or switch model"
  - `authentication_failed` / `oauth_org_not_allowed` → "Auth needed
    on desktop"
  - `billing_error` → "Billing — visit console.anthropic.com"
  - `model_not_found` → "Model unavailable"
  - `max_output_tokens` → "Output truncated — say `continue`"
  - `server_error` / `unknown` → "Anthropic server error — retry"
- **Action.** Composer becomes a "Retry" button (sends Enter on the
  pane to retry) plus the normal text input.

### 1.3 Subagent activity

- **Detection.** `SubagentStart` → record `agent_id`, `agent_type` per
  session. `SubagentStop` → clear it. `TeammateIdle` → similar.
- **Render.** Sidebar shows "running 2 agents" badge; expanding the
  session shows a sub-list with each agent type.

### 1.4 Compaction in progress

- **Detection.** `PreCompact` (`trigger: manual|auto`) →
  `PostCompact`.
- **Render.** Sidebar badge "compacting…"; composer briefly disabled
  between events. Avoid marking as "needs you" — this is purely
  internal.

### 1.5 Session lifecycle

- **Detection.** `SessionStart` with `source` ∈ {`startup`, `resume`,
  `clear`, `compact`} and `model`. `SessionEnd` with `reason` ∈
  {`clear`, `resume`, `logout`, `prompt_input_exit`,
  `bypass_permissions_disabled`, `other`}.
- **Render.** Surface the model in the header; on `SessionEnd`,
  remove the row from the sidebar (or grey it out for ~30s with the
  reason).

### 1.6 Working-context changes

- `CwdChanged` (previous_cwd → new_cwd) — update session header path.
- `FileChanged` (watched files like `.env`, `.envrc`) — small toast
  "config changed".
- `WorktreeCreate` / `WorktreeRemove` — sidebar badge "worktree", with
  branch + path.
- `ConfigChange` (settings / skills updated mid-session) — toast.
- `InstructionsLoaded` — quiet; debug-only by default.

### 1.7 Task list activity

- **Detection.** `TaskCreated` / `TaskCompleted` hooks. Also reflected
  in the JSONL as TodoWrite tool calls.
- **Render.** A collapsible task list panel per session, mirroring
  the desktop's `Ctrl+T` view. Counter in the sidebar
  ("3/8 tasks done").

### 1.8 Permission denied by auto-mode classifier

- **Detection.** `PermissionDenied` hook.
- **Render.** Toast in the session view; do not mark "needs you"
  (Claude will adapt automatically unless `retry: true` returns).

---

## Tier 2 — TUI-only modal state (badge + raw key pad)

Sessions where the desktop TUI has entered a *mode* that hark can't
fully replicate. Render a chip identifying the mode and offer the raw
key pad. No frontend custom UI in MVP.

| Mode | Detection | Keys passed via key pad |
| --- | --- | --- |
| `/resume` session picker | `capture-pane` for "Resume which session?" | `↑ ↓ → ← Enter Esc /` |
| `/model` picker | `capture-pane`; also `SessionStart` `model` may shift after | `↑ ↓ ← → d Enter Esc` |
| `/permissions` manager | `capture-pane` | `Tab ↑ ↓ a d r Enter Esc` |
| `/mcp` server browser | `capture-pane` | `↑ ↓ o x Enter Esc` |
| `/plugin` marketplace | `capture-pane` | `Tab ↑ ↓ Space f Enter Esc` |
| `/agents` picker | `capture-pane` | `↑ ↓ Enter Esc` |
| `/doctor` / `/hooks` / `/config` | `capture-pane` | `↑ ↓ Enter Esc` |
| Transcript viewer (`Ctrl+O`) | `capture-pane`; ANSI alt-screen toggle | `↑ ↓ q Esc Ctrl+E { } v [` |
| Reverse search (`Ctrl+R`) | `capture-pane` | type + `Ctrl+R Ctrl+S Tab Enter Esc Ctrl+C` |
| Rewind menu (`Esc Esc` on empty) | `capture-pane` | `↑ ↓ Enter Esc` |
| Vim mode (`/config` → Editor mode) | flag from `/config`; we don't try | raw text + `Esc` only |
| Voice dictation (`Space` / `/voice tap`) | `capture-pane` | none — voice is local-mic-only |
| `/btw` side question overlay | `capture-pane` | `Space Enter Esc` to dismiss |
| Auto-mode opt-in (`y/n`) | `capture-pane` | `y n Enter Esc` |
| Image-paste confirm (`Ctrl+V`) | `capture-pane` — not reachable from hark | n/a |

Keep this tier's render simple: a single-line "mode chip" above the
key pad, e.g. `Mode: /model picker — use ↑↓ Enter`.

---

## Tier 3 — composer features that already work via raw text

No special UI; the user types and hark sends the bytes.

- `/` slash command picker — user types the full command + args.
- `@` file mention — user types the full path.
- `#` memory tag, `!` shell prefix — user types the prefix in the
  composer.
- Multi-line input — the composer already handles Shift+Enter →
  newline → bracketed-paste send.
- Prompt suggestions (gray ghost text) — desktop-only nicety; hark
  doesn't show it and doesn't need to.

---

## Server-side changes required

The interesting prompts (0.2 `AskUserQuestion`, 0.4 elicitation)
need hark's hook endpoint to return a **structured JSON response**,
not just a 200. That changes the architecture in three places:

1. **`src/bin/install-hooks.ts`** currently installs the hook as a
   one-shot `curl … || true`. To respond with a decision body, the
   hook command needs `curl --max-time 600 -X POST -H 'Content-Type:
   application/json' --data-binary @- '<url>'` *without* `>/dev/null`
   so stdout from `curl` (the server's response body) is what Claude
   reads. Verify that Claude Code parses stdout JSON the same way for
   HTTP hooks as it does for command hooks — the docs imply yes
   ("HTTP hooks … must return 2xx with JSON containing decision
   fields").
2. **`src/server.ts`** today accepts the hook POST, records it, and
   replies immediately. For 0.2 and 0.4 the request must *block*
   until the user answers, then respond with the decision JSON. This
   is a long-poll on the server side: open the request, wait on a
   per-session promise resolved when the frontend POSTs the answer
   to a new endpoint (`POST /api/sessions/:id/respond`), then write
   the decision body back to the hook caller.
3. **`src/lib/hookState.ts`** needs a `pendingResponse` slot (a
   resolver function) alongside `pendingPermission`. On
   `clear(sessionId)` with an answer, resolve the promise; on
   timeout (e.g., 590s, just under Claude Code's 600s), resolve
   with `behavior: "deny"`.

This is the single biggest change in the catalog. Without it, hark
can only *render* AskUserQuestion / elicitation forms — not answer
them — and the user has to walk to the desktop to submit. Which
defeats the point.

(Alternative for AskUserQuestion specifically: keep the hook
fire-and-forget, render the form on hark, then write the answers
into the pane as text — "Summary, Introduction Conclusion". Claude
will parse it from the visible TUI. Less clean, but no server
changes. Worth comparing in a spike.)

---

## Data model changes

`SessionAttention` (in `src/lib/hookState.ts`) currently captures
`pendingPermission?: PendingPermission`. Replace with a discriminated
union of all blocked-on-user states so the frontend can switch on
`pending.kind`:

```ts
type Pending =
  | { kind: "permission"; toolName: string; toolInput: unknown; toolUseId: string }
  | { kind: "askUserQuestion"; questions: AskQuestion[]; toolUseId: string }
  | { kind: "exitPlanMode"; plan: string; toolUseId: string }
  | { kind: "elicitation"; serverName: string; fields: ElicitationField[] }
  | { kind: "oauth"; message: string }
  | { kind: "trustDialog" }              // tmux-detected
  | { kind: "tuiMode"; mode: TuiMode };  // tmux-detected
```

Plus a separate `lastError?: { errorType: string; errorMessage: string }`
fed by `StopFailure`, and a `runtime: { subagents: Agent[]; tasks:
TaskList; compactionInProgress: boolean }` block fed by the tier-1
hooks.

The SSE event shape on `web/src/lib/protocol.ts` follows from there.

---

## Phased build order

The order below front-loads the highest-impact items.

**P0 — closes the worst of the current gap (1 week)**

1. **AskUserQuestion form** (0.2). Render the questions, collect
   answers, write a Submit-as-text fallback first (no server changes),
   then upgrade to the long-poll hook response.
2. **Rich permission cards** (0.1). Per-tool layouts for Bash, Edit,
   Write, Read, WebFetch, Agent, MCP. Most are 1-day each; this is
   pure frontend.
3. **ExitPlanMode markdown rendering** (0.3). Plan in scroll panel,
   three labelled buttons. Composer already half-does this.
4. **StopFailure error chips** (1.2). Sidebar colour, retry button.

**P1 — wider hook coverage (1 week)**

5. Wire `Elicitation` / `ElicitationResult` (0.4) with the long-poll
   responder. Build a generic form generator from `form_fields`.
6. Wire `SessionStart` / `SessionEnd` / `CwdChanged` (1.5, 1.6)
   for header + sidebar metadata.
7. Wire `SubagentStart` / `SubagentStop` / `TaskCreated` /
   `TaskCompleted` (1.3, 1.7) for per-session activity panel.
8. Wire `PreCompact` / `PostCompact` (1.4) for "compacting…" badge.

**P2 — raw-key fallback hardening (3 days)**

9. Implement `tmux capture-pane` polling for actively-viewed sessions
   (last 30 lines, 1Hz). Detect tier-2 modes by regex.
10. Render the "mode chip" + scoped key pad for each detected mode.
11. Auth + trust dialogs (0.5, 0.6) — badge + key pad.

**P3 — nice-to-haves (deferred)**

12. Per-tool MCP renderers (0.1 sub-case) that pretty-print specific
    server inputs (`mcp__github__*`, `mcp__slack__*`, etc.).
13. Option previews for AskUserQuestion (`previewFormat: "html"`) —
    only matters if hark queries Claude Code with that setting set on
    its side, which today it doesn't control. Defer until/unless
    hark spawns sessions with custom `toolConfig`.

---

## Verification checklist

Things to confirm by exercising on a real Claude Code install before
shipping each item. None of these are answered by the docs alone.

- [ ] Does `PermissionRequest` actually fire for `tool_name=
      "AskUserQuestion"` in Claude Code TUI (vs. only via SDK
      `canUseTool`)? If not, fall back to JSONL detection (the tool
      call lands in the assistant message before the prompt appears).
- [ ] Does Claude Code's HTTP hook caller wait for the response body
      before unblocking, or is it fire-and-forget? Probe with a hook
      that sleeps + returns `{behavior:"deny"}` and check whether the
      desktop TUI still shows the prompt.
- [ ] When two `AskUserQuestion` calls happen back-to-back (Claude
      asks a clarifying question, gets answer, asks another), does
      each get its own `PermissionRequest`/`tool_use_id`? (The catalog
      assumes yes — confirm.)
- [ ] What's the actual `notification_type` set when an MCP server
      kicks off OAuth? The docs list `auth_success` for completion
      but not the start.
- [ ] Does `StopFailure` reliably fire for rate-limit errors, or do
      they show as `Stop` with no failure metadata?
- [ ] Vim mode + voice dictation: detectable from `/config` at all,
      or only via `capture-pane`?

---

## Sources

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) —
  the canonical hook event list and payload schemas (27 events as of
  May 2026).
- [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode) —
  full keyboard shortcut and TUI mode reference.
- [Agent SDK — Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input) —
  authoritative spec for `AskUserQuestion` schema, `canUseTool`
  callback, and decision response shape.
- [Issue #33625 — Remote Control AskUserQuestion UI missing](https://github.com/anthropics/claude-code/issues/33625) —
  confirms even Anthropic's own mobile client hasn't fully solved
  AskUserQuestion rendering; this is an opportunity.
- `docs/interactions.md` — the prior survey doc this builds on.
- `src/lib/hookState.ts`, `src/lib/installHook.ts`, `src/server.ts`,
  `web/src/components/Composer.tsx` — existing hark surface area
  whose data shape and endpoints this catalog redesigns.
