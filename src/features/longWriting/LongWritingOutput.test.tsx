import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createLongWritingEvent } from "./events";
import { LongWritingEventLog, LongWritingJobCard } from "./LongWritingOutput";
import type { ChapterJob } from "./types";

const completedJob: ChapterJob = {
  id: "job-1",
  taskId: "task-1",
  chapterId: "chapter-1",
  order: 0,
  titlePath: ["第一章 总体设计"],
  status: "completed",
  originalMarkdown: "## 第一章 总体设计\n\n旧正文\n",
  originalHash: "old-hash",
  frozenHeadingSignature: "signature",
  attempts: 1,
  maxAttempts: 3,
  draft: {
    chapterId: "chapter-1",
    markdown: "## 第一章 总体设计\n\n新的实施正文\n",
    summary: "补充总体设计说明",
    factsUsed: ["部署在用户内网"],
    terminologyUsed: [{ term: "LIMS", definition: "实验室信息管理系统" }],
    openQuestions: [],
  },
};

describe("LongWritingOutput", () => {
  it("renders persisted execution events with a live indicator", () => {
    const html = renderToStaticMarkup(<LongWritingEventLog events={[
      createLongWritingEvent("commit_completed", "第一章已原子提交", { at: "2026-07-31T08:09:10.000Z" }),
    ]} busy />);
    expect(html).toContain("执行动态");
    expect(html).toContain("第一章已原子提交");
    expect(html).toContain("long-writing-live-dot");
    expect(html).toContain("不展示模型内部推理");
  });

  it("labels disk conflicts as a distinct persisted execution event", () => {
    const html = renderToStaticMarkup(<LongWritingEventLog events={[
      createLongWritingEvent("conflict_detected", "检测到磁盘版本变化", { at: "2026-07-31T08:09:10.000Z" }),
    ]} busy={false} />);
    expect(html).toContain("冲突");
    expect(html).toContain("检测到磁盘版本变化");
  });

  it("renders a completed chapter summary that opens the global detail dialog", () => {
    const html = renderToStaticMarkup(<LongWritingJobCard
      job={completedJob}
      filePath="D:\\workspace\\proposal.md"
      workspaceRoot="D:\\workspace"
      onRetry={() => undefined}
      onLocate={() => undefined}
    />);
    expect(html).toContain("第一章 总体设计");
    expect(html).toContain("完成");
    expect(html).toContain("第 1 次尝试");
    expect(html).toContain("查看章节详情");
    expect(html).toContain("→");
  });
  it("marks an out-of-scope edit as awaiting confirmation", () => {
    const html = renderToStaticMarkup(<LongWritingJobCard
      job={{
        ...completedJob,
        status: "awaiting_review",
        scopeReview: {
          reason: "outside_target",
          proposedDocumentMarkdown: "# 方案\n\n越界修改",
          proposedDocumentHash: "proposed-hash",
          rollbackDocumentHash: "rollback-hash",
          createdAt: "2026-08-04T00:00:00.000Z",
        },
      }}
      filePath="D:\\workspace\\proposal.md"
      workspaceRoot="D:\\workspace"
      onRetry={() => undefined}
      onLocate={() => undefined}
    />);
    expect(html).toContain("待确认");
  });
});
