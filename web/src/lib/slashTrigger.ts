// Detect an active slash-command trigger in a textarea, given the full text
// and the caret offset.
//
// "Active" means: the current line starts with "/" and the caret is somewhere
// inside the contiguous word that follows it (no whitespace between the slash
// and the caret). That's enough to pop the menu while the user is still
// typing the command name, but suppresses it once they hit space and start
// supplying arguments.

export interface SlashTrigger {
  // Offset of the leading "/" in the textarea.
  slashStart: number;
  // Offset just past the last character of the typed name (where the caret
  // is, or further if more chars follow before whitespace).
  queryEnd: number;
  // The substring after "/" up to the caret. Used to filter the popover.
  query: string;
}

export function parseSlashTrigger(text: string, caret: number): SlashTrigger | null {
  // Find the start of the current line.
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  if (text[lineStart] !== "/") return null;
  // Caret must be past the slash for the trigger to be active.
  if (caret <= lineStart) return null;

  // Walk from the slash to the caret. If we hit whitespace before reaching
  // the caret, the trigger is finished (user is typing arguments now).
  for (let i = lineStart + 1; i < caret; i++) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n") return null;
  }

  return {
    slashStart: lineStart,
    queryEnd: caret,
    query: text.slice(lineStart + 1, caret),
  };
}

// Case-insensitive substring filter, ordered so prefix matches come first.
// Stable for items that don't match the filter at all (they're excluded).
export function filterCommands<T extends { name: string }>(
  commands: T[],
  query: string,
): T[] {
  if (!query) return commands;
  const q = query.toLowerCase();
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const cmd of commands) {
    const n = cmd.name.toLowerCase();
    if (n.startsWith(q)) prefix.push(cmd);
    else if (n.includes(q)) contains.push(cmd);
  }
  return [...prefix, ...contains];
}
