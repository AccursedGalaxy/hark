import { useEffect, useState } from "react";

// Returns the px height of the on-screen keyboard (0 when closed).
// Uses visualViewport, the only reliable signal on iOS Safari + Android Chrome.
// Apply as bottom padding on the composer so it stays above the keyboard
// instead of being covered by it.
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const gap = window.innerHeight - (vv.height + vv.offsetTop);
      setInset(gap > 0 ? gap : 0);
    };

    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return inset;
}
