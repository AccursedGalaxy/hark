// Standalone preview page for the PromptPanel variants. Loaded at /preview
// via Vite's multi-page support. Lets us screenshot every Tier-0 pending
// state without needing a live Claude session — useful for catching layout
// regressions during code review.
//
// Not bundled by the main entry; only built when /preview.html is requested.

import { createRoot } from "react-dom/client";
import { PromptPanel } from "./components/PromptPanel";
import { QuestionCard } from "./components/QuestionCard";
import type {
  AskQuestion,
  Pending,
  SendBody,
  SessionError,
} from "./lib/protocol";
import "./styles/index.css";

const noop = async (_body: SendBody) => {};

// Standalone QuestionCard samples — this is the dock component the live
// composer actually renders for AskUserQuestion. Keeping a preview sample
// catches multi-select regressions without spinning up a real session.
const askCardSamples: Array<{ title: string; questions: AskQuestion[] }> = [
  {
    title: "QuestionCard — single-select",
    questions: [
      {
        question: "Pick the next branch to ship",
        header: "Branch",
        options: [
          { label: "main", description: "stable" },
          { label: "next", description: "release candidate" },
          { label: "experimental" },
        ],
        multiSelect: false,
      },
    ],
  },
  {
    title: "QuestionCard — multi-select (issue #10)",
    questions: [
      {
        question: "Confirm which gitignored clutter to remove from the repo root?",
        header: "Cleanup scope",
        options: [
          {
            label: "21 loose *.png screenshots (~3.5 MB)",
            description: "hark-*.png, rail-*.png, tasklist-*.png — dev session screenshots",
          },
          {
            label: ".playwright-mcp/ (2.8 MB)",
            description: "Playwright MCP cache: console logs, page yml dumps",
          },
          {
            label: "dist/ (160 KB)",
            description: "Compiled server output from `tsc`",
          },
          {
            label: "public/assets/ (Vite build output)",
            description: "index-*.js / index-*.css produced by `npm run build`",
          },
        ],
        multiSelect: true,
      },
    ],
  },
];

const samples: Array<{
  title: string;
  pending?: Pending;
  lastError?: SessionError;
}> = [
  {
    title: "Bash permission (with description + timeout + background)",
    pending: {
      kind: "tool_permission",
      toolName: "Bash",
      toolInput: {
        command: "npm test -- --run promptState",
        description: "Run the prompt-state unit tests",
        timeout: 120000,
        run_in_background: true,
      },
      requestedAt: Date.now(),
    },
  },
  {
    title: "Edit permission (with old/new diff)",
    pending: {
      kind: "tool_permission",
      toolName: "Edit",
      toolInput: {
        file_path: "/home/aki/Projects/hark/src/server.ts",
        old_string: "const port = Number(process.env.PORT) || 3000;",
        new_string:
          "const port = Number(process.env.PORT) || 3000;\n// new comment line",
      },
      requestedAt: Date.now(),
    },
  },
  {
    title: "Write permission",
    pending: {
      kind: "tool_permission",
      toolName: "Write",
      toolInput: {
        file_path: "/home/aki/Projects/hark/scratch/notes.md",
        content: "# Notes\n\n- one\n- two\n- three\n",
      },
      requestedAt: Date.now(),
    },
  },
  {
    title: "Read permission (with offset/limit)",
    pending: {
      kind: "tool_permission",
      toolName: "Read",
      toolInput: {
        file_path: "/home/aki/Projects/hark/src/server.ts",
        offset: 100,
        limit: 50,
      },
      requestedAt: Date.now(),
    },
  },
  {
    title: "WebFetch permission",
    pending: {
      kind: "tool_permission",
      toolName: "WebFetch",
      toolInput: {
        url: "https://code.claude.com/docs/en/hooks",
        prompt: "Summarize the PermissionRequest payload schema",
      },
      requestedAt: Date.now(),
    },
  },
  {
    title: "WebSearch permission",
    pending: {
      kind: "tool_permission",
      toolName: "WebSearch",
      toolInput: { query: "claude code hook spec PermissionRequest 2026" },
      requestedAt: Date.now(),
    },
  },
  {
    title: "Agent / subagent spawn",
    pending: {
      kind: "tool_permission",
      toolName: "Agent",
      toolInput: {
        subagent_type: "general-purpose",
        description: "Investigate hook timing",
        prompt:
          "Probe how Claude Code's HTTP hook caller handles a slow response. Specifically: does it block on body read for PermissionRequest? Report under 200 words.",
        isolation: "worktree",
      },
      requestedAt: Date.now(),
    },
  },
  {
    title: "MCP tool permission",
    pending: {
      kind: "tool_permission",
      toolName: "mcp__github__create_issue",
      toolInput: {
        owner: "anthropics",
        repo: "claude-code",
        title: "Document HTTP hook response schema",
        body: "The docs are silent on whether HTTP hooks block-and-respond for PermissionRequest…",
      },
      requestedAt: Date.now(),
    },
  },
  {
    title: "AskUserQuestion — single question, single-select with preview",
    pending: {
      kind: "ask_user_question",
      questions: [
        {
          question: "How should I format the output?",
          header: "Format",
          options: [
            {
              label: "Summary",
              description: "Brief overview — 3–5 bullets",
              preview:
                "**Summary**\n- key finding 1\n- key finding 2\n- key finding 3",
            },
            {
              label: "Detailed",
              description: "Step-by-step with code samples",
              preview:
                "```ts\nfunction example() {\n  // detailed walkthrough\n}\n```",
            },
          ],
          multiSelect: false,
        },
      ],
      requestedAt: Date.now(),
    },
  },
  {
    title: "AskUserQuestion — 2 questions, multi-select on the second",
    pending: {
      kind: "ask_user_question",
      questions: [
        {
          question: "What's the desired outcome?",
          header: "Outcome",
          options: [
            { label: "Ship it" },
            { label: "Get a second opinion" },
            { label: "Iterate" },
          ],
          multiSelect: false,
        },
        {
          question: "Which sections should I include in the writeup?",
          header: "Sections",
          options: [
            { label: "Background" },
            { label: "Approach" },
            { label: "Tradeoffs" },
            { label: "Open questions" },
          ],
          multiSelect: true,
        },
      ],
      requestedAt: Date.now(),
    },
  },
  {
    title: "ExitPlanMode — markdown plan + 3 actions",
    pending: {
      kind: "exit_plan_mode",
      plan: `# Refactor plan

## Goals

1. Extract \`describeTool\` into pure helpers — testable
2. Wire into \`PromptPanel\` — same UI, cleaner code
3. Add tests covering each tool family

## Risks

- Diff renderer needs structuredPatch from \`toolUseResult\`; permission UI
  only has \`old_string\`/\`new_string\` — render those side by side instead.

## Verification

\`\`\`bash
npm test -- --run promptFormat
\`\`\`
`,
      requestedAt: Date.now(),
    },
  },
  {
    title: "Elicitation — MCP form with multiple field types",
    pending: {
      kind: "elicitation",
      serverName: "github",
      message: "Which repo and visibility?",
      fields: [
        {
          name: "repo",
          type: "string",
          required: true,
          description: "owner/name (e.g. anthropics/claude-code)",
        },
        {
          name: "visibility",
          type: "enum",
          options: ["public", "private", "internal"],
          required: true,
        },
        {
          name: "auto_init",
          type: "boolean",
          required: false,
          description: "Initialise with a README",
        },
      ],
      requestedAt: Date.now(),
    },
  },
  {
    title: "OAuth — waiting on desktop",
    pending: {
      kind: "oauth",
      message:
        "GitHub MCP server requires you to authenticate. Open the desktop and approve in your browser.",
      requestedAt: Date.now(),
    },
  },
  {
    title: "StopFailure — rate limit",
    lastError: {
      errorType: "rate_limit",
      errorMessage:
        "You've hit the rate limit for claude-opus-4-7. Try again in 32s, switch to claude-sonnet-4-6, or upgrade your plan at console.anthropic.com.",
      occurredAt: Date.now(),
    },
  },
  {
    title: "StopFailure — billing",
    lastError: {
      errorType: "billing_error",
      errorMessage: "Your plan does not include access to claude-opus-4-7.",
      occurredAt: Date.now(),
    },
  },
];

function Preview() {
  return (
    <div style={{ maxWidth: 720, margin: "32px auto", padding: "0 16px" }}>
      <h1 style={{ marginBottom: 24 }}>PromptPanel preview</h1>
      {askCardSamples.map((sample, i) => (
        <section key={`ask-${i}`} style={{ marginBottom: 32 }}>
          <h2
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--fg-3)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 8,
            }}
          >
            {sample.title}
          </h2>
          <QuestionCard questions={sample.questions} busy={false} onSend={noop} />
        </section>
      ))}
      {samples.map((sample, i) => (
        <section key={i} style={{ marginBottom: 32 }}>
          <h2
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--fg-3)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 8,
            }}
          >
            {sample.title}
          </h2>
          <PromptPanel
            pending={sample.pending ?? null}
            lastError={sample.lastError ?? null}
            busy={false}
            onSend={noop}
          />
        </section>
      ))}
    </div>
  );
}

const root = document.getElementById("preview-root");
if (root) createRoot(root).render(<Preview />);
