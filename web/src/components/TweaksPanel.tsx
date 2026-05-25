import { useEffect, useRef, useState } from "react";
import {
  ACCENTS,
  type Accent,
  type Density,
  DENSITIES,
  getActiveAccent,
  getActiveDensity,
  setAccent as setAccentStored,
  setDensity as setDensityStored,
} from "../lib/theme";
import { SettingsIcon } from "./icons";

const ACCENT_SWATCH: Record<Accent, string> = {
  amber: "oklch(0.78 0.13 70)",
  jade: "oklch(0.74 0.13 155)",
  indigo: "oklch(0.72 0.13 265)",
  plum: "oklch(0.70 0.13 320)",
};

export function TweaksPanel({
  showContext,
  onShowContext,
}: {
  showContext: boolean;
  onShowContext: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [accent, setAccent] = useState<Accent>(() => getActiveAccent());
  const [density, setDensity] = useState<Density>(() => getActiveDensity());
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const pickAccent = (a: Accent) => {
    setAccent(a);
    setAccentStored(a);
  };
  const pickDensity = (d: Density) => {
    setDensity(d);
    setDensityStored(d);
  };

  return (
    <>
      <button
        type="button"
        className="tweaks-fab"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Tweaks"
        aria-label="Open tweaks"
      >
        <SettingsIcon />
      </button>
      {open && (
        <>
          <div
            className="tweaks-overlay"
            onClick={() => setOpen(false)}
            role="presentation"
          />
          <div className="tweaks-panel" ref={panelRef} role="dialog" aria-label="Tweaks">
            <h4>Accent</h4>
            <div className="accent-row">
              {ACCENTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={"accent-swatch" + (a === accent ? " on" : "")}
                  onClick={() => pickAccent(a)}
                  title={a}
                  aria-label={a}
                  style={{ background: ACCENT_SWATCH[a] }}
                />
              ))}
            </div>

            <h4>Density</h4>
            <div className="tweaks-toggle">
              {DENSITIES.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={d === density ? "on" : ""}
                  onClick={() => pickDensity(d)}
                >
                  {d === "comfortable" ? "Comfy" : "Compact"}
                </button>
              ))}
            </div>

            <h4>Layout</h4>
            <div className="tweaks-row">
              <span className="tweaks-label">Context rail</span>
              <span className="tweaks-spacer" />
              <button
                type="button"
                className={"tweaks-toggle-pill" + (showContext ? " on" : "")}
                onClick={() => onShowContext(!showContext)}
                aria-pressed={showContext}
                aria-label="Toggle context rail"
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}
