import { useEffect, useState } from "react";
import { type Theme, THEMES, getActiveTheme, setTheme } from "../lib/theme";

const LABEL: Record<Theme, string> = {
  dark: "Dark",
  light: "Light",
};

export function ThemeToggle() {
  const [theme, setLocal] = useState<Theme>(() => getActiveTheme());

  // Keep state in sync if the theme is changed in another tab.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "hark.theme") return;
      const next = e.newValue === "light" ? "light" : "dark";
      setLocal(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const pick = (t: Theme) => {
    setTheme(t);
    setLocal(t);
  };

  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          className={t === theme ? "is-active" : ""}
          onClick={() => pick(t)}
          aria-pressed={t === theme}
        >
          {LABEL[t]}
        </button>
      ))}
    </div>
  );
}
