import { describe, expect, it } from "vitest";
import {
  applyHeadingLevel,
  formatHeadingPrefix,
  renumberHeadings,
  stripHeadingPrefix,
} from "./markdownDoc";

describe("heading numbering", () => {
  it("strips chapter and dotted prefixes", () => {
    expect(stripHeadingPrefix("第1章 背景")).toBe("背景");
    expect(stripHeadingPrefix("1.1 范围")).toBe("范围");
    expect(stripHeadingPrefix("1.1.1 细节")).toBe("细节");
  });

  it("formats fixed prefixes", () => {
    expect(formatHeadingPrefix(1, [2, 0, 0, 0, 0, 0])).toBe("");   // H1 is document title
    expect(formatHeadingPrefix(2, [1, 3, 0, 0, 0, 0])).toBe("第1章");
    expect(formatHeadingPrefix(3, [1, 2, 4, 0, 0, 0])).toBe("1.2");
  });

  it("renumbers nested headings", () => {
    const md = [
      "# 方案",
      "",
      "## 背景",
      "",
      "### 细节",
      "",
      "## 架构",
      "",
      "# 附录",
    ].join("\n");
    const next = renumberHeadings(md);
    expect(next).toContain("# 方案");          // H1 stays as document title
    expect(next).toContain("## 第1章 背景");    // H2 → 第N章
    expect(next).toContain("### 1.1 细节");     // H3 → decimal
    expect(next).toContain("## 第2章 架构");
    expect(next).toContain("# 附录");           // H1 stays as document title
  });

  it("batch-applies heading level then renumbers", () => {
    const md = "背景与目标\n范围与约束\n\n正文";
    const { markdown } = applyHeadingLevel(md, 0, "背景与目标\n范围与约束".length, 2);
    expect(markdown).toContain("## 第1章 背景与目标");
    expect(markdown).toContain("## 第2章 范围与约束");
    expect(markdown).toContain("正文");
  });
});
