import { describe, expect, it } from "vitest";
import {
  buildContractCommand,
  buildHookCommand,
  contractUrlFor,
  installHooks,
  isManagedCommand,
  uninstallHooks,
} from "./installHook.js";

const URL = "http://localhost:3000/api/hook";

describe("buildHookCommand", () => {
  it("produces a curl pipe that posts stdin to the hook url", () => {
    const cmd = buildHookCommand(URL);
    expect(cmd).toContain("curl");
    expect(cmd).toContain(URL);
    expect(cmd).toContain("--data-binary @-");
  });

  it("treats failure as non-fatal (does not block Claude)", () => {
    expect(buildHookCommand(URL)).toMatch(/\|\|\s*true/);
  });

  it("discards stdout for fire-and-forget notification hooks", () => {
    expect(buildHookCommand(URL)).toContain(">/dev/null");
  });
});

describe("isManagedCommand", () => {
  it("identifies a command targeting the configured url", () => {
    expect(isManagedCommand(buildHookCommand(URL), URL)).toBe(true);
  });

  it("identifies the SessionStart contract command as managed", () => {
    expect(isManagedCommand(buildContractCommand(URL), URL)).toBe(true);
  });

  it("does not match unrelated commands", () => {
    expect(isManagedCommand("echo hi", URL)).toBe(false);
    expect(isManagedCommand("curl https://example.com", URL)).toBe(false);
  });
});

describe("contract command (SessionStart)", () => {
  it("derives the contract url from the hook url", () => {
    expect(contractUrlFor(URL)).toBe(
      "http://localhost:3000/api/artifact-contract",
    );
  });

  it("GETs the contract, capped and non-fatal, with stdout kept", () => {
    const cmd = buildContractCommand(URL);
    expect(cmd).toContain("--max-time");
    expect(cmd).toMatch(/\|\|\s*true/);
    // stdout is the whole point — it becomes session context. Only stderr
    // may be discarded (the "2>" form).
    expect(cmd).not.toMatch(/(?<!2)>\/dev\/null/);
  });
});

const MANAGED = [
  "Notification",
  "Stop",
  "StopFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Elicitation",
  "ElicitationResult",
  "SubagentStart",
  "SubagentStop",
  "CwdChanged",
];
// Events the removed orchestration harness used for synchronous decision
// hooks. Never installed anymore; install actively strips stale entries.
const LEGACY = ["PreToolUse", "UserPromptSubmit"];

describe("installHooks", () => {
  it("creates entries for every managed hook event on empty settings", () => {
    const next = installHooks({}, URL);
    // The exhaustive list lives in installHook.ts MANAGED_EVENTS; we assert
    // each event is wired so adding one there forces a test update too.
    for (const ev of MANAGED) {
      expect(next.hooks[ev]).toHaveLength(1);
      expect(next.hooks[ev][0].hooks[0].command).toBe(buildHookCommand(URL));
    }
  });

  it("registers the SessionStart contract hook (stdout-bearing GET)", () => {
    const next = installHooks({}, URL);
    expect(next.hooks.SessionStart).toHaveLength(1);
    expect(next.hooks.SessionStart[0].hooks[0].command).toBe(
      buildContractCommand(URL),
    );
  });

  it("uninstall removes the SessionStart contract hook", () => {
    const next = uninstallHooks(installHooks({}, URL), URL);
    expect(next.hooks?.SessionStart ?? []).toHaveLength(0);
  });

  it("does not register the legacy decision events", () => {
    const next = installHooks({}, URL);
    for (const ev of LEGACY) {
      expect(next.hooks[ev] ?? []).toHaveLength(0);
    }
  });

  it("strips stale managed decision hooks a previous version installed", () => {
    // Simulate settings written by the old orchestration-era installer: a
    // synchronous managed curl under each legacy event, next to a user entry.
    const legacyCurl = `curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- '${URL}' 2>/dev/null || true`;
    const existing = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo before" }] },
          { hooks: [{ type: "command", command: legacyCurl }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: legacyCurl }] },
        ],
      },
    };
    const next = installHooks(existing, URL);
    // Ours is gone, the user's own entry survives.
    expect(next.hooks.PreToolUse).toHaveLength(1);
    expect(next.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(next.hooks.UserPromptSubmit ?? []).toHaveLength(0);
  });

  it("is idempotent — re-installing does not duplicate entries", () => {
    const once = installHooks({}, URL);
    const twice = installHooks(once, URL);
    for (const ev of MANAGED) {
      expect(twice.hooks[ev]).toHaveLength(1);
    }
  });

  it("preserves unrelated keys and a user's own hook on a managed event", () => {
    const existing = {
      model: "claude-opus-4-7",
      hooks: {
        Notification: [
          {
            hooks: [{ type: "command", command: "say 'hi'" }],
          },
        ],
      },
    };
    const next = installHooks(existing, URL);
    expect(next.model).toBe("claude-opus-4-7");
    // existing user Notification entry preserved, our entry added
    expect(next.hooks.Notification).toHaveLength(2);
    const ours = next.hooks.Notification.find((g: any) =>
      g.hooks.some((h: any) => isManagedCommand(h.command, URL)),
    );
    expect(ours).toBeDefined();
  });

  it("does not mutate the input object", () => {
    const input = { hooks: { Stop: [] } };
    const snapshot = JSON.parse(JSON.stringify(input));
    installHooks(input, URL);
    expect(input).toEqual(snapshot);
  });
});

describe("uninstallHooks", () => {
  it("removes only managed entries", () => {
    const installed = installHooks(
      {
        hooks: {
          Notification: [
            { hooks: [{ type: "command", command: "say 'hi'" }] },
          ],
        },
      },
      URL,
    );
    const next = uninstallHooks(installed, URL);
    expect(next.hooks.Notification).toHaveLength(1);
    expect(next.hooks.Notification[0].hooks[0].command).toBe("say 'hi'");
    expect(next.hooks.Stop ?? []).toHaveLength(0);
    expect(next.hooks.StopFailure ?? []).toHaveLength(0);
    expect(next.hooks.Elicitation ?? []).toHaveLength(0);
    expect(next.hooks.SubagentStart ?? []).toHaveLength(0);
  });

  it("leaves settings untouched if not installed", () => {
    const input = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo before" }] },
        ],
      },
    };
    const next = uninstallHooks(input, URL);
    expect(next).toEqual(input);
  });

  it("removes stale managed legacy entries too", () => {
    const legacyCurl = `curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- '${URL}' 2>/dev/null || true`;
    const next = uninstallHooks(
      { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: legacyCurl }] }] } },
      URL,
    );
    expect(next.hooks.PreToolUse ?? []).toHaveLength(0);
  });
});
