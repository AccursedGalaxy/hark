# Charter-as-Stdout: Injecting Role Persona via Bash Result

**Concept**: Instead of force-typing keystrokes into a live agent session, inject a persona/instructions by having the session run a CLI command whose STDOUT is the charter text — the agent reads it as a Bash tool result and adopts the role.

**Context**: Test harnesses and orchestration systems often need to promote a running Claude Code session to a specific role (e.g., "become the PM-Head for this project"). Keystroke simulation is fragile (timing, buffering, visibility). The charter-as-stdout pattern is cleaner: the agent naturally reads the Bash result and incorporates the persona into its context.

**Pattern**:

1. The orchestrator has a role charter stored or templated (e.g., a file or endpoint).
2. The orchestrator runs a Bash command in the session that outputs the charter:
   ```bash
   cat /path/to/pm-head-charter.txt
   # or
   curl http://server/charters/pm-head
   ```
3. The agent sees the charter as the Bash tool result and adopts the role naturally in its next turn:
   ```
   $ cat pm-head-charter.txt
   [charter text here]
   
   (agent reads this and says "Got it, I'm now acting as the PM-Head for this project...")
   ```

4. **Self-identification**: Use `CLAUDE_CODE_SESSION_ID` (available in Bash env) for the command to fetch the right charter or log the promotion:
   ```bash
   curl http://server/charter?session_id=$CLAUDE_CODE_SESSION_ID
   ```

**Example**: An orchestration test harness wants to promote a running agent to the project's PM-Head role:
- `echo "You are the PM-Head for the Hark project. Your responsibilities are: [...]" | tr '\n' ' '`
- Bash returns this as a result
- Agent sees it and says "Understood, I'm now operating as PM-Head"
- No live keystroke injection, no session restart needed

**Tradeoffs**:
- **Pro**: No race conditions or timing issues; agent reads charter as natural tool result.
- **Pro**: Can be combined with PreToolUse decision hooks (server approves the charter injection).
- **Pro**: Works over remote sessions (Bash result is just text).
- **Con**: Charter must fit in reasonable Bash output (typically fine; >1MB charter is unusual).
- **Con**: Agent is not forced to adopt the role (it can politely decline if the charter conflicts with its instructions). This is actually a feature for safety.

**Related**: `claude-code-decision-hooks.md` (using UserPromptSubmit to inject context at prompt time instead).

---

*Captured: 2026-05-29; source: PM-Head Orchestration Harness validation (hark branch pm-head-harness).*
