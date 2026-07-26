import { describe, expect, it } from "vitest";
import { applyHeadingAdaptDecisions, collectHeadingAdaptCandidates } from "./headingAdapt";

describe("full-document adaptive headings", () => {
  it("collects headings and isolated short candidates but ignores code and list items", () => {
    const markdown = ["# 方案", "", "第一章 概述", "", "- 普通列表", "", "```md", "## 代码示例", "```", "", "正文很短。"].join("\n");
    const candidates = collectHeadingAdaptCandidates(markdown);
    expect(candidates.map(item => item.text)).toEqual(["方案", "第一章 概述"]);
  });

  it("only changes decided lines and applies fixed numbering", () => {
    const markdown = "方案名称\n\n第一章 概述\n\n正文保持不变\n\n1.1 范围\n\n范围正文";
    const adapted = applyHeadingAdaptDecisions(markdown, [
      { line: 0, selected: true, level: 1 },
      { line: 2, selected: true, level: 2 },
      { line: 6, selected: true, level: 3 },
    ]);
    expect(adapted).toBe("# 方案名称\n\n## 第1章 概述\n\n正文保持不变\n\n### 1.1 范围\n\n范围正文");
  });
});
