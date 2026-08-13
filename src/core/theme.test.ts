// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from "vitest";
import { cycleTheme, getAppliedTheme, getStoredTheme, initTheme } from "./theme";


describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  it("uses the wiki-cloud aligned skin by default", () => {
    expect(getStoredTheme()).toBe("wiki");
    initTheme();
    expect(getAppliedTheme()).toBe("wiki");
    expect(document.documentElement.classList.contains("wiki")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("wiki");
  });

  it("cycles through every available theme and persists the result", () => {
    initTheme();
    expect(cycleTheme("wiki")).toBe("gouan");
    expect(cycleTheme("gouan")).toBe("light");
    expect(cycleTheme("light")).toBe("dark");
    expect(cycleTheme("dark")).toBe("wiki");
    expect(localStorage.getItem("tech-proposal-studio.theme.v2")).toBe("wiki");
  });

  it("keeps existing stored themes compatible", () => {
    localStorage.setItem("tech-proposal-studio.theme.v2", "dark");
    initTheme();
    expect(getAppliedTheme()).toBe("dark");
    expect(document.documentElement.classList.contains("wiki")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });
});
