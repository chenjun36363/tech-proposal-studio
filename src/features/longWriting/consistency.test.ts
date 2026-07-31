import { describe, expect, it } from "vitest";
import { parseLongWritingDocument } from "./chapterParser";
import { inspectLocalConsistency } from "./consistency";
import type { OutlinePlan } from "./types";

function planFor(markdown: string): OutlinePlan {
  const chapters = parseLongWritingDocument(markdown).chapters;
  return {
    documentSummary: "摘要",
    audience: "评审人",
    writingRules: [],
    fixedFacts: [],
    terminology: [],
    transitionRequirements: [],
    targetChapterIds: chapters.map(chapter => chapter.id),
    frozenOutline: chapters.map(chapter => ({
      chapterId: chapter.id,
      order: chapter.order,
      titlePath: chapter.titlePath,
      headingSkeleton: chapter.headings.map(heading => `${"#".repeat(heading.level)} ${heading.title}`),
      goal: "完善",
      action: "rewrite",
    })),
  };
}

describe("inspectLocalConsistency", () => {
  it("accepts a document that preserves the frozen outline", () => {
    const markdown = "# 标题\n\n## 第一章\n\n正文\n\n### 1.1 子节\n\n内容\n";
    expect(inspectLocalConsistency(planFor(markdown), markdown)).toEqual([]);
  });

  it("reports missing, extra and reordered chapters", () => {
    const original = "# 标题\n\n## A\n\n正文 A\n\n## B\n\n正文 B\n";
    const plan = planFor(original);
    const changed = "# 标题\n\n## B\n\n正文 B\n\n## C\n\n正文 C\n";
    const types = inspectLocalConsistency(plan, changed).map(issue => issue.type);
    expect(types).toContain("missing_chapter");
    expect(types).toContain("markdown");
  });

  it("reports an empty targeted chapter", () => {
    const markdown = "# 标题\n\n## A\n\n";
    const issues = inspectLocalConsistency(planFor(markdown), markdown);
    expect(issues.some(issue => issue.evidence.includes("没有有效正文"))).toBe(true);
  });
});
