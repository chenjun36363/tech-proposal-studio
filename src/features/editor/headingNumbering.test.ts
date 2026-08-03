import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEADING_NUMBERING_PREFERENCES,
  HEADING_NUMBERING_SCHEMES,
  formatMarkdownHeadingPrefix,
  normalizeHeadingNumberingPreferences,
  resolveHeadingNumberingLevel,
} from "./headingNumbering";

describe("shared heading numbering schemes", () => {
  it("uses chapter-decimal from H2 by default", () => {
    expect(DEFAULT_HEADING_NUMBERING_PREFERENCES).toEqual({
      schemeId: "chapter-decimal",
      startLevel: 2,
    });
    expect(formatMarkdownHeadingPrefix("chapter-decimal", 2, 2, [0, 1, 0, 0, 0, 0])).toBe("第1章");
    expect(formatMarkdownHeadingPrefix("chapter-decimal", 3, 2, [0, 1, 1, 0, 0, 0])).toBe("1.1");
    expect(formatMarkdownHeadingPrefix("chapter-decimal", 4, 2, [0, 1, 1, 1, 0, 0])).toBe("1.1.1");
  });

  it.each([
    ["decimal", "2", "2.3"],
    ["chapter", "第二章", "2.3"],
    ["chapter-decimal", "第2章", "2.3"],
    ["section", "第2节", "2.3"],
    ["paren", "(2)", "2.3"],
    ["chinese-hier", "（二）", "3."],
  ])("formats %s consistently from H2", (schemeId, h2, h3) => {
    const counters = [0, 2, 3, 0, 0, 0];
    expect(formatMarkdownHeadingPrefix(schemeId, 2, 2, counters)).toBe(h2);
    expect(formatMarkdownHeadingPrefix(schemeId, 3, 2, counters)).toBe(h3);
  });

  it("moves relative schemes to a different start level without changing their top template", () => {
    const counters = [0, 0, 4, 2, 0, 0];
    expect(formatMarkdownHeadingPrefix("chapter-decimal", 3, 3, counters)).toBe("第4章");
    expect(formatMarkdownHeadingPrefix("chapter-decimal", 4, 3, counters)).toBe("4.2");
    expect(resolveHeadingNumberingLevel("chapter-decimal", 3, 3)?.text).toBe("第%1章");
    expect(resolveHeadingNumberingLevel("chapter-decimal", 4, 3)?.text).toBe("%1.%2");
  });

  it("keeps the fixed Chinese hierarchy tied to absolute H1-H6 levels", () => {
    expect(formatMarkdownHeadingPrefix("chinese-hier", 3, 3, [0, 0, 4, 0, 0, 0])).toBe("4.");
    expect(formatMarkdownHeadingPrefix("chinese-hier", 4, 3, [0, 0, 4, 2, 0, 0])).toBe("(2)");
  });

  it("normalizes missing and invalid settings but preserves none", () => {
    expect(normalizeHeadingNumberingPreferences()).toEqual(DEFAULT_HEADING_NUMBERING_PREFERENCES);
    expect(normalizeHeadingNumberingPreferences({ schemeId: "unknown", startLevel: 99 })).toEqual({
      schemeId: "chapter-decimal",
      startLevel: 6,
    });
    expect(normalizeHeadingNumberingPreferences({ schemeId: "none", startLevel: 1 })).toEqual({
      schemeId: "none",
      startLevel: 1,
    });
  });

  it("registers every selectable scheme with a unique id", () => {
    const ids = HEADING_NUMBERING_SCHEMES.map((scheme) => scheme.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["decimal", "chapter", "chapter-decimal", "section", "paren", "chinese-hier"]);
  });
});
