import { describe, expect, it } from "vitest";
import {
  HEADING_NUMBERING_REF,
  HEADING_NUMBERING_SCHEMES,
  buildHeadingNumberingLevels,
  getHeadingNumberingScheme,
} from "./headingNumbering";

const opts = {
  headingFont: "黑体",
  headingSizes: [22, 16, 14, 12, 12, 10.5],
  lineSpacing: 1.5,
  headingBefore: [14, 12, 10, 9, 8, 7],
  headingAfter: [7, 6, 5, 5, 4, 4],
};

describe("heading numbering registry", () => {
  it("treats none as no scheme", () => {
    expect(getHeadingNumberingScheme("none")).toBeNull();
    expect(getHeadingNumberingScheme("")).toBeNull();
    expect(buildHeadingNumberingLevels("none", 1, opts)).toBeNull();
  });

  it("returns null for an unknown scheme id", () => {
    expect(getHeadingNumberingScheme("does-not-exist")).toBeNull();
    expect(buildHeadingNumberingLevels("does-not-exist", 1, opts)).toBeNull();
  });

  it("exposes a registry with several reserved schemes", () => {
    expect(HEADING_NUMBERING_SCHEMES.length).toBeGreaterThanOrEqual(6);
    expect(HEADING_NUMBERING_SCHEMES.map((s) => s.id)).toContain("chapter");
    expect(HEADING_NUMBERING_SCHEMES.every((s) => s.id && s.label && s.description)).toBe(true);
  });

  it("uses 第一章 for top level of the chapter scheme", () => {
    const levels = buildHeadingNumberingLevels("chapter", 1, opts);
    expect(levels).not.toBeNull();
    expect(levels!).toHaveLength(6);
    expect(levels![0].text).toBe("第%1章");
    expect(levels![0].style?.style).toBe("Heading1");
    // 子级按 %1.%2 拼接
    expect(levels![1].text).toBe("%1.%2");
    expect(levels![1].style?.style).toBe("Heading2");
  });

  it("shifts counters when starting below H1 (decimal, start=2)", () => {
    const levels = buildHeadingNumberingLevels("decimal", 2, opts);
    expect(levels).not.toBeNull();
    expect(levels!).toHaveLength(5);
    // 新的顶层（原 H2）应为单计数器 "1"
    expect(levels![0].text).toBe("%1");
    expect(levels![0].style?.style).toBe("Heading2");
    expect(levels![1].text).toBe("%1.%2");
    expect(levels![1].style?.style).toBe("Heading3");
  });

  it("keeps single-counter chinese hierarchy aligned when starting at H2", () => {
    const levels = buildHeadingNumberingLevels("chinese-hier", 2, opts);
    expect(levels).not.toBeNull();
    // 原 H2 层级为"（一）"，仅引用自身计数器 %1
    expect(levels![0].text).toBe("（%1）");
    expect(levels![0].style?.style).toBe("Heading2");
  });

  it("links numbering to the heading outline reference", () => {
    const levels = buildHeadingNumberingLevels("chapter", 1, opts);
    expect(levels).not.toBeNull();
    // 引用字符串在 docxExport 的编号定义中使用，这里仅确保方案可被解析。
    expect(HEADING_NUMBERING_REF).toBe("heading-outline");
  });
});
