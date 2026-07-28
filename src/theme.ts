const THEME_KEY = "tech-proposal-studio.theme.v2";

export type Theme = "gouan" | "light" | "dark";

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.classList.toggle("gouan", theme === "gouan");
  document.documentElement.dataset.theme = theme;
}

export function getStoredTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "gouan" || stored === "light" || stored === "dark") return stored;
  return "gouan";
}

/** Call once on app boot, before first paint. */
export function initTheme() {
  applyTheme(getStoredTheme());
}

export function getAppliedTheme(): Theme {
  if (document.documentElement.classList.contains("dark")) return "dark";
  if (document.documentElement.classList.contains("gouan")) return "gouan";
  return "light";
}

export function cycleTheme(current = getAppliedTheme()): Theme {
  const order: Theme[] = ["gouan", "light", "dark"];
  const next = order[(order.indexOf(current) + 1) % order.length];
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
  return next;
}
