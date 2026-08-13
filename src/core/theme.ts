const THEME_KEY = "tech-proposal-studio.theme.v2";

export type Theme = "wiki" | "gouan" | "light" | "dark";

const THEME_ORDER: Theme[] = ["wiki", "gouan", "light", "dark"];

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("wiki", theme === "wiki");
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.classList.toggle("gouan", theme === "gouan");
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute("content", theme === "dark" ? "#000000" : theme === "wiki" ? "#f2f2f7" : "#ffffff");
}

export function getStoredTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "wiki" || stored === "gouan" || stored === "light" || stored === "dark") return stored;
  return "wiki";
}

/** Call once on app boot, before first paint. */
export function initTheme() {
  applyTheme(getStoredTheme());
}

export function getAppliedTheme(): Theme {
  if (document.documentElement.classList.contains("dark")) return "dark";
  if (document.documentElement.classList.contains("gouan")) return "gouan";
  if (document.documentElement.classList.contains("wiki")) return "wiki";
  return "light";
}

export function cycleTheme(current = getAppliedTheme()): Theme {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
  return next;
}
