import { describe, expect, it } from "vitest";
import {
  buildHeadingTargetTree,
  createFrozenHeadingTreeSignature,
  normalizeSelectedHeadingIds,
  parseHeadingTargets,
  parseLongWritingDocument,
  replaceChapterExact,
  validateHeadingTargetEdit,
} from "./chapterParser";

describe("long-writing Markdown chapter parser", () => {
  it("parses H2 chapters as complete subtrees and ignores fenced-code hashes", () => {
    const markdown = [
      "# 中文方案",
      "",
      "## 第一章 概述",
      "",
      "### 1.1 背景",
      "正文",
      "```markdown",
      "## 不是章节",
      "### 也不是子标题",
      "```",
      "",
      "#### 1.1.1 细节",
      "细节正文",
      "",
      "## 第二章 方案",
      "方案正文",
      "~~~",
      "# 仍不是标题",
      "~~~",
    ].join("\n");

    const parsed = parseLongWritingDocument(markdown);

    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters[0].titlePath).toEqual(["中文方案", "第一章 概述"]);
    expect(parsed.chapters[0].headings.map(item => [item.level, item.title])).toEqual([
      [2, "第一章 概述"],
      [3, "1.1 背景"],
      [4, "1.1.1 细节"],
    ]);
    expect(parsed.chapters[0].markdown).toContain("## 不是章节");
    expect(parsed.chapters[0].markdown).not.toContain("## 第二章 方案");
  });

  it("supports CRLF, duplicate Chinese titles, and empty chapters", () => {
    const markdown = "# 方案\r\n\r\n## 重复章节\r\n\r\n## 重复章节\r\n\r\n## 空章节";
    const parsed = parseLongWritingDocument(markdown);

    expect(parsed.lineEnding).toBe("\r\n");
    expect(parsed.chapters).toHaveLength(3);
    expect(new Set(parsed.chapters.map(item => item.id)).size).toBe(3);
    expect(parsed.chapters[2].bodyMarkdown).toBe("");
  });

  it("returns no worker chapters for no headings or only H1", () => {
    expect(parseLongWritingDocument("普通正文\n没有标题").chapters).toEqual([]);
    expect(parseLongWritingDocument("# 只有文档标题\n\n正文").chapters).toEqual([]);
  });

  it("keeps chapter IDs stable when body length and offsets change", () => {
    const before = "# 方案\n\n前言\n\n## 架构\n短正文\n\n### 接口\n说明";
    const after = "# 方案\n\n很长很长的新增前言内容\n继续增加\n\n## 架构\n完全不同且更长的正文\n\n### 接口\n新说明";

    const beforeChapter = parseLongWritingDocument(before).chapters[0];
    const afterChapter = parseLongWritingDocument(after).chapters[0];
    expect(afterChapter.id).toBe(beforeChapter.id);
    expect(afterChapter.heading.id).toBe(beforeChapter.heading.id);
  });

  it("does not close a longer fence with a shorter marker", () => {
    const markdown = "# 方案\n\n## 正文\n````\n## 代码标题\n```\n### 仍在代码中\n````\n### 真子标题\n内容";
    const chapter = parseLongWritingDocument(markdown).chapters[0];
    expect(chapter.headings.map(item => item.title)).toEqual(["正文", "真子标题"]);
  });

  it("creates an exact frozen signature and replaces only the selected chapter", () => {
    const markdown = "# 方案\r\n\r\n## 第一章\r\n旧正文\r\n\r\n### 子节\r\n旧内容\r\n\r\n## 第二章\r\n保持不变";
    const chapter = parseLongWritingDocument(markdown).chapters[0];
    const signature = createFrozenHeadingTreeSignature(chapter);
    const replacement = "## 第一章\n新正文\n\n### 子节\n新内容";

    const updated = replaceChapterExact(markdown, chapter.id, replacement);

    expect(signature).toBe(createFrozenHeadingTreeSignature(parseLongWritingDocument(updated).chapters[0]));
    expect(updated).toContain("## 第一章\r\n新正文\r\n\r\n### 子节\r\n新内容");
    expect(updated).toContain("## 第二章\r\n保持不变");
    expect(updated).not.toContain("旧正文");
  });

  it("refuses replacement that changes the frozen heading tree", () => {
    const markdown = "# 方案\n\n## 第一章\n正文\n\n### 子节\n内容";
    const chapter = parseLongWritingDocument(markdown).chapters[0];
    expect(() => replaceChapterExact(markdown, chapter.id, "## 第一章\n正文\n\n### 改名\n内容"))
      .toThrow("冻结标题树");
  });

  it("builds selectable H2-H6 targets and lets a parent cover descendants", () => {
    const markdown = "# 方案\n## A\n正文\n### A1\n内容\n#### A1.1\n细节\n## B\n正文";
    const targets = parseHeadingTargets(markdown);
    const tree = buildHeadingTargetTree(markdown);
    expect(targets.map(target => target.level)).toEqual([2, 3, 4, 2]);
    expect(tree[0].children[0].children[0].target.title).toBe("A1.1");
    expect(normalizeSelectedHeadingIds(markdown, [targets[0].id, targets[1].id, targets[3].id]))
      .toEqual([targets[0].id, targets[3].id]);
  });

  it("validates that a direct edit changes only the selected subtree", () => {
    const before = "# 方案\n## A\n正文\n### A1\n旧内容\n## B\n保持";
    const target = parseHeadingTargets(before).find(item => item.level === 3)!;
    const valid = before.replace("旧内容", "新内容和更多细节");
    const outside = valid.replace("## B\n保持", "## B\n被修改");
    const renamed = valid.replace("### A1", "### 接口设计");
    expect(validateHeadingTargetEdit(before, valid, target.id).valid).toBe(true);
    expect(validateHeadingTargetEdit(before, outside, target.id)).toMatchObject({ valid: false, reason: "outside_target" });
    expect(validateHeadingTargetEdit(before, renamed, target.id)).toMatchObject({
      valid: true,
      after: { title: "接口设计" },
    });
  });

  it("allows only the selected root title to change and keeps child headings frozen", () => {
    const before = "# 方案\n## 服内容\n正文\n### 服务边界\n内容\n## B\n保持";
    const target = parseHeadingTargets(before).find(item => item.level === 2)!;
    const rootRenamed = before.replace("## 服内容", "## 服务内容");
    const childRenamed = rootRenamed.replace("### 服务边界", "### 范围边界");

    expect(validateHeadingTargetEdit(before, rootRenamed, target.id)).toMatchObject({
      valid: true,
      after: { title: "服务内容" },
    });
    expect(validateHeadingTargetEdit(before, childRenamed, target.id)).toMatchObject({ valid: false, reason: "heading_tree" });
    });
});
