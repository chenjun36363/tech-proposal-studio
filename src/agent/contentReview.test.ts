import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedModelConfig } from "../core/types";
import type { AgentMessage, AgentToolDefinition } from "./protocol";
import { agentCompletion } from "../services/model";
import { formatContentReview, reviewContent } from "./contentReview";

vi.mock("../services/model", () => ({ agentCompletion: vi.fn() }));

const config: ResolvedModelConfig = {
  providerId: "provider",
  providerName: "Provider",
  protocol: "openai-completions",
  baseUrl: "https://example.com/v1",
  apiKey: "secret",
  model: "review-model",
  timeoutMs: 30000,
  headers: {},
  enabled: true,
};

function toolResponse(argumentsValue: Record<string, unknown>) {
  return {
    choices: [{
      message: {
        role: "assistant" as const,
        content: null,
        tool_calls: [{
          id: "review-1",
          type: "function" as const,
          function: { name: "submit_content_review", arguments: JSON.stringify(argumentsValue) },
        }],
      },
    }],
  };
}

describe("reviewContent", () => {
  beforeEach(() => vi.mocked(agentCompletion).mockReset());

  it("runs an isolated structured review and derives the overall result", async () => {
    vi.mocked(agentCompletion).mockResolvedValue(toolResponse({
      summary: "目标用户清楚，但缺少回滚方案。",
      checks: [
        { requirement_index: 1, status: "pass", evidence: "目标用户为企业架构师", explanation: "已明确受众。", suggestion: "" },
        { requirement_index: 2, status: "fail", evidence: "", explanation: "正文未说明失败后的恢复路径。", suggestion: "增加回滚步骤和触发条件。" },
      ],
    }));

    const result = await reviewContent({
      content: `## 目标

目标用户为企业架构师。`,
      requirements: ["必须说明目标用户", "必须包含回滚方案"],
      scopeLabel: "当前章节：目标",
    }, config);

    expect(result.overallStatus).toBe("needs_revision");
    expect(result.passedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.checks[1].suggestion).toContain("回滚步骤");
    const request = vi.mocked(agentCompletion).mock.calls[0][0] as {
      tools?: AgentToolDefinition[];
      tool_choice?: unknown;
      messages: AgentMessage[];
    };
    expect(request.tools?.[0].function.name).toBe("submit_content_review");
    expect(request.tool_choice).toEqual({ type: "function", function: { name: "submit_content_review" } });
    expect(request.messages[0].content).toContain("隔离的内容审核 Worker");
    expect(request.messages[1].content).toContain("目标用户为企业架构师");
  });

  it("downgrades an unanchored pass claim to uncertain", async () => {
    vi.mocked(agentCompletion).mockResolvedValue(toolResponse({
      summary: "声称满足要求。",
      checks: [
        { requirement_index: 1, status: "pass", evidence: "不存在的原文", explanation: "已满足。", suggestion: "" },
      ],
    }));

    const result = await reviewContent({
      content: "这里只说明了系统目标。",
      requirements: ["必须包含验收标准"],
      scopeLabel: "当前方案全文",
    }, config);

    expect(result.overallStatus).toBe("uncertain");
    expect(result.checks[0].status).toBe("uncertain");
    expect(result.checks[0].evidence).toBe("");
    expect(result.checks[0].explanation).toContain("未在待审核内容中找到");
  });

  it("rejects oversized review scopes before calling the model", async () => {
    await expect(reviewContent({
      content: "a".repeat(60001),
      requirements: ["检查完整性"],
      scopeLabel: "当前方案全文",
    }, config)).rejects.toThrow("缩小到选区或单个章节");
    expect(agentCompletion).not.toHaveBeenCalled();
  });

  it("formats a readable checklist for the agent timeline", () => {
    const text = formatContentReview({
      overallStatus: "pass",
      summary: "全部满足。",
      checks: [{ requirementIndex: 1, requirement: "包含目标", status: "pass", evidence: "目标明确", explanation: "存在直接说明。", suggestion: "" }],
      passedCount: 1,
      failedCount: 0,
      uncertainCount: 0,
    });
    expect(text).toContain("审核结论：通过");
    expect(text).toContain("✅ 1. 包含目标");
    expect(text).toContain("依据：目标明确");
  });
});
