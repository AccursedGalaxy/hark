import { describe, expect, it } from "vitest";
import { pickCaptureDefaultProject } from "./captureDefaults";

const proj = (key: string) => ({ key });

describe("pickCaptureDefaultProject", () => {
  it("returns the explicitly selected project key when present", () => {
    expect(
      pickCaptureDefaultProject({
        selectedProjectKey: "/repo/a",
        currentSessionProjectKey: "/repo/b",
        projects: [proj("/repo/a"), proj("/repo/b")],
      }),
    ).toBe("/repo/a");
  });

  it("selected wins over current-session and over single-project fallback", () => {
    expect(
      pickCaptureDefaultProject({
        selectedProjectKey: "/repo/a",
        currentSessionProjectKey: "/repo/b",
        projects: [proj("/repo/only")],
      }),
    ).toBe("/repo/a");
  });

  it("falls back to the current session's project when nothing is selected", () => {
    expect(
      pickCaptureDefaultProject({
        selectedProjectKey: null,
        currentSessionProjectKey: "/repo/b",
        projects: [proj("/repo/a"), proj("/repo/b")],
      }),
    ).toBe("/repo/b");
  });

  it("session project wins over the single-project fallback", () => {
    expect(
      pickCaptureDefaultProject({
        selectedProjectKey: null,
        currentSessionProjectKey: "/repo/b",
        projects: [proj("/repo/only")],
      }),
    ).toBe("/repo/b");
  });

  it("skips an undefined currentSessionProjectKey", () => {
    expect(
      pickCaptureDefaultProject({
        selectedProjectKey: null,
        currentSessionProjectKey: undefined,
        projects: [proj("/repo/only")],
      }),
    ).toBe("/repo/only");
  });

  it("skips a null currentSessionProjectKey", () => {
    expect(
      pickCaptureDefaultProject({
        selectedProjectKey: null,
        currentSessionProjectKey: null,
        projects: [proj("/repo/only")],
      }),
    ).toBe("/repo/only");
  });

  it("uses the lone project when there's exactly one and nothing else hints", () => {
    expect(
      pickCaptureDefaultProject({
        selectedProjectKey: null,
        currentSessionProjectKey: null,
        projects: [proj("/repo/only")],
      }),
    ).toBe("/repo/only");
  });

  it("returns null when there are multiple projects and no hints", () => {
    expect(
      pickCaptureDefaultProject({
        selectedProjectKey: null,
        currentSessionProjectKey: null,
        projects: [proj("/repo/a"), proj("/repo/b")],
      }),
    ).toBeNull();
  });

  it("returns null when there are zero projects", () => {
    expect(
      pickCaptureDefaultProject({
        selectedProjectKey: null,
        currentSessionProjectKey: null,
        projects: [],
      }),
    ).toBeNull();
  });
});
