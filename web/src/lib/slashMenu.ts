import { useEffect, useMemo, useState } from "react";
import type { SlashCommand } from "./protocol";
import {
  filterCommands,
  parseSlashTrigger,
  type SlashTrigger,
} from "./slashTrigger";

// ---- Pure layer -------------------------------------------------------
//
// All slash-menu behaviour is pinned to four pure functions so the state
// machine is testable without React. The `useSlashMenu` hook below is just
// glue: it holds `highlight` and an `enabled` flag and dispatches into
// these.

export interface SlashMenuView {
  trigger: SlashTrigger | null;
  filtered: SlashCommand[];
}

export function computeSlashMenuView(
  text: string,
  caret: number,
  allCommands: SlashCommand[],
): SlashMenuView {
  const trigger = parseSlashTrigger(text, caret);
  if (!trigger) return { trigger: null, filtered: [] };
  return { trigger, filtered: filterCommands(allCommands, trigger.query) };
}

// Clamp `current` into [0, len-1]. Returns 0 when the list is empty so
// callers never index past the end.
export function clampHighlight(current: number, len: number): number {
  if (len <= 0) return 0;
  if (current < 0) return 0;
  if (current >= len) return len - 1;
  return current;
}

export function insertSlashCommand(
  text: string,
  trigger: SlashTrigger,
  cmd: SlashCommand,
): { nextText: string; nextCaret: number } {
  const before = text.slice(0, trigger.slashStart);
  const after = text.slice(trigger.queryEnd);
  const insertion = `/${cmd.name}${cmd.argumentHint ? " " : ""}`;
  return {
    nextText: `${before}${insertion}${after}`,
    nextCaret: before.length + insertion.length,
  };
}

// What the caller should do in response to a keyboard event while the
// slash menu is open. `none` means the event was not consumed — the
// caller's regular handlers (e.g. "Enter sends the message") run.
export type SlashKeyAction =
  | { kind: "none" }
  | { kind: "highlight"; next: number }
  | {
      kind: "pick";
      cmd: SlashCommand;
      nextText: string;
      nextCaret: number;
    }
  | { kind: "escape"; nextText: string; nextCaret: number };

export function resolveSlashKey(
  event: { key: string; shiftKey: boolean },
  text: string,
  trigger: SlashTrigger,
  filtered: SlashCommand[],
  highlight: number,
): SlashKeyAction {
  // Empty filter means there's nothing to navigate or pick — let the
  // caller handle the key so e.g. Enter still sends the literal "/zzz".
  if (filtered.length === 0) return { kind: "none" };

  if (event.key === "ArrowDown") {
    return { kind: "highlight", next: (highlight + 1) % filtered.length };
  }
  if (event.key === "ArrowUp") {
    return {
      kind: "highlight",
      next: (highlight - 1 + filtered.length) % filtered.length,
    };
  }
  if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
    const idx = clampHighlight(highlight, filtered.length);
    const cmd = filtered[idx];
    if (!cmd) return { kind: "none" };
    const { nextText, nextCaret } = insertSlashCommand(text, trigger, cmd);
    return { kind: "pick", cmd, nextText, nextCaret };
  }
  if (event.key === "Escape") {
    // Drop the leading "/" so parseSlashTrigger returns null on the next
    // render — closes the menu without throwing away the typed query.
    const nextText =
      text.slice(0, trigger.slashStart) + text.slice(trigger.slashStart + 1);
    return { kind: "escape", nextText, nextCaret: trigger.slashStart };
  }
  return { kind: "none" };
}

// ---- React hook -------------------------------------------------------

export interface KeyboardEventLike {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
}

export interface UseSlashMenuArgs {
  text: string;
  caret: number;
  // null means commands haven't been fetched yet; the menu is not "open"
  // until they arrive.
  allCommands: SlashCommand[] | null;
  enabled: boolean;
  // Called when the menu wants to mutate the textarea — picking a
  // command, or pressing Escape.
  onCommit: (next: { text: string; caret: number }) => void;
}

export interface UseSlashMenuApi {
  open: boolean;
  trigger: SlashTrigger | null;
  filtered: SlashCommand[];
  highlight: number;
  setHighlight: (i: number) => void;
  pick: (cmd: SlashCommand) => void;
  // Returns true iff the event was consumed. Caller should early-return
  // from its onKeyDown when true.
  onKeyDown: (e: KeyboardEventLike) => boolean;
}

export function useSlashMenu(args: UseSlashMenuArgs): UseSlashMenuApi {
  const { text, caret, allCommands, enabled, onCommit } = args;
  const [highlight, setHighlightRaw] = useState(0);

  const view = useMemo(
    () => computeSlashMenuView(text, caret, allCommands ?? []),
    [text, caret, allCommands],
  );

  const open = !!view.trigger && enabled && allCommands !== null;

  // Keep highlight valid as the filter narrows.
  useEffect(() => {
    setHighlightRaw((h) => clampHighlight(h, view.filtered.length));
  }, [view.filtered]);

  const setHighlight = (i: number) =>
    setHighlightRaw(clampHighlight(i, view.filtered.length));

  const pick = (cmd: SlashCommand) => {
    if (!view.trigger) return;
    const { nextText, nextCaret } = insertSlashCommand(text, view.trigger, cmd);
    onCommit({ text: nextText, caret: nextCaret });
  };

  const onKeyDown = (e: KeyboardEventLike): boolean => {
    if (!open || !view.trigger) return false;
    const action = resolveSlashKey(
      { key: e.key, shiftKey: e.shiftKey },
      text,
      view.trigger,
      view.filtered,
      highlight,
    );
    switch (action.kind) {
      case "none":
        return false;
      case "highlight":
        e.preventDefault();
        setHighlightRaw(action.next);
        return true;
      case "pick":
        e.preventDefault();
        onCommit({ text: action.nextText, caret: action.nextCaret });
        return true;
      case "escape":
        e.preventDefault();
        onCommit({ text: action.nextText, caret: action.nextCaret });
        return true;
    }
  };

  return {
    open,
    trigger: view.trigger,
    filtered: view.filtered,
    highlight,
    setHighlight,
    pick,
    onKeyDown,
  };
}
