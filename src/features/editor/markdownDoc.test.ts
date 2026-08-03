import { describe, expect, it } from "vitest";
import {
  alignHeadingsToRules,
  applyAgentDraft,
  applyHeadingLevel,
  countMarkdownWords,
  deleteSection,
  formatHeadingPrefix,
  insertSection,
  moveSection,
  parseMarkdownHeadings,
  remapHeadingAfterMarkdownChange,
  renumberHeadings,
  replaceSection,
  replaceSelection,
  sectionBody,
  shiftHeadingSectionLevels,
  stripHeadingPrefix,
} from "./markdownDoc";

describe("Markdown word count", () => {
  it("counts visible text without syntax or whitespace", () => {
    expect(countMarkdownWords("# 标题\n\n**正文** [链接](https://example.com)\n\n- 列表"))
      .toBe("标题正文链接列表".length);
  });
});

describe("heading selection remapping", () => {
  it("keeps the edited non-first section selected when its title changes", () => {
    const before = "# 方案\n\n## 第1章 背景\n\n正文\n\n## 第2章 架构\n\n架构正文";
    const selected = parseMarkdownHeadings(before)[2];
    const after = replaceSection(before, selected, "## 第2章 总体架构\n\n架构正文");

    const remapped = remapHeadingAfterMarkdownChange(before, after, selected.id);

    expect(remapped?.title).toBe("第2章 总体架构");
    expect(remapped?.start).toBe(selected.start);
  });

  it("finds the same heading after renumbering changes offsets before it", () => {
    const before = "# 方案\n\n## 第9章 很长的背景标题\n\n正文\n\n## 第8章 架构\n\n架构正文";
    const selected = parseMarkdownHeadings(before)[2];
    const after = renumberHeadings(before);

    expect(remapHeadingAfterMarkdownChange(before, after, selected.id)?.title).toBe("第2章 架构");
  });

  it("does not confuse an inserted document title with the previously selected chapter", () => {
    const before = "## 背景\n\n正文\n\n## 架构\n\n架构正文";
    const selected = parseMarkdownHeadings(before)[0];
    const after = alignHeadingsToRules(before, "项目方案").markdown;

    expect(remapHeadingAfterMarkdownChange(before, after, selected.id)?.title).toBe("第1章 背景");
  });
});

describe("heading numbering", () => {
  it("preserves every existing heading level while keeping the first H1 as the document title", () => {
    const markdown = ["# 项目方案", "", "# 1 项目必要性分析", "", "## 第1章 项目背景", "", "### 1.1 建设依据", "", "# 2 项目需求分析"].join("\n");
    expect(alignHeadingsToRules(markdown)).toEqual({
      markdown: ["# 项目方案", "", "# 项目必要性分析", "", "## 第1章 项目背景", "", "### 1.1 建设依据", "", "# 项目需求分析"].join("\n"),
      headingCount: 5,
      demotedCount: 0,
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

  it("promotes the first preamble line when the document has no H1 title", () => {
    const markdown = "项目可行性研究报告\n\n申报单位：某某单位\n\n## 1 项目必要性分析\n\n## 2 项目需求分析";
    expect(alignHeadingsToRules(markdown)).toEqual({
      markdown: "# 项目可行性研究报告\n\n申报单位：某某单位\n\n## 第1章 项目必要性分析\n\n## 第2章 项目需求分析",
      headingCount: 3,
      demotedCount: 0,
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
    expect(stripHeadingPrefix("第2节 范围")).toBe("范围");
    expect(stripHeadingPrefix("一、总体要求")).toBe("总体要求");
    expect(stripHeadingPrefix("（一）建设内容")).toBe("建设内容");
    expect(stripHeadingPrefix("(1) 实施步骤")).toBe("实施步骤");
  });

  it("formats fixed prefixes from the shared default configuration", () => {
    expect(formatHeadingPrefix(1, [2, 0, 0, 0, 0, 0])).toBe("");
    expect(formatHeadingPrefix(2, [0, 3, 0, 0, 0, 0])).toBe("第3章");
    expect(formatHeadingPrefix(3, [0, 2, 4, 0, 0, 0])).toBe("2.4");
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

  it("uses the configured start level without changing heading hierarchy", () => {
    const current = "# 甘肃方案\n\n## 第9章 背景\n\n### 8.3 政策\n\n#### 7.6.5 国家要求";
    const converted = alignHeadingsToRules(current, "甘肃方案", { schemeId: "chapter", startLevel: 3 }).markdown;

    expect(converted).toBe("# 甘肃方案\n\n## 背景\n\n### 第一章 政策\n\n#### 1.1 国家要求");
    expect(parseMarkdownHeadings(converted).map(heading => heading.level)).toEqual([1, 2, 3, 4]);
  });

  it("clears recognized numbering when the shared scheme is none", () => {
    const current = "# 甘肃方案\n\n## 第2章 背景\n\n### （一）政策\n\n#### (1) 国家要求";
    expect(renumberHeadings(current, { schemeId: "none", startLevel: 2 })).toBe(
      "# 甘肃方案\n\n## 背景\n\n### 政策\n\n#### 国家要求",
    );
  });

  it("promotes a heading and all descendants, then renumbers the document", () => {
    const md = "# 方案\n\n## 第1章 概述\n\n### 1.1 范围\n\n#### 1.1.1 细节\n\n## 第2章 其他";
    const target = parseMarkdownHeadings(md)[2];
    const result = shiftHeadingSectionLevels(md, target.id, "promote");
    expect(result.changedCount).toBe(2);
    expect(result.markdown).toContain("## 第2章 范围");
    expect(result.markdown).toContain("### 2.1 细节");
    expect(parseMarkdownHeadings(result.markdown).find(item => item.id === result.headingId)?.level).toBe(2);
  });

  it("demotes a heading and all descendants, then renumbers the document", () => {
    const md = "# 方案\n\n## 概述\n\n## 其他\n\n### 范围";
    const target = parseMarkdownHeadings(md)[2];
    const result = shiftHeadingSectionLevels(md, target.id, "demote");
    expect(result.changedCount).toBe(2);
    expect(result.markdown).toContain("### 1.1 其他");
    expect(result.markdown).toContain("#### 1.1.1 范围");
  });

  it("protects the H1 and H6 boundaries when shifting a subtree", () => {
    const md = "# 方案\n\n## 概述\n\n###### 细节";
    const [title, chapter] = parseMarkdownHeadings(md);
    expect(() => shiftHeadingSectionLevels(md, title.id, "promote")).toThrow("H1 已是最高标题级别");
    expect(() => shiftHeadingSectionLevels(md, chapter.id, "demote")).toThrow("包含 H6");
  });

  it("supports promoting H2 and demoting H1", () => {
    const md = "# 方案\n\n## 概述\n\n### 范围";
    const [title, chapter] = parseMarkdownHeadings(md);
    expect(parseMarkdownHeadings(shiftHeadingSectionLevels(md, chapter.id, "promote").markdown)[1].level).toBe(1);
    expect(parseMarkdownHeadings(shiftHeadingSectionLevels(md, title.id, "demote").markdown)[0].level).toBe(2);
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

  it("removes a section and its descendants", () => {
    const markdown = "# 方案\n\n## 第一章\n\n正文一\n### 子章节\n\n子正文\n## 第二章\n\n正文二";
    const headings = parseMarkdownHeadings(markdown);
    const removed = deleteSection(markdown, headings[1]);

    expect(removed).not.toContain("## 第一章");
    expect(removed).not.toContain("正文一");
    expect(removed).not.toContain("### 子章节");
    expect(removed).not.toContain("子正文");
    expect(removed).toContain("## 第二章");
    expect(removed).toContain("正文二");
  });
});

describe("agent edit proposal application", () => {
  const markdown = "# 方案\n\n## 第一章 背景\n\n旧内容\n\n### 1.1 子章节\n\n子内容\n\n## 第二章 架构\n\n架构正文";

  it("replaces a reviewed section and rejects a stale snapshot", () => {
    const heading = parseMarkdownHeadings(markdown)[1];
    const before = sectionBody(markdown, heading);
    const draft = {
      callId: "replace-1",
      operation: "replace_section" as const,
      target: { sectionId: heading.id, snapshot: before },
      before,
      after: "## 背景\n\n新内容",
      instruction: "更新背景",
    };

    expect(applyAgentDraft(markdown, draft).markdown).toContain("## 背景\n\n新内容");
    expect(() => applyAgentDraft(markdown.replace("旧内容", "用户新内容"), draft)).toThrow("原文不再匹配");
    expect(() => applyAgentDraft(markdown, { ...draft, target: { ...draft.target, sectionId: "missing" } })).toThrow("目标章节已不存在");
  });

  it("replaces only the reviewed absolute selection", () => {
    const start = markdown.indexOf("架构正文");
    const next = replaceSelection(markdown, start, start + 4, "架构正文", "新架构");

    expect(next).toContain("新架构");
    expect(() => replaceSelection(markdown, start, start + 4, "错误快照", "新架构")).toThrow("选区原文不再匹配");
  });

  it("inserts a heading section with stable spacing", () => {
    const target = parseMarkdownHeadings(markdown)[2];
    const next = insertSection(markdown, target, "after", "## 安全设计\n\n安全正文");

    expect(next).toContain("子内容\n\n## 安全设计\n\n安全正文\n\n## 第二章 架构");
  });

  it("deletes a section with descendants but never the document H1", () => {
    const chapter = parseMarkdownHeadings(markdown)[1];
    const before = sectionBody(markdown, chapter);
    const deleted = applyAgentDraft(markdown, {
      callId: "delete-1",
      operation: "delete_section",
      target: { sectionId: chapter.id, snapshot: before },
      before,
      after: "",
      instruction: "删除背景",
    }).markdown;

    expect(deleted).not.toContain("旧内容");
    expect(deleted).not.toContain("子内容");
    expect(deleted).toContain("架构正文");

    const title = parseMarkdownHeadings(markdown)[0];
    const titleBody = sectionBody(markdown, title);
    expect(() => applyAgentDraft(markdown, {
      callId: "delete-title",
      operation: "delete_section",
      target: { sectionId: title.id, snapshot: titleBody },
      before: titleBody,
      after: "",
      instruction: "删除标题",
    })).toThrow("不能删除文档 H1");
  });

  it("moves a reviewed chapter with descendants without rewriting mixed heading numbers", () => {
    const headings = parseMarkdownHeadings(markdown);
    const source = headings[1];
    const destination = headings[3];
    const moved = applyAgentDraft(markdown, {
      callId: "move-1",
      operation: "move_section",
      target: {
        sectionId: source.id,
        snapshot: sectionBody(markdown, source),
        destinationSectionId: destination.id,
        destinationSnapshot: sectionBody(markdown, destination),
        position: "after",
      },
      before: sectionBody(markdown, source),
      after: sectionBody(markdown, source),
      instruction: "调整章节顺序",
    }).markdown;

    expect(moved.indexOf("架构正文")).toBeLessThan(moved.indexOf("旧内容"));
    expect(moved.indexOf("子内容")).toBeGreaterThan(moved.indexOf("旧内容"));
    expect(moved).toContain("## 第一章 背景");
    expect(moved).toContain("### 1.1 子章节");
    expect(moved).toContain("## 第二章 架构");
  });

  it("validates both chapter snapshots before moving", () => {
    const headings = parseMarkdownHeadings(markdown);
    const source = headings[1];
    const destination = headings[3];
    const draft = {
      callId: "move-conflict",
      operation: "move_section" as const,
      target: {
        sectionId: source.id,
        snapshot: sectionBody(markdown, source),
        destinationSectionId: destination.id,
        destinationSnapshot: sectionBody(markdown, destination),
        position: "before" as const,
      },
      before: sectionBody(markdown, source),
      after: sectionBody(markdown, source),
      instruction: "移动章节",
    };

    expect(() => applyAgentDraft(markdown.replace("旧内容", "源章节已改"), draft)).toThrow("目标章节原文不再匹配");
    expect(() => applyAgentDraft(markdown.replace("架构正文", "目标章节已改"), draft)).toThrow("目标位置章节原文不再匹配");
    expect(() => applyAgentDraft(markdown, { ...draft, target: { ...draft.target, destinationSectionId: "missing" } })).toThrow("目标位置章节已不存在");
  });

  it("rejects moving H1, moving to itself, or moving into descendants", () => {
    const headings = parseMarkdownHeadings(markdown);
    const title = headings[0];
    const source = headings[1];
    const child = headings[2];
    const makeDraft = (from: typeof source, to: typeof source) => ({
      callId: "invalid-move", operation: "move_section" as const,
      target: { sectionId: from.id, snapshot: sectionBody(markdown, from), destinationSectionId: to.id, destinationSnapshot: sectionBody(markdown, to), position: "after" as const },
      before: sectionBody(markdown, from), after: sectionBody(markdown, from), instruction: "移动",
    });

    expect(() => applyAgentDraft(markdown, makeDraft(title, source))).toThrow("不能移动文档 H1");
    expect(() => applyAgentDraft(markdown, makeDraft(source, source))).toThrow("不能将章节移动到自身");
    expect(() => applyAgentDraft(markdown, makeDraft(source, child))).toThrow("不能将章节移动到其子章节内");
  });
});
