// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LongWritingChangeRecord, OpenCodeConversationMessageCard } from "./LongWritingDetailModal";
import type { OpenCodeConversationMessage } from "./openCodeConversation";
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
    terminologyUsed: [],
    openQuestions: [],
  },
};

const message: OpenCodeConversationMessage = {
  id: "message-1",
  role: "assistant",
  model: "gpt-5",
  parts: [{ id: "part-1", kind: "text", text: "可选择并复制的会话正文" }],
};

describe("OpenCodeConversationMessageCard", () => {
  it("expands and collapses a conversation message from its header control", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let expanded = true;
    const render = () => root.render(<OpenCodeConversationMessageCard
      message={message}
      expanded={expanded}
      onToggle={() => { expanded = !expanded; render(); }}
    />);

    act(render);
    const toggle = container.querySelector<HTMLButtonElement>(".opencode-conversation-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("可选择并复制的会话正文");
    act(() => toggle?.click());
    expect(container.querySelector(".opencode-conversation-message")?.classList.contains("is-collapsed")).toBe(true);
    expect(container.querySelector(".opencode-conversation-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("可选择并复制的会话正文");
    act(() => root.unmount());
    container.remove();
  });
  it("renders visible reasoning, markdown output and tool activity as one agent turn", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const richMessage: OpenCodeConversationMessage = {
      id: "message-rich",
      role: "assistant",
      streaming: true,
      parts: [
        { id: "reasoning-1", kind: "reasoning", text: "先读取目标章节，再检查依赖。", streaming: true },
        { id: "tool-1", kind: "tool", tool: "read", status: "completed", input: { filePath: "proposal.md" }, output: "正文" },
        { id: "text-1", kind: "text", text: "**章节已完成**" },
      ],
    };

    act(() => root.render(<OpenCodeConversationMessageCard message={richMessage} expanded onToggle={() => undefined} />));
    expect(container.querySelector(".opencode-conversation-reasoning")?.textContent).toContain("先读取目标章节");
    expect(container.querySelector(".opencode-conversation-tool")?.textContent).toContain("read");
    expect(container.querySelector(".agent-message-markdown strong")?.textContent).toBe("章节已完成");
    expect(container.textContent).toContain("实时输出");
    act(() => root.unmount());
    container.remove();
  });

});

describe("LongWritingChangeRecord", () => {
  it("renders a completed worker edit as an in-conversation review action", () => {
    const html = renderToStaticMarkup(<LongWritingChangeRecord job={completedJob} />);
    expect(html).toContain("已修改正式文件");
    expect(html).toContain("补充总体设计说明");
    expect(html).toContain("修改已写入并通过目标范围校验");
    expect(html).toContain("查看修改");
  });

  it("keeps out-of-scope decisions in the same conversation record", () => {
    const html = renderToStaticMarkup(<LongWritingChangeRecord
      job={{
        ...completedJob,
        status: "awaiting_review",
        preEditDocumentMarkdown: "# 方案\n\n原始正文",
        scopeReview: {
          reason: "outside_target",
          proposedDocumentMarkdown: "# 方案\n\n越界修改",
          proposedDocumentHash: "proposed-hash",
          rollbackDocumentHash: "rollback-hash",
          createdAt: "2026-08-04T00:00:00.000Z",
        },
      }}
      onAcceptScopeReview={() => undefined}
      onRejectScopeReview={() => undefined}
    />);
    expect(html).toContain("修改超出目标范围，等待确认");
    expect(html).toContain("正式文件已自动回滚");
    expect(html).toContain("拒绝");
    expect(html).toContain("查看修改");
    expect(html).toContain("确认应用");
  });
});
