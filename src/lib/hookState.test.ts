import { beforeEach, describe, expect, it } from "vitest";
import { HookState } from "./hookState.js";

describe("HookState", () => {
  let state: HookState;

  beforeEach(() => {
    state = new HookState();
  });

  it("returns empty snapshot initially", () => {
    expect(state.snapshot()).toEqual({});
  });

  it("records a Notification as needs-attention", () => {
    const ev = state.record({
      session_id: "s1",
      hook_event_name: "Notification",
      message: "Claude is waiting",
    });
    expect(ev.sessionId).toBe("s1");
    expect(ev.needsAttention).toBe(true);
    expect(ev.lastEvent).toBe("Notification");
    expect(ev.message).toBe("Claude is waiting");
    expect(ev.lastEventAt).toBeGreaterThan(0);
    expect(state.snapshot().s1).toMatchObject({
      needsAttention: true,
      lastEvent: "Notification",
    });
  });

  it("records a Stop as needs-attention", () => {
    const ev = state.record({
      session_id: "s2",
      hook_event_name: "Stop",
    });
    expect(ev.needsAttention).toBe(true);
    expect(ev.lastEvent).toBe("Stop");
  });

  it("ignores events with no session_id", () => {
    expect(() =>
      state.record({ hook_event_name: "Stop" } as never),
    ).toThrow();
  });

  it("clears attention for a session", () => {
    state.record({ session_id: "s1", hook_event_name: "Stop" });
    state.clear("s1");
    expect(state.snapshot().s1.needsAttention).toBe(false);
  });

  it("preserves lastEventAt after clearing", () => {
    const ev = state.record({ session_id: "s1", hook_event_name: "Stop" });
    state.clear("s1");
    expect(state.snapshot().s1.lastEventAt).toBe(ev.lastEventAt);
  });

  it("clearing an unknown session is a no-op", () => {
    expect(() => state.clear("unknown")).not.toThrow();
    expect(state.snapshot()).toEqual({});
  });

  it("overwrites prior event with later one", () => {
    state.record({ session_id: "s1", hook_event_name: "Notification", message: "first" });
    const second = state.record({
      session_id: "s1",
      hook_event_name: "Stop",
    });
    expect(state.snapshot().s1.lastEvent).toBe("Stop");
    expect(state.snapshot().s1.message).toBeUndefined();
    expect(second.lastEventAt).toBeGreaterThanOrEqual(
      state.snapshot().s1.lastEventAt,
    );
  });
});
