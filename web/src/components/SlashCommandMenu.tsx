import { useEffect, useRef } from "react";
import type { SlashCommand } from "../lib/protocol";

interface Props {
  commands: SlashCommand[];
  highlight: number;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}

export function SlashCommandMenu({
  commands,
  highlight,
  onSelect,
  onHover,
}: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the highlighted row in view as the user navigates with the arrow
  // keys. The popover has a fixed max-height and scrolls internally.
  useEffect(() => {
    const el = listRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  if (commands.length === 0) {
    return (
      <div className="slash-menu slash-menu-empty" role="listbox">
        <div className="slash-menu-empty-text">no matching commands</div>
      </div>
    );
  }

  return (
    <div className="slash-menu" role="listbox">
      <ul ref={listRef} className="slash-menu-list">
        {commands.map((cmd, i) => (
          <li
            key={`${cmd.source}:${cmd.name}`}
            role="option"
            aria-selected={i === highlight}
            className={`slash-menu-item ${i === highlight ? "is-active" : ""}`}
            onMouseDown={(e) => {
              // mousedown (not click) so the textarea doesn't lose focus and
              // collapse the menu before we get to handle the selection.
              e.preventDefault();
              onSelect(cmd);
            }}
            onMouseEnter={() => onHover(i)}
          >
            <div className="slash-menu-row">
              <span className="slash-menu-name">/{cmd.name}</span>
              {cmd.argumentHint && (
                <span className="slash-menu-hint">{cmd.argumentHint}</span>
              )}
              <span
                className={`slash-menu-kind slash-menu-kind-${cmd.kind}`}
                title={cmd.kind}
              >
                {cmd.kind}
              </span>
              <span className="slash-menu-source">{cmd.source}</span>
            </div>
            {cmd.description && (
              <div className="slash-menu-desc">{cmd.description}</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
