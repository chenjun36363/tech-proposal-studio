import { describe, expect, it } from "vitest";
import type { AgentToolDefinition } from "../../agent/protocol";
import { estimateAgentTextTokens } from "../../agent/contextCompaction";
import { LongWritingContextBudgetError, prepareLongWritingPayload, resolveLongWritingContextBudget, selectRelevantSourceExcerpts } from "./contextBudget";

const tool: AgentToolDefinition = {
  type: "function",
  function: {
    name: "submit_test",
    description: "提交结构化结果",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

const prompt = "你是长篇方案处理器，只能调用指定工具。";
const prefix = "请处理以下输入：";

function longMarkdown(chapters = 16, bodySize = 1200): string {
  return ["# 技术方案", ...Array.from({ length: chapters }, (_, index) => [
    `## 第${index + 1}章 章节${index + 1}`,
    `### ${index + 1}.1 子标题`,
    `正文${index + 1}：${"技术内容与固定事实".repeat(bodySize)}`,
  ].join("\n\n"))].join("\n\n");
}

describe("long writing context budget", () => {
  it("caps input against the real model window after reserving output", () => {
    expect(resolveLongWritingContextBudget("outline", {
      contextBudgetTokens: 98000,
      modelContextWindowTokens: 32000,
    })).toMatchObject({
      requestedBudgetTokens: 98000,
      modelContextWindowTokens: 32000,
      outputReserveTokens: 6000,
      budgetTokens: 24976,
    });
  });

  it("selects relevant source chunks for a chapter instead of repeating entire attachments", () => {
    const excerpts = selectRelevantSourceExcerpts([
      "总体需求\n\n# 项目背景\n\n建设目标和范围。\n\n# 运维服务\n\n提供 7×24 运维与故障响应。",
      "安全规范\n\n# 安全设计\n\n身份认证、访问控制与审计。",
    ], "运维服务 故障响应", 2);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[0]).toContain("运维服务");
    expect(excerpts[0]).toContain("总体需求");
  });

  it("shares the source budget and keeps the final request within the configured limit", () => {
    const result = prepareLongWritingPayload({
      phase: "outline",
      input: {
        mode: "rewrite",
        instruction: "统一改写",
        markdown: "# 技术方案\n\n## 第一章 概述\n\n正文",
        attachedSources: Array.from({ length: 6 }, (_, index) => `资料${index + 1}：${"来源事实".repeat(5000)}`),
        contextBudgetTokens: 8000,
      },
      systemPrompt: prompt,
      userPrefix: prefix,
      tool,
    });

    expect(result.estimatedTokens).toBeLessThanOrEqual(8000);
    expect(result.truncatedSources + result.omittedSources).toBeGreaterThan(0);
    expect(result.payload.attachedSources).toBeInstanceOf(Array);
    expect(JSON.stringify(result.payload)).not.toContain("contextBudgetTokens");
  });

  it("compacts an oversized full document into an H2-aware overview", () => {
    const markdown = longMarkdown();
    const result = prepareLongWritingPayload({
      phase: "consistency",
      input: { markdown, outlinePlan: { documentSummary: "摘要" }, contextBudgetTokens: 8000 },
      systemPrompt: prompt,
      userPrefix: prefix,
      tool,
    });

    expect(result.compactedMarkdown).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(8000);
    const compacted = String(result.payload.markdown);
    expect(compacted).toContain("## 第1章 章节1");
    expect(compacted).toContain("## 第16章 章节16");
    expect(estimateAgentTextTokens(compacted)).toBeLessThan(estimateAgentTextTokens(markdown));
  });

  it("compacts an oversized chapter summary instead of failing on context length", () => {
    const markdown = `## 第一章 概述\n\n${"本章关键正文".repeat(3000)}`;
    const result = prepareLongWritingPayload({
      phase: "chapter_summary",
      input: { chapterId: "chapter-1", titlePath: ["第一章 概述"], markdown, instruction: "总结" , contextBudgetTokens: 8000 },
      systemPrompt: prompt,
      userPrefix: prefix,
      tool,
    });

    expect(result.compactedMarkdown).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(8000);
    expect(String(result.payload.markdown)).toContain("## 第一章 概述");
    expect(String(result.payload.markdown).length).toBeLessThan(markdown.length);
  });

  it("does not silently truncate an oversized current chapter", () => {
    expect(() => prepareLongWritingPayload({
      phase: "chapter_draft",
      input: {
        chapterId: "chapter-1",
        originalMarkdown: `## 第一章 概述\n\n${"本章关键正文".repeat(3000)}`,
        contextBudgetTokens: 8000,
      },
      systemPrompt: prompt,
      userPrefix: prefix,
      tool,
    })).toThrow(LongWritingContextBudgetError);
  });
});
