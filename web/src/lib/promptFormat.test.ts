import { describe, expect, it } from "vitest";
import type { AskQuestion, ElicitationField } from "./protocol";
import {
  describeToolHeader,
  errorHint,
  formatAskAnswerText,
  formatAskKeySequence,
  formatElicitationText,
  hostOf,
  isAskAnswerComplete,
  isElicitationComplete,
  OTHER_SENTINEL,
  prettyPath,
  splitMcpToolName,
} from "./promptFormat";

// ---- AskUserQuestion completion + text formatting ------------------------

const formatQ: AskQuestion = {
  question: "How should I format the output?",
  header: "Format",
  options: [
    { label: "Summary" },
    { label: "Detailed" },
  ],
  multiSelect: false,
};
const sectionsQ: AskQuestion = {
  question: "Which sections should I include?",
  header: "Sections",
  options: [
    { label: "Introduction" },
    { label: "Body" },
    { label: "Conclusion" },
  ],
  multiSelect: true,
};

describe("isAskAnswerComplete", () => {
  it("returns false when a question has no selection", () => {
    expect(isAskAnswerComplete([formatQ], [[]], [""])).toBe(false);
  });

  it("returns true when every question has a pick", () => {
    expect(isAskAnswerComplete([formatQ], [["Summary"]], [""])).toBe(true);
  });

  it("requires the 'Other' free-text to be non-blank when Other is selected", () => {
    expect(
      isAskAnswerComplete([formatQ], [[OTHER_SENTINEL]], [""]),
    ).toBe(false);
    expect(
      isAskAnswerComplete([formatQ], [[OTHER_SENTINEL]], ["my custom"]),
    ).toBe(true);
  });

  it("multi-question prompts require every question to be answered", () => {
    expect(
      isAskAnswerComplete(
        [formatQ, sectionsQ],
        [["Summary"], []],
        ["", ""],
      ),
    ).toBe(false);
    expect(
      isAskAnswerComplete(
        [formatQ, sectionsQ],
        [["Summary"], ["Introduction", "Conclusion"]],
        ["", ""],
      ),
    ).toBe(true);
  });
});

describe("formatAskAnswerText", () => {
  it("renders a single-question, single-select prompt as the bare label", () => {
    expect(formatAskAnswerText([formatQ], [["Summary"]], [""])).toBe(
      "Summary",
    );
  });

  it("joins multi-select picks with ', '", () => {
    expect(
      formatAskAnswerText(
        [sectionsQ],
        [["Introduction", "Conclusion"]],
        [""],
      ),
    ).toBe("Introduction, Conclusion");
  });

  it("expands the OTHER sentinel to the free-text value", () => {
    expect(
      formatAskAnswerText(
        [formatQ],
        [[OTHER_SENTINEL]],
        ["table"],
      ),
    ).toBe("table");
  });

  it("multi-question prompts prefix every answer with a header so Claude can map them", () => {
    const out = formatAskAnswerText(
      [formatQ, sectionsQ],
      [["Summary"], ["Introduction", "Conclusion"]],
      ["", ""],
    );
    expect(out).toBe(
      "Format: Summary\nSections: Introduction, Conclusion",
    );
  });

  it("falls back to question text when header is missing on multi-question prompts", () => {
    const noHeader: AskQuestion = {
      question: "What's the verdict?",
      options: [{ label: "Yes" }, { label: "No" }],
    };
    const out = formatAskAnswerText(
      [noHeader, formatQ],
      [["Yes"], ["Summary"]],
      ["", ""],
    );
    expect(out).toBe("What's the verdict?: Yes\nFormat: Summary");
  });
});

// ---- AskUserQuestion native TUI key sequence -----------------------------

describe("formatAskKeySequence", () => {
  it("single-select first option: reset to top + Enter (no Downs needed)", () => {
    const keys = formatAskKeySequence([formatQ], [["Summary"]], [""]);
    // formatQ has 2 options → total rows = 2 + Other = 3 → three Up's reset.
    expect(keys).toEqual(["Up", "Up", "Up", "Enter"]);
  });

  it("single-select second option: reset + 1 Down + Enter", () => {
    const keys = formatAskKeySequence([formatQ], [["Detailed"]], [""]);
    expect(keys).toEqual(["Up", "Up", "Up", "Down", "Enter"]);
  });

  it("multi-select picks each option with Space then confirms with Enter", () => {
    // sectionsQ has 3 options. Picking Introduction (0) and Conclusion (2)
    // → reset+Space, reset+Down+Down+Space, Enter.
    const keys = formatAskKeySequence(
      [sectionsQ],
      [["Introduction", "Conclusion"]],
      [""],
    );
    // total = 3 + Other = 4 Ups per reset.
    expect(keys).toEqual([
      "Up", "Up", "Up", "Up", "Space",
      "Up", "Up", "Up", "Up", "Down", "Down", "Space",
      "Enter",
    ]);
  });

  it("multi-question forms chain sequences in declaration order", () => {
    const keys = formatAskKeySequence(
      [formatQ, sectionsQ],
      [["Detailed"], ["Body"]],
      ["", ""],
    );
    expect(keys).toEqual([
      // Q1 (single): reset + 1 Down + Enter.
      "Up", "Up", "Up", "Down", "Enter",
      // Q2 (multi): reset + 1 Down + Space + Enter.
      "Up", "Up", "Up", "Up", "Down", "Space", "Enter",
    ]);
  });

  it("returns null when any question selects 'Other' (free text path)", () => {
    expect(
      formatAskKeySequence([formatQ], [[OTHER_SENTINEL]], ["custom"]),
    ).toBeNull();
  });

  it("returns null when a label doesn't match any declared option", () => {
    expect(
      formatAskKeySequence([formatQ], [["Bogus"]], [""]),
    ).toBeNull();
  });
});

// ---- Elicitation completion + text formatting ---------------------------

const repoF: ElicitationField = {
  name: "repo",
  type: "string",
  required: true,
};
const optionalF: ElicitationField = {
  name: "branch",
  type: "string",
  required: false,
};

describe("isElicitationComplete", () => {
  it("requires every required field to be filled", () => {
    expect(isElicitationComplete([repoF], {})).toBe(false);
    expect(isElicitationComplete([repoF], { repo: "x" })).toBe(true);
  });

  it("is satisfied when only optional fields are blank", () => {
    expect(
      isElicitationComplete([repoF, optionalF], { repo: "x" }),
    ).toBe(true);
  });
});

describe("formatElicitationText", () => {
  it("renders YAML-ish 'name: value' lines", () => {
    expect(
      formatElicitationText(
        [repoF, optionalF],
        { repo: "anthropics/claude", branch: "main" },
      ),
    ).toBe("repo: anthropics/claude\nbranch: main");
  });

  it("emits blanks for missing fields rather than dropping them", () => {
    expect(
      formatElicitationText([repoF, optionalF], { repo: "x" }),
    ).toBe("repo: x\nbranch: ");
  });
});

// ---- Pretty path / host shortening --------------------------------------

describe("prettyPath", () => {
  it("returns short paths unchanged", () => {
    expect(prettyPath("/a/b")).toBe("/a/b");
  });

  it("shortens deep paths to '…/last-three'", () => {
    expect(
      prettyPath(
        "/home/aki/Projects/hark-experimental-fork/web/src/components/Composer.tsx",
      ),
    ).toBe("…/src/components/Composer.tsx");
  });

  it("leaves shallow paths alone even if long", () => {
    const p = "/a/" + "b".repeat(60);
    expect(prettyPath(p)).toBe(p);
  });
});

describe("hostOf", () => {
  it("extracts the host for valid URLs", () => {
    expect(hostOf("https://example.com/path")).toBe("example.com");
  });

  it("returns undefined for malformed input", () => {
    expect(hostOf("not a url")).toBeUndefined();
  });
});

// ---- MCP tool name splitter ----------------------------------------------

describe("splitMcpToolName", () => {
  it("splits mcp__server__tool into pieces", () => {
    expect(splitMcpToolName("mcp__github__create_issue")).toEqual({
      server: "github",
      tool: "create_issue",
    });
  });

  it("preserves double-underscores in the tool segment", () => {
    expect(splitMcpToolName("mcp__claude_ai_Gmail__create_label")).toEqual({
      server: "claude_ai_Gmail",
      tool: "create_label",
    });
  });

  it("returns null for non-MCP names", () => {
    expect(splitMcpToolName("Bash")).toBeNull();
    expect(splitMcpToolName("AskUserQuestion")).toBeNull();
  });
});

// ---- Tool descriptor (per-tool header shape) -----------------------------

describe("describeToolHeader", () => {
  it("Bash: badge is Bash, tone command, hint includes timeout + background", () => {
    expect(
      describeToolHeader("Bash", {
        command: "npm test",
        timeout: 60000,
        run_in_background: true,
      }),
    ).toEqual({
      badge: "Bash",
      tone: "command",
      hint: "timeout 60000ms · background",
    });
  });

  it("Bash with no extras has no hint", () => {
    expect(describeToolHeader("Bash", { command: "ls" })).toEqual({
      badge: "Bash",
      tone: "command",
    });
  });

  it("Edit: tone path, badgeDetail is pretty file path", () => {
    expect(
      describeToolHeader("Edit", {
        file_path:
          "/home/aki/Projects/hark-experimental-fork/web/src/components/Composer.tsx",
      }),
    ).toEqual({
      badge: "Edit",
      tone: "path",
      badgeDetail: "…/src/components/Composer.tsx",
    });
  });

  it("Read: hint includes offset + limit", () => {
    expect(
      describeToolHeader("Read", {
        file_path: "/a/b.ts",
        offset: 10,
        limit: 50,
      }),
    ).toMatchObject({
      badge: "Read",
      tone: "path",
      hint: "offset 10 · limit 50",
    });
  });

  it("WebFetch: badge WebFetch, badgeDetail is host", () => {
    expect(
      describeToolHeader("WebFetch", { url: "https://example.com/foo" }),
    ).toEqual({
      badge: "WebFetch",
      tone: "url",
      badgeDetail: "example.com",
    });
  });

  it("Agent: badge Agent, badgeDetail is subagent type, hint includes isolation", () => {
    expect(
      describeToolHeader("Agent", {
        subagent_type: "general-purpose",
        isolation: "worktree",
      }),
    ).toEqual({
      badge: "Agent",
      badgeDetail: "general-purpose",
      tone: "agent",
      hint: "isolation: worktree",
    });
  });

  it("MCP tool: badge MCP, badgeDetail splits server/tool", () => {
    expect(
      describeToolHeader("mcp__github__create_issue", { title: "x" }),
    ).toEqual({
      badge: "MCP",
      badgeDetail: "github · create_issue",
      tone: "mcp",
    });
  });

  it("Unknown tool falls through with raw tone", () => {
    expect(describeToolHeader("FuturePlugin", { x: 1 })).toEqual({
      badge: "FuturePlugin",
      tone: "raw",
    });
  });
});

// ---- StopFailure hint mapping --------------------------------------------

describe("errorHint", () => {
  it("maps known error_types to human labels", () => {
    expect(errorHint("rate_limit")).toMatch(/Rate limited/);
    expect(errorHint("billing_error")).toMatch(/Billing/);
    expect(errorHint("max_output_tokens")).toMatch(/continue/);
  });

  it("falls back to the generic 'Stopped with an error' for unknowns", () => {
    expect(errorHint("future_thing")).toBe("Stopped with an error");
  });
});
