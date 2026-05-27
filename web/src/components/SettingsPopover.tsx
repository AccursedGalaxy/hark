import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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
import { CloseIcon } from "./icons";

const ACCENT_SWATCH: Record<Accent, string> = {
  amber: "oklch(0.78 0.13 70)",
  jade: "oklch(0.74 0.13 155)",
  indigo: "oklch(0.72 0.13 265)",
  plum: "oklch(0.70 0.13 320)",
};

export function SettingsPopover({
  open,
  onClose,
  showContext,
  onShowContext,
}: {
  open: boolean;
  onClose: () => void;
  showContext: boolean;
  onShowContext: (v: boolean) => void;
}) {
  const [accent, setAccent] = useState<Accent>(() => getActiveAccent());
  const [density, setDensity] = useState<Density>(() => getActiveDensity());

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const pickAccent = (a: Accent) => {
    setAccent(a);
    setAccentStored(a);
  };
  const pickDensity = (d: Density) => {
    setDensity(d);
    setDensityStored(d);
  };

  // The sidebar (`.rail`) uses `backdrop-filter`, which creates a containing
  // block for `position: fixed` descendants. Portal to body so the overlay
  // and panel anchor to the viewport instead of the sidebar.
  return createPortal(
    <>
      <div
        className="settings-overlay"
        onClick={onClose}
        role="presentation"
      />
      <div className="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="settings-head">
          <h3>Settings</h3>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>

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
    </>,
    document.body,
  );
}
