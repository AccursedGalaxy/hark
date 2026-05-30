// Pure decision logic for the chat composer's Enter key, extracted from
// Composer.tsx so the behavior can be regression-tested without a DOM.
//
// The matrix this guards:
//   Alt+Enter            → newline   (insert a literal newline, never submit;
//                                      wins even when Shift is also held)
//   plain hardware Enter → submit    (only when the device should send on Enter)
//   Shift+Enter          → default   (let the textarea insert its own newline)
//   soft-keyboard Enter  → default   (sendOnEnter is false, so fall through)

export type ComposerEnterAction = "newline" | "submit" | "default";

// The subset of a keyboard event the decision depends on.
export interface ComposerKeyEvent {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
}

// Decide what an Enter keypress should do. `sendOnEnter` reflects whether the
// device should submit on plain Enter (hardware keyboard detected); the caller
// supplies it so this stays pure. Non-Enter keys always fall through.
export function composerEnterAction(
  e: ComposerKeyEvent,
  sendOnEnter: boolean,
): ComposerEnterAction {
  if (e.key !== "Enter") return "default";
  // Alt+Enter inserts a literal newline regardless of Shift, matching the CLI.
  if (e.altKey) return "newline";
  if (!e.shiftKey && sendOnEnter) return "submit";
  return "default";
}

// Splice a newline into `text`, replacing the [start, end) selection, and
// report where the caret lands (just after the inserted newline). Used for the
// Alt+Enter "newline" action, which the textarea does not insert natively.
export function spliceNewline(
  text: string,
  start: number,
  end: number,
): { text: string; caret: number } {
  return {
    text: `${text.slice(0, start)}\n${text.slice(end)}`,
    caret: start + 1,
  };
}
