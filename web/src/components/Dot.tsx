import type { SessionState } from "../lib/protocol";

export function Dot({ state }: { state: SessionState }) {
  return (
    <span
      className={`dot dot-${state}`}
      aria-hidden="true"
      data-state={state}
    />
  );
}
