import { useEffect } from "react";

// Listens for Cmd+I (mac) / Ctrl+I (others) and opens the capture modal.
// Fires globally, including while the user is typing in the composer —
// the whole point of the shortcut is mid-flow capture without breaking
// focus. The browser default for Ctrl+I in a plain textarea is a no-op,
// so preventDefault is harmless on the composer; in any contenteditable
// it would otherwise toggle italics, which we don't want either.

export function useCaptureShortcut(onTrigger: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key !== "i" && e.key !== "I") return;
      // XOR: exactly one of meta or ctrl. Catches both macOS (meta) and
      // Linux/Windows (ctrl), without firing on weird Ctrl+Cmd combos.
      const mod = e.metaKey !== e.ctrlKey;
      if (!mod) return;
      e.preventDefault();
      onTrigger();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onTrigger]);
}
