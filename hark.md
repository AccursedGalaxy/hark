# Claude Code Task Management

Instead of doing everything headless with `claude -p`, this is a general
notification and control center for Claude Code sessions. The web app reads
and writes to sessions running in tmux panes — it does not replace the TUI;
it remote-controls it.

## Purpose

- **Unified dashboard** — every active Claude Code session on the host visible in one place.
- **Full client experience** — drive any session from any device on your tailnet (phone, second laptop), "like sitting at the desktop."
- **Attention triage** — hook-driven push events surface "this session needs you" without polling.

## Architecture

### Read path (Claude → web)

1. **Discovery + status:** `~/.claude/sessions/<pid>.json` — one file per live Claude process; gives `sessionId`, `cwd`, `kind`, `status`, `updatedAt`. Polled every few seconds; PIDs filtered by liveness (`kill(pid, 0)`).
2. **Transcript:** `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — structured event log (user/assistant/tool_use/tool_result). Full read on session open, then tailed via `fs.watch` + byte-offset tracking.
3. **Push events:** Claude Code hooks (`Notification`, `Stop`) `curl` the server, which fans out to SSE subscribers.

### Write path (web → Claude)

- `tmux send-keys -t <pane> -l "<text>"` for literal text (bracketed paste for multi-line).
- `tmux send-keys -t <pane> Enter` to submit.
- Special keys for action buttons: `Approve` → `1\r`, `Deny` → `2\r`, `Cancel` → `Escape`.
- Pane resolved per session by reading `TMUX_PANE` from `/proc/<pid>/environ` (single env-var lookup; no PID walking).

### Real-time transport

Server-Sent Events (SSE). Browser opens one stream per session it is actively viewing. Plain HTTP — survives Tailscale and any future tunnel without special config; auto-reconnects on flaky mobile networks.

### Sessions without a tmux pane

Bg/agent sessions and terminal-launched-without-tmux sessions have no `TMUX_PANE`. Visible in sidebar with a badge; transcript readable; composer disabled.

## Access control

Every `/api` route is token-protected (the write path is `tmux send-keys` into live sessions — an open port would be RCE for the whole tailnet/LAN). The static app shell stays open so the login screen can load; all data lives behind `/api`.

- **Token:** `~/.config/hark/token` (0600), generated on first boot — the server logs the path, never the token. `HARK_AUTH_TOKEN` overrides it for tests/dev.
- **Browsers:** log in once per device — the login screen exchanges the token for a 1-year `hark_auth` cookie (a SHA-256 digest of the token, so the cookie jar never holds the secret).
- **Loopback is exempt:** local Claude Code hooks and CLI curls against `localhost` need no credentials (checked against the socket peer address, never spoofable headers).
- **Scripts:** send `Authorization: Bearer $(cat ~/.config/hark/token)`.
- **Rotation:** delete the token file and restart the server — a new token is generated and every issued cookie is invalidated at once.

## Design decisions

| #  | Topic        | Choice                                                                 |
| -- | ------------ | ---------------------------------------------------------------------- |
| 1  | Purpose      | Unified dashboard + full mobile/remote control                         |
| 2  | Bridge       | Structured read (JSONL + hooks) + tmux `send-keys` write               |
| 3  | Access       | Tailscale mesh (bind to mesh interface; no auth UI in MVP)             |
| 4  | Transport    | Server-Sent Events                                                     |
| 5  | Hooks model  | Notify-only — never block Claude on a web decision                     |
| 6  | Hook set     | `Notification` + `Stop` only                                           |
| 7  | Send UX      | Chat-app (Enter = send, Shift+Enter = newline, action buttons for keys)|
| 8  | Layout       | Focus-one + sidebar                                                    |
| 9  | Spawning     | Yes, via `tmux new-window`                                             |
| 10 | Lifecycle    | systemd `--user` service                                               |
| 11 | History      | Full JSONL transcript on open                                          |
| 12 | Push alerts  | In-app indicators MVP; Web Push later                                  |
| 13 | Non-tmux     | Read-only with badge                                                   |
| 14 | Sidebar sort | Flat: needs-attention → busy → idle (recent) → idle (old)              |
| 15 | MVP scope    | Vertical slice: one session end-to-end                                 |

## MVP — vertical slice

Build one session end-to-end before adding breadth.

1. Click a session in the sidebar → main pane shows transcript header + body + composer.
2. `GET /api/sessions/:id/transcript` — full JSONL, parsed into structured events.
3. `GET /api/sessions/:id/stream` — SSE; tails new events as the file grows.
4. `POST /api/sessions/:id/send` — body `{text}` or `{key}`; bracketed-paste send-keys + Enter.
5. Action buttons: Approve (`1\r`), Deny (`2\r`), Cancel (`Escape`).
6. Manual end-to-end test: drive a real session from another device on the tailnet.

## Phase 2+

- **Hooks installation** — drop `Notification` + `Stop` into `~/.claude/settings.json` pointing at `http://localhost:3000/api/hook`.
- **Attention-sorted sidebar** — wire hook events to per-session `needsAttention` flag; bump session to top.
- **Spawn new session** — `+ New session` button → `tmux new-window -d 'cd <dir> && claude'`.
- **systemd user service** — ship a `hark.service` unit file; one-time `systemctl --user enable`.
- **In-app alerts** — favicon badge, document title, optional sound on `Notification`.
- **Web Push** — service worker + VAPID; closed-app notifications on mobile.

## Constraints / non-goals

- Linux-only — reads `/proc/<pid>/environ` to resolve panes.
- Single-user — runs as your unix user, drives only your tmux sessions.
- No auth UI — Tailscale provides device identity; bind to mesh interface.
- No database — state lives on disk in `~/.claude/`. Server is stateless across restarts.
- Not a TUI replacement — designed to coexist with terminal use, not replace it.

## TDD workflow

Modules built test-first with `vitest`:

- `src/lib/pane.ts` — pure environ parser + I/O wrapper.
- `src/lib/sendKeys.ts` — argv builder for `tmux send-keys`; execution wrapper.
- `src/lib/transcript.ts` — JSONL → normalized events; tail-from-offset iterator.

Each module: write a failing test, implement the minimum, verify green, refactor. Integration (server endpoints, SSE) tested manually against a real Claude session.
