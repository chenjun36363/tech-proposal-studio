import { describe, expect, it } from "vitest";
import { createFrozenHeadingTreeSignature, parseLongWritingDocument } from "./chapterParser";
import { validateChapterDraft, validateFrozenHeadingTree } from "./validation";

const frozen = "## 第一章 总体设计\n\n原正文\n\n### 1.1 架构\n\n架构正文\n\n#### 1.1.1 接口\n\n接口正文";

describe("long-writing chapter draft validation", () => {
  it("accepts rewritten body when the complete heading tree is unchanged", () => {
    const draft = "## 第一章 总体设计\n\n新正文\n\n### 1.1 架构\n\n新架构正文\n\n#### 1.1.1 接口\n\n新接口正文";
    expect(validateChapterDraft(frozen, draft)).toMatchObject({ valid: true, issues: [] });
  });

  it("rejects an extra heading", () => {
    const draft = `${frozen}\n\n### 1.2 模型擅自增加\n\n内容`;
    const result = validateChapterDraft(frozen, draft);
    expect(result.valid).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain("extra_heading");
  });

  it("rejects a missing heading", () => {
    const draft = "## 第一章 总体设计\n\n正文\n\n### 1.1 架构\n\n正文";
    const result = validateChapterDraft(frozen, draft);
    expect(result.issues.map(issue => issue.code)).toContain("missing_heading");
  });

  it("rejects heading level changes", () => {
    const draft = "## 第一章 总体设计\n\n正文\n\n#### 1.1 架构\n\n正文\n\n##### 1.1.1 接口\n\n正文";
    const result = validateChapterDraft(frozen, draft);
    expect(result.issues.map(issue => issue.code)).toContain("heading_level_changed");
  });

  it("rejects heading title changes", () => {
    const draft = "## 第一章 总体设计\n\n正文\n\n### 1.1 新架构\n\n正文\n\n#### 1.1.1 接口\n\n正文";
    const result = validateChapterDraft(frozen, draft);
    expect(result.issues.map(issue => issue.code)).toContain("heading_title_changed");
  });

  it("rejects an empty body, including a draft containing only frozen headings", () => {
    const draft = "## 第一章 总体设计\n\n### 1.1 架构\n\n#### 1.1.1 接口\n";
    const result = validateChapterDraft(frozen, draft);
    expect(result.issues.map(issue => issue.code)).toContain("empty_body");
  });

  it("rejects an additional root chapter or content outside the chapter", () => {
    const extraChapter = `${frozen}\n\n## 第二章 额外章节\n\n正文`;
    const result = validateChapterDraft(frozen, extraChapter);
    expect(result.issues.map(issue => issue.code)).toContain("extra_chapter");
    expect(result.issues.map(issue => issue.code)).toContain("content_outside_chapter");
  });

  it("ignores heading-like lines inside fenced code during validation", () => {
    const draft = "## 第一章 总体设计\n\n```markdown\n### 不是标题\n```\n\n### 1.1 架构\n正文\n\n#### 1.1.1 接口\n正文";
    expect(validateChapterDraft(frozen, draft).valid).toBe(true);
  });

  it("validates a persisted frozen signature independently", () => {
    const chapter = parseLongWritingDocument(frozen).chapters[0];
    const signature = createFrozenHeadingTreeSignature(chapter);
    const result = validateFrozenHeadingTree(signature, frozen.replace("原正文", "修改后的正文"));
    expect(result.valid).toBe(true);
    expect(result.actualSignature).toBe(signature);
  });
});
