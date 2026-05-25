// Theme + accent + density switcher.
//
// The design system has three dimensions the user can tweak:
//   1. theme    — "dark" | "paper"          (light surface palette)
//   2. accent   — amber | jade | indigo | plum
//   3. density  — comfortable | compact
//
// Each is exposed as a data-attribute on <html>:
//   data-theme="dark"   data-accent="amber"   data-density="comfortable"
//
// The design's styles.css keys off these attributes, so the CSS does the
// heavy lifting — JS only needs to write the chosen value to <html> and
// persist it in localStorage so the next session starts in the same skin.

export type Theme = "dark" | "paper";
export const THEMES: Theme[] = ["dark", "paper"];

export type Accent = "amber" | "jade" | "indigo" | "plum";
export const ACCENTS: Accent[] = ["amber", "jade", "indigo", "plum"];

export type Density = "comfortable" | "compact";
export const DENSITIES: Density[] = ["comfortable", "compact"];

const KEY_THEME = "hark.theme";
const KEY_ACCENT = "hark.accent";
const KEY_DENSITY = "hark.density";
const KEY_CONTEXT_RAIL = "hark.contextRail";

// Mobile browser chrome (PWA shell, iOS Safari notch) uses this colour.
const THEME_COLOR: Record<Theme, string> = {
  dark: "#0a0a0a",
  paper: "#fbfaf6",
};

function readStored<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof localStorage === "undefined") return fallback;
  const v = localStorage.getItem(key);
  return (allowed as readonly string[]).includes(v ?? "")
    ? (v as T)
    : fallback;
}

function writeStored(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, value);
}

export function getActiveTheme(): Theme {
  return readStored(KEY_THEME, THEMES, "dark");
}

export function getActiveAccent(): Accent {
  return readStored(KEY_ACCENT, ACCENTS, "amber");
}

export function getActiveDensity(): Density {
  return readStored(KEY_DENSITY, DENSITIES, "comfortable");
}

export function getContextRail(): boolean {
  if (typeof localStorage === "undefined") return true;
  const v = localStorage.getItem(KEY_CONTEXT_RAIL);
  // Default ON. We write "0"/"1" so old "true"/"false" strings degrade.
  return v !== "0";
}

export function setTheme(theme: Theme): void {
  writeStored(KEY_THEME, theme);
  applyTheme(theme);
}

export function setAccent(accent: Accent): void {
  writeStored(KEY_ACCENT, accent);
  applyAccent(accent);
}

export function setDensity(density: Density): void {
  writeStored(KEY_DENSITY, density);
  applyDensity(density);
}

export function setContextRail(value: boolean): void {
  writeStored(KEY_CONTEXT_RAIL, value ? "1" : "0");
}

function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (meta) meta.content = THEME_COLOR[theme];
}

function applyAccent(accent: Accent): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-accent", accent);
}

function applyDensity(density: Density): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-density", density);
}

// Called once from main.tsx before mount.
export function bootstrapTheme(): void {
  applyTheme(getActiveTheme());
  applyAccent(getActiveAccent());
  applyDensity(getActiveDensity());
}
