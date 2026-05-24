import { describe, expect, it } from "vitest";
import {
  buildHookCommand,
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
});

describe("isManagedCommand", () => {
  it("identifies a command targeting the configured url", () => {
    expect(isManagedCommand(buildHookCommand(URL), URL)).toBe(true);
  });

  it("does not match unrelated commands", () => {
    expect(isManagedCommand("echo hi", URL)).toBe(false);
    expect(isManagedCommand("curl https://example.com", URL)).toBe(false);
  });
});

describe("installHooks", () => {
  it("creates Notification + Stop entries on empty settings", () => {
    const next = installHooks({}, URL);
    expect(next.hooks.Notification).toHaveLength(1);
    expect(next.hooks.Stop).toHaveLength(1);
    expect(next.hooks.Notification[0].hooks[0].command).toContain(URL);
  });

  it("is idempotent — re-installing does not duplicate entries", () => {
    const once = installHooks({}, URL);
    const twice = installHooks(once, URL);
    expect(twice.hooks.Notification).toHaveLength(1);
    expect(twice.hooks.Stop).toHaveLength(1);
  });

  it("preserves unrelated keys and unrelated hooks", () => {
    const existing = {
      model: "claude-opus-4-7",
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo before" }],
          },
        ],
        Notification: [
          {
            hooks: [{ type: "command", command: "say 'hi'" }],
          },
        ],
      },
    };
    const next = installHooks(existing, URL);
    expect(next.model).toBe("claude-opus-4-7");
    expect(next.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
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
  });

  it("leaves settings untouched if not installed", () => {
    const input = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } };
    const next = uninstallHooks(input, URL);
    expect(next).toEqual(input);
  });
});
