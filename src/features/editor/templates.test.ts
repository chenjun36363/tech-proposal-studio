import { describe, expect, it } from "vitest";
import { defaultTemplateMeta, extractTemplateSkeleton } from "./templates";

describe("extractTemplateSkeleton", () => {
  it("strips body content and keeps heading structure", () => {
    const markdown = "# 淮安市实验室信息管理系统\n\n## 第一章 背景\n\n淮安市环境监测中心站需要建设一套LIMS系统。\n\n### 1.1 政策依据\n\n根据生态环境部相关要求。\n\n## 第二章 系统架构\n\n本系统采用B/S架构。";
    const skeleton = extractTemplateSkeleton(markdown);
    expect(skeleton).toContain("# 淮安市实验室信息管理系统");
    expect(skeleton).toContain("## 第一章 背景");
    expect(skeleton).toContain("## 第二章 系统架构");
    expect(skeleton).toContain("在此编写本章内容");
    expect(skeleton).not.toContain("淮安市环境监测中心站");
    expect(skeleton).not.toContain("B/S架构");
  });

  it("produces a valid heading skeleton", () => {
    const result = extractTemplateSkeleton("# 标题\n\n正文内容\n## 第一章\n\n内容\n## 第二章\n\n内容\n### 2.1\n\n细节");
    const lines = result.split("\n").filter(l => l.trim());
    const headingLines = lines.filter(l => /^#{1,6}\s/.test(l));
    expect(headingLines).toEqual(["# 标题", "## 第一章", "## 第二章", "### 2.1"]);
  });

  it("handles empty/body-only markdown gracefully", () => {
    expect(extractTemplateSkeleton("")).toBe("");
    expect(extractTemplateSkeleton("只有正文\n没有标题")).toBe("");
  });
});

describe("defaultTemplateMeta", () => {
  it("returns the default template entry", () => {
    const meta = defaultTemplateMeta();
    expect(meta.id).toBe("__default__");
    expect(meta.name).toBe("默认 9 章模板");
    expect(meta.chapterCount).toBe(9);
  });
});
