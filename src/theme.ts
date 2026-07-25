const THEME_KEY = "tech-proposal-studio.theme.v1";

export type Theme = "light" | "dark";

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function getStoredTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Call once on app boot, before first paint. */
export function initTheme() {
  applyTheme(getStoredTheme());
}

export function toggleTheme(): Theme {
  const next: Theme = document.documentElement.classList.contains("dark") ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
  return next;
}
