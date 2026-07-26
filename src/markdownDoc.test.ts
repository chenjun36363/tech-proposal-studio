import { describe, expect, it } from "vitest";
import {
  alignHeadingsToRules,
  applyHeadingLevel,
  formatHeadingPrefix,
  moveSection,
  parseMarkdownHeadings,
  renumberHeadings,
  replaceSection,
  sectionBody,
  stripHeadingPrefix,
} from "./markdownDoc";

describe("heading numbering", () => {
  it("demotes numbered H1 chapters while preserving an optional document title", () => {
    const markdown = ["# 项目方案", "", "# 1 项目必要性分析", "", "## 第1章 项目背景", "", "### 1.1 建设依据", "", "# 2 项目需求分析"].join("\n");
    expect(alignHeadingsToRules(markdown)).toEqual({
      markdown: ["# 项目方案", "", "## 第1章 项目必要性分析", "", "## 第2章 项目背景", "", "### 2.1 建设依据", "", "## 第3章 项目需求分析"].join("\n"),
      headingCount: 5,
      demotedCount: 2,
      titlePreserved: true,
      titleCreated: false,
    });
  });

  it("preserves the only H1 as the document title", () => {
    const markdown = "# 项目方案\n\n## 第5章 项目背景\n\n### 8.3 建设依据";
    expect(alignHeadingsToRules(markdown)).toEqual({
      markdown: "# 项目方案\n\n## 第1章 项目背景\n\n### 1.1 建设依据",
      headingCount: 3,
      demotedCount: 0,
      titlePreserved: true,
      titleCreated: false,
    });
  });

  it("promotes the first preamble line when numbered H1 chapters leave no title", () => {
    const markdown = "项目可行性研究报告\n\n申报单位：某某单位\n\n# 1 项目必要性分析\n\n# 2 项目需求分析";
    expect(alignHeadingsToRules(markdown)).toEqual({
      markdown: "# 项目可行性研究报告\n\n申报单位：某某单位\n\n## 第1章 项目必要性分析\n\n## 第2章 项目需求分析",
      headingCount: 3,
      demotedCount: 2,
      titlePreserved: false,
      titleCreated: true,
    });
  });
  it("strips chapter and dotted prefixes", () => {
    expect(stripHeadingPrefix("第1章 背景")).toBe("背景");
    expect(stripHeadingPrefix("第一章 背景")).toBe("背景");
    expect(stripHeadingPrefix("1.1 范围")).toBe("范围");
    expect(stripHeadingPrefix("1.1.1 细节")).toBe("细节");
    expect(stripHeadingPrefix("**第1章 背景**")).toBe("**背景**");
    expect(stripHeadingPrefix("***1.1.1 细节***")).toBe("***细节***");
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

  it("does not duplicate numbering inside emphasized imported headings", () => {
    const md = [
      "# **方案**",
      "",
      "## **第1章 建设概述**",
      "",
      "### **1.1 建设背景**",
      "",
      "#### ***1.1.1 服务模式说明***",
    ].join("\n");

    expect(renumberHeadings(md)).toBe([
      "# **方案**",
      "",
      "## 第1章 **建设概述**",
      "",
      "### 1.1 **建设背景**",
      "",
      "#### 1.1.1 ***服务模式说明***",
    ].join("\n"));
  });

  it("preserves section text while typing instead of inserting trailing newlines", () => {
    const markdown = "# 方案\n\n正文";
    const [heading] = parseMarkdownHeadings(markdown);

    expect(replaceSection(markdown, heading, "# 方案\n\n正文中文")).toBe("# 方案\n\n正文中文");
  });

  it("keeps a newline boundary before the following section", () => {
    const markdown = "# 方案\n\n## 第一章\n\n正文\n## 第二章\n\n正文";
    const heading = parseMarkdownHeadings(markdown)[1];

    expect(replaceSection(markdown, heading, "## 第一章\n\n正文中文")).toContain("正文中文\n## 第二章");
  });

  it("does not expose a trailing blank line at the end of the document", () => {
    const markdown = "# 方案\n\n正文\n";
    const [heading] = parseMarkdownHeadings(markdown);

    expect(sectionBody(markdown, heading)).toBe("# 方案\n\n正文");
  });

  it("does not expose the separator before the following section", () => {
    const markdown = "# 方案\n\n## 第一章\n\n正文\n\n## 第二章\n\n正文";
    const heading = parseMarkdownHeadings(markdown)[1];

    expect(sectionBody(markdown, heading)).toBe("## 第一章\n\n正文");
  });

  it("supports consecutive typing at the end of a non-final section", () => {
    let markdown = "# 方案\n\n## 第一章\n\n正文\n## 第二章\n\n正文";
    for (const character of "连续输入") {
      const heading = parseMarkdownHeadings(markdown)[1];
      markdown = replaceSection(markdown, heading, sectionBody(markdown, heading) + character);
    }

    expect(markdown).toContain("正文连续输入\n## 第二章");
  });

  it("moves a chapter together with its descendants", () => {
    const markdown = "# 方案\n\n## 第一章\n\n正文一\n### 子章节\n\n子正文\n## 第二章\n\n正文二";
    const headings = parseMarkdownHeadings(markdown);
    const moved = moveSection(markdown, headings[1], headings[3], "after");

    expect(moved.indexOf("## 第二章")).toBeLessThan(moved.indexOf("## 第一章"));
    expect(moved.indexOf("### 子章节")).toBeGreaterThan(moved.indexOf("## 第一章"));
    expect(moved.match(/正文一/g)).toHaveLength(1);
  });

  it("does not move a section into one of its descendants", () => {
    const markdown = "# 方案\n\n## 第一章\n\n正文\n### 子章节\n\n子正文\n## 第二章";
    const headings = parseMarkdownHeadings(markdown);

    expect(moveSection(markdown, headings[1], headings[2], "before")).toBe(markdown);
  });

  it("keeps an adjacent section in place when dropped before its next sibling", () => {
    const markdown = "# 方案\n\n## 第一章\n\n正文一\n## 第二章\n\n正文二";
    const headings = parseMarkdownHeadings(markdown);

    expect(moveSection(markdown, headings[1], headings[2], "before")).toBe(markdown);
  });
});
