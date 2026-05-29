# Claude Code Synchronous Decision Hooks

**Concept**: PreToolUse and UserPromptSubmit hooks fire synchronously for every Claude Code session globally; the hook command's STDOUT is parsed as a JSON decision response that can block tool calls or inject context.

**Context**: Unlike fire-and-forget notification hooks, decision hooks run in the critical path and allow a server to approve/deny tool calls or inject instructions into a session in real time. This enables guardrails and context-injection patterns without force-typing into a live conversation.

**Pattern**:

1. **Installation**: The hook command must preserve stdout and fail open. Use `curl ... 2>/dev/null || true` (stderr discarded, stdout preserved, `|| true` fails open so a server outage never blocks tool calls).

2. **Hook event types**:
   - **PreToolUse**: Fires before any tool call. Server response:
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "PreToolUse",
         "permissionDecision": "deny",
         "permissionDecisionReason": "tool blocked by policy"
       }
     }
     ```
     Return `{}` or omit `permissionDecision` for no opinion (normal flow proceeds).

   - **UserPromptSubmit**: Fires when user submits a prompt. Server response:
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "UserPromptSubmit",
         "additionalContext": "You are now in dev mode..."
       }
     }
     ```
     The context is injected at the top of the turn.

3. **Server-side gating**: Hooks fire for EVERY session globally, so gate decisions on:
   - `session_id` (from hook payload)
   - `cwd` (working directory)
   - `tool_name` (which tool is being called)
   - `tool_input` (what the tool is asked to do)

   This prevents one session's rules from affecting unrelated sessions.

**Example**: A test harness runs an agent session and wants to approve/deny specific tool calls based on test phase. The harness has a hook server that:
- Checks `session_id` and `cwd`
- Blocks `Bash` calls that touch production files (PreToolUse deny)
- Injects a role charter into UserPromptSubmit (see `charter-as-stdout.md`)

**Tradeoffs**:
- **Pro**: Centralized, real-time control over session behavior without keystroke simulation or session restart.
- **Pro**: Fail-open design (server outage doesn't freeze sessions).
- **Con**: Adds latency to every tool call (typically < 100ms if colocated).
- **Con**: Requires server-side session identity and context (setup cost).

**Related**: `charter-as-stdout.md` (injecting persona via hook + Bash result).

---

*Captured: 2026-05-29; source: PM-Head Orchestration Harness validation (hark branch pm-head-harness).*
