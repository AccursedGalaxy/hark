// Theme switcher.
//
// We expose the active theme as `data-theme="dark"` (or `"light"`) on
// <html>, which the themes/*.css selectors target. The choice persists in
// localStorage. `applyThemeFromStorage()` runs synchronously from main.tsx
// before the React tree renders so there's no flash of wrong palette.

export type Theme = "dark" | "light";
export const THEMES: Theme[] = ["dark", "light"];

const KEY = "hark.theme";

export function getStoredTheme(): Theme | null {
  if (typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(KEY);
  return v === "dark" || v === "light" ? v : null;
}

export function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function getActiveTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme();
}

// Mobile browser chrome (PWA shell, iOS Safari notch) uses this colour.
const THEME_COLOR: Record<Theme, string> = {
  dark: "#0b0c0d",
  light: "#fbfaf6",
};

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (meta) meta.content = THEME_COLOR[theme];
}

export function setTheme(theme: Theme): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY, theme);
  }
  applyTheme(theme);
}

// Called once from main.tsx before mount.
export function bootstrapTheme(): void {
  applyTheme(getActiveTheme());
}
