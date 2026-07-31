import { parseLongWritingDocument } from "./chapterParser";
import type { ConsistencyIssue, OutlinePlan } from "./types";

function issueId(kind: string, chapterIds: string[], index: number): string {
  return `local-${kind}-${chapterIds.join("-") || "document"}-${index}`;
}

/** Deterministic checks that run before the model consistency review. */
export function inspectLocalConsistency(plan: OutlinePlan, markdown: string): ConsistencyIssue[] {
  const parsed = parseLongWritingDocument(markdown);
  const issues: ConsistencyIssue[] = [];
  const actualById = new Map(parsed.chapters.map(chapter => [chapter.id, chapter]));
  const expectedIds = new Set(plan.frozenOutline.map(item => item.chapterId));

  plan.frozenOutline.forEach((item, index) => {
    const chapter = actualById.get(item.chapterId);
    if (!chapter) {
      issues.push({
        id: issueId("missing", [item.chapterId], index),
        type: "missing_chapter",
        chapterIds: [item.chapterId],
        evidence: `冻结目录中的“${item.titlePath.join(" / ")}”已不存在或标题被改变。`,
        severity: "high",
        suggestion: "恢复该章节及其冻结标题树后再继续。",
        status: "pending",
      });
      return;
    }

    const actualSkeleton = chapter.headings.map(heading => `${"#".repeat(heading.level)} ${heading.title}`);
    if (JSON.stringify(actualSkeleton) !== JSON.stringify(item.headingSkeleton)) {
      issues.push({
        id: issueId("heading", [item.chapterId], index),
        type: "markdown",
        chapterIds: [item.chapterId],
        evidence: `“${item.titlePath.join(" / ")}”的标题层级或标题文本与冻结目录不一致。`,
        severity: "high",
        suggestion: "按冻结目录恢复标题文本、层级和父子关系。",
        status: "pending",
      });
    }

    if (!chapter.bodyMarkdown.replace(/^ {0,3}(?:`{3,}|~{3,}).*$/gm, "").trim()) {
      issues.push({
        id: issueId("empty", [item.chapterId], index),
        type: "missing_chapter",
        chapterIds: [item.chapterId],
        evidence: `“${item.titlePath.join(" / ")}”没有有效正文。`,
        severity: item.action === "keep" ? "medium" : "high",
        suggestion: "补充与章节目标一致的正文。",
        status: "pending",
      });
    }
  });

  parsed.chapters.forEach((chapter, index) => {
    if (expectedIds.has(chapter.id)) return;
    issues.push({
      id: issueId("extra", [chapter.id], index),
      type: "markdown",
      chapterIds: [chapter.id],
      evidence: `发现冻结目录之外的 H2 章节“${chapter.titlePath.join(" / ")}”。`,
      severity: "high",
      suggestion: "删除额外章节，或恢复到已确认的冻结目录。",
      status: "pending",
    });
  });

  const actualOrder = parsed.chapters.filter(chapter => expectedIds.has(chapter.id)).map(chapter => chapter.id);
  const expectedOrder = plan.frozenOutline.filter(item => actualById.has(item.chapterId)).map(item => item.chapterId);
  if (JSON.stringify(actualOrder) !== JSON.stringify(expectedOrder)) {
    issues.push({
      id: issueId("order", actualOrder, issues.length),
      type: "markdown",
      chapterIds: actualOrder,
      evidence: "当前 H2 章节顺序与冻结目录不一致。",
      severity: "high",
      suggestion: "按已确认目录恢复章节顺序。",
      status: "pending",
    });
  }

  return issues;
}
