import { describe, expect, it } from "vitest";
import { applyEditableOutline, createEditableOutline } from "./outlineEditing";
import { parseLongWritingDocument } from "./chapterParser";
import type { OutlinePlan } from "./types";

const markdown = "# 标题\n\n前言\n\n## 第一章\n\n正文 A\n\n### 子节 A\n\n内容\n\n## 第二章\n\n正文 B\n";
const plan: OutlinePlan = {
  documentSummary: "摘要", audience: "读者", writingRules: [], fixedFacts: [], terminology: [],
  frozenOutline: parseLongWritingDocument(markdown).chapters.map(chapter => ({
    chapterId: chapter.id, order: chapter.order, titlePath: chapter.titlePath,
    headingSkeleton: chapter.headings.map(heading => `${"#".repeat(heading.level)} ${heading.title}`),
    goal: `目标 ${chapter.order}`, action: chapter.order === 0 ? "rewrite" : "keep",
  })),
  transitionRequirements: [], targetChapterIds: [],
};

describe("editable outline", () => {
  it("renames and reorders retained H2 chapters without losing their bodies", () => {
    const rows = createEditableOutline(plan, markdown);
    rows[0].title = "第一章（新）";
    const next = applyEditableOutline(markdown, [rows[1], rows[0]]);
    expect(next).toContain("# 标题\n\n前言");
    expect(next.indexOf("## 第二章")).toBeLessThan(next.indexOf("## 第一章（新）"));
    expect(next).toContain("正文 A");
    expect(next).toContain("### 子节 A");
    expect(next).toContain("正文 B");
  });

  it("supports deleting and adding chapters", () => {
    const rows = createEditableOutline(plan, markdown);
    const next = applyEditableOutline(markdown, [{
      key: "new", title: "新增章", action: "fill", goal: "补写",
    }, rows[1]]);
    expect(next).not.toContain("第一章");
    expect(next).toContain("## 新增章\n\n");
    expect(next).toContain("正文 B");
  });

  it("rejects an empty outline and duplicate source chapters", () => {
    const rows = createEditableOutline(plan, markdown);
    expect(() => applyEditableOutline(markdown, [])).toThrow("至少");
    expect(() => applyEditableOutline(markdown, [rows[0], rows[0]])).toThrow("两次");
  });
});
