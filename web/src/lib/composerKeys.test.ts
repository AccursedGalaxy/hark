import { describe, expect, it } from "vitest";
import { composerEnterAction, spliceNewline } from "./composerKeys";

const enter = (over: { altKey?: boolean; shiftKey?: boolean } = {}) => ({
  key: "Enter",
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("composerEnterAction", () => {
  it("Alt+Enter inserts a newline instead of submitting", () => {
    // sendOnEnter true (hardware keyboard) — Alt still wins over submit.
    expect(composerEnterAction(enter({ altKey: true }), true)).toBe("newline");
  });

  it("Alt+Enter wins even with Shift held", () => {
    expect(
      composerEnterAction(enter({ altKey: true, shiftKey: true }), true),
    ).toBe("newline");
  });

  it("Alt+Enter inserts a newline even when the device does not send on Enter", () => {
    expect(composerEnterAction(enter({ altKey: true }), false)).toBe("newline");
  });

  it("plain Enter on a hardware keyboard submits", () => {
    expect(composerEnterAction(enter(), true)).toBe("submit");
  });

  it("Shift+Enter falls through to the textarea default", () => {
    expect(composerEnterAction(enter({ shiftKey: true }), true)).toBe(
      "default",
    );
  });

  it("soft-keyboard Enter (no send-on-Enter) falls through to default", () => {
    expect(composerEnterAction(enter(), false)).toBe("default");
  });

  it("ignores non-Enter keys", () => {
    expect(composerEnterAction({ key: "a", altKey: true, shiftKey: false }, true)).toBe(
      "default",
    );
  });
});

describe("spliceNewline", () => {
  it("appends a newline at the end of the text", () => {
    expect(spliceNewline("hello", 5, 5)).toEqual({ text: "hello\n", caret: 6 });
  });

  it("inserts a newline mid-text at the caret", () => {
    expect(spliceNewline("helloworld", 5, 5)).toEqual({
      text: "hello\nworld",
      caret: 6,
    });
  });

  it("replaces a selection with a newline", () => {
    // Select "XXX" in "helXXXlo" → caret after the inserted newline.
    expect(spliceNewline("helXXXlo", 3, 6)).toEqual({
      text: "hel\nlo",
      caret: 4,
    });
  });
});
