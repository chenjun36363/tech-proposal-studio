// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCompletion } from "../../services/model";
import {
  createChapterDraft,
  createChapterSummary,
  createConsistencyReport,
  createLocalChapterSummary,
  createOutlinePlan,
  type ChapterDraftInput,
  type ChapterSummaryInput,
  type ConsistencyCheckInput,
  type OutlinePlanningInput,
} from "./model";

vi.mock("../../services/model", () => ({ agentCompletion: vi.fn() }));

const config = {
  baseUrl: "https://example.com/v1",
  apiKey: "test-key",
  model: "test-model",
  timeoutMs: 1000,
  headers: {},
  enabled: true,
} as const;

const plan = {
  documentSummary: "建设统一技术方案平台。",
  audience: "项目评审专家",
  writingRules: ["使用正式书面语"],
  fixedFacts: ["部署在客户内网"],
  terminology: [{ term: "平台", definition: "本项目交付的软件系统" }],
  frozenOutline: [{
    chapterId: "chapter-1",
    order: 0,
    titlePath: ["第一章 项目概述"],
    headingSkeleton: ["## 第一章 项目概述", "### 1.1 建设背景"],
    goal: "说明建设背景和目标",
    action: "rewrite",
  }],
  transitionRequirements: [],
  targetChapterIds: ["chapter-1"],
};

const chapterSummary = {
  chapterId: "chapter-1",
  titlePath: ["第一章 项目概述"],
  summary: "说明项目建设背景。",
  facts: ["部署在客户内网"],
  terminology: [{ term: "平台", definition: "本项目交付的软件系统" }],
  unresolvedQuestions: [],
};

const draft = {
  chapterId: "chapter-1",
  markdown: "## 第一章 项目概述\n\n### 1.1 建设背景\n\n正文。",
  summary: "说明项目建设背景。",
  factsUsed: ["部署在客户内网"],
  terminologyUsed: [{ term: "平台", definition: "本项目交付的软件系统" }],
  openQuestions: [],
};

const issues = [{
  id: "issue-1",
  type: "terminology",
  chapterIds: ["chapter-1", "chapter-2"],
  evidence: "两章对同一系统使用了不同名称。",
  severity: "medium",
  suggestion: "统一使用“平台”。",
  status: "pending",
}];

function rawToolResponse(name: string, argumentsValue: string) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name, arguments: argumentsValue },
        }],
      },
    }],
  };
}

function toolResponse(name: string, argumentsValue: unknown) {
  return rawToolResponse(name, JSON.stringify(argumentsValue));
}

function lastPayload(): Record<string, unknown> {
  return vi.mocked(agentCompletion).mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

function expectForcedOnly(name: string): void {
  const payload = lastPayload();
  expect(payload.tool_choice).toEqual({ type: "function", function: { name } });
  expect(payload.tools).toEqual([
    expect.objectContaining({
      type: "function",
      function: expect.objectContaining({ name }),
    }),
  ]);
  expect(payload.stream).toBe(false);
}

describe("long writing structured model calls", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("forces submit_outline_plan and parses its tool JSON", async () => {
    vi.mocked(agentCompletion).mockResolvedValue(toolResponse("submit_outline_plan", plan));
    const input: OutlinePlanningInput = {
      mode: "rewrite",
      instruction: "统一改写全文",
      markdown: "# 方案\n\n## 第一章 项目概述",
    };

    await expect(createOutlinePlan(input, config)).resolves.toEqual(plan);

    expectForcedOnly("submit_outline_plan");
    expect(agentCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: "test-model" }),
      config,
      undefined,
    );
  });

  it("passes the explicit title and attached sources when planning a from-zero document", async () => {
    const creationPlan = {
      ...plan,
      frozenOutline: [{
        ...plan.frozenOutline[0],
        chapterId: "planned-1",
        titlePath: ["智慧园区技术方案", "建设目标"],
        headingSkeleton: ["## 建设目标"],
        action: "fill",
      }],
      targetChapterIds: ["planned-1"],
    };
    vi.mocked(agentCompletion).mockResolvedValue(toolResponse("submit_outline_plan", creationPlan));

    await expect(createOutlinePlan({
      mode: "create",
      documentTitle: "智慧园区技术方案",
      instruction: "基于资料创建一份完整技术方案",
      markdown: "# 智慧园区技术方案\n",
      attachedSources: ["招标文件\n必须覆盖建设目标和总体架构"],
    }, config)).resolves.toEqual(creationPlan);

    const payload = lastPayload();
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("智慧园区技术方案");
    expect(serialized).toContain("必须覆盖建设目标和总体架构");
    expect(JSON.stringify(payload.messages)).toContain("从零创建文档");
  });

  it("rejects a from-zero plan that does not contain a chapter", async () => {
    vi.mocked(agentCompletion).mockResolvedValue(toolResponse("submit_outline_plan", {
      ...plan,
      frozenOutline: [],
      targetChapterIds: [],
    }));

    await expect(createOutlinePlan({
      mode: "create",
      documentTitle: "新方案",
      instruction: "创建方案",
      markdown: "",
    }, config)).rejects.toThrow("至少需要一个 H2 章节");
  });

  it("rejects a from-zero plan with an empty chapter title", async () => {
    vi.mocked(agentCompletion).mockResolvedValue(toolResponse("submit_outline_plan", {
      ...plan,
      frozenOutline: [{
        ...plan.frozenOutline[0],
        chapterId: "planned-1",
        titlePath: [],
        headingSkeleton: [],
        action: "fill",
      }],
      targetChapterIds: ["planned-1"],
    }));

    await expect(createOutlinePlan({
      mode: "create",
      documentTitle: "新方案",
      instruction: "创建方案",
      markdown: "",
    }, config)).rejects.toThrow("缺少标题");
  });

  it("applies phase output limits and does not send the local context budget field", async () => {
    vi.mocked(agentCompletion).mockResolvedValue(toolResponse("submit_chapter_summary", chapterSummary));

    await createChapterSummary({
      chapterId: "chapter-1",
      titlePath: ["第一章 项目概述"],
      markdown: "## 第一章 项目概述\n\n正文。",
      documentTitle: "技术方案",
      instruction: "总结",
      contextBudgetTokens: 12000,
    }, config);

    const payload = lastPayload();
    expect(payload.max_tokens).toBe(3000);
    expect(JSON.stringify(payload)).not.toContain("contextBudgetTokens");
  });

  it("rebuilds the request with a smaller context budget after a provider context overflow", async () => {
    vi.mocked(agentCompletion)
      .mockRejectedValueOnce(new Error("context_length_exceeded: maximum context length"))
      .mockResolvedValueOnce(toolResponse("submit_outline_plan", plan));

    await expect(createOutlinePlan({
      mode: "rewrite",
      instruction: "统一改写全文",
      markdown: "# 方案\n\n## 第一章 项目概述",
      attachedSources: ["招标文件\n" + "建设范围、功能要求与验收标准。".repeat(9000)],
      contextBudgetTokens: 20000,
      modelContextWindowTokens: 32000,
    }, config)).resolves.toEqual(plan);

    expect(agentCompletion).toHaveBeenCalledTimes(2);
    const first = vi.mocked(agentCompletion).mock.calls[0][0] as { messages: Array<{ content: string }> };
    const second = vi.mocked(agentCompletion).mock.calls[1][0] as { messages: Array<{ content: string }> };
    expect(second.messages[1].content.length).toBeLessThan(first.messages[1].content.length);
  });

  it("keeps full plans only for the target and adjacent chapters in chapter workers", async () => {
    vi.mocked(agentCompletion).mockResolvedValue(toolResponse("submit_chapter_draft", draft));
    const expandedPlan = {
      ...plan,
      frozenOutline: Array.from({ length: 5 }, (_, index) => ({
        chapterId: `chapter-${index + 1}`,
        order: index,
        titlePath: [`第${index + 1}章`],
        headingSkeleton: [`## 第${index + 1}章`, `### ${index + 1}.1 详细标题`],
        goal: `章节目标 ${index + 1} ${"详细约束".repeat(100)}`,
        action: "rewrite" as const,
      })),
      targetChapterIds: ["chapter-1"],
    };

    await createChapterDraft({
      chapterId: "chapter-1",
      titlePath: ["第一章"],
      originalMarkdown: "## 第一章\n\n正文。",
      chapterGoal: "改写",
      outlinePlan: expandedPlan,
      contextBudgetTokens: 12000,
    }, config);

    const messages = lastPayload().messages as Array<{ role: string; content: string }>;
    const userPayload = messages.find(message => message.role === "user")?.content ?? "";
    expect(userPayload).toContain("### 2.1 详细标题");
    expect(userPayload).toContain("## 第5章");
    expect(userPayload).not.toContain("### 5.1 详细标题");
  });

  it("falls back to auto when a DeepSeek-compatible gateway rejects forced tool_choice", async () => {
    vi.mocked(agentCompletion)
      .mockRejectedValueOnce(new Error("模型服务返回 400：[400] Error from provider (DeepSeek): Failed to deserialize the JSON body into the target type:tool choice: field function : invalid type: null, expected struct ToolChoiceFunction"))
      .mockResolvedValueOnce(toolResponse("submit_outline_plan", plan));

    await expect(createOutlinePlan({
      mode: "rewrite",
      instruction: "统一改写全文",
      markdown: "# 方案\n\n## 第一章 项目概述",
    }, config)).resolves.toEqual(plan);

    expect(agentCompletion).toHaveBeenCalledTimes(2);
    expect(vi.mocked(agentCompletion).mock.calls[0][0]).toEqual(expect.objectContaining({
      tool_choice: { type: "function", function: { name: "submit_outline_plan" } },
    }));
    expect(vi.mocked(agentCompletion).mock.calls[1][0]).toEqual(expect.objectContaining({
      tool_choice: "auto",
      tools: [expect.objectContaining({
        function: expect.objectContaining({ name: "submit_outline_plan" }),
      })],
    }));
  });

  it("uses auto immediately for DeepSeek routes behind the Responses protocol", async () => {
    const deepSeekResponsesConfig = {
      ...config,
      providerId: "ccswitch",
      providerName: "CCSwitch",
      protocol: "openai-responses" as const,
      model: "oc/deepseek-v4-flash-free",
    };
    vi.mocked(agentCompletion).mockResolvedValueOnce(toolResponse("submit_outline_plan", plan));

    await expect(createOutlinePlan({
      mode: "rewrite",
      instruction: "统一改写全文",
      markdown: "# 方案\n\n## 第一章 项目概述",
    }, deepSeekResponsesConfig)).resolves.toEqual(plan);

    expect(agentCompletion).toHaveBeenCalledTimes(1);
    expect(vi.mocked(agentCompletion).mock.calls[0][0]).toEqual(expect.objectContaining({
      tool_choice: "auto",
      tools: [expect.objectContaining({
        function: expect.objectContaining({ name: "submit_outline_plan" }),
      })],
    }));
  });

  it("does not retry unrelated model errors with auto tool_choice", async () => {
    vi.mocked(agentCompletion).mockRejectedValueOnce(new Error("模型服务返回 400：请求参数无效"));

    await expect(createOutlinePlan({
      mode: "rewrite",
      instruction: "统一改写全文",
      markdown: "# 方案",
    }, config)).rejects.toThrow("请求参数无效");

    expect(agentCompletion).toHaveBeenCalledTimes(1);
  });


  it("retries transient gateway send failures with bounded backoff", async () => {
    vi.useFakeTimers();
    const deepSeekResponsesConfig = {
      ...config,
      providerId: "ccswitch",
      providerName: "CCSwitch",
      protocol: "openai-responses" as const,
      model: "oc/deepseek-v4-flash-free",
    };
    vi.mocked(agentCompletion)
      .mockRejectedValueOnce(new Error("模型服务请求失败：error sending request for url (http://192.168.1.100:8317/v1/responses)"))
      .mockResolvedValueOnce(toolResponse("submit_chapter_summary", chapterSummary));

    const assertion = expect(createChapterSummary({
      chapterId: "chapter-1",
      titlePath: ["第一章 项目概述"],
      markdown: "## 第一章 项目概述\n\n正文。",
      documentTitle: "技术方案",
      instruction: "统一改写全文",
    }, deepSeekResponsesConfig)).resolves.toEqual(chapterSummary);
    await vi.runAllTimersAsync();
    await assertion;

    expect(agentCompletion).toHaveBeenCalledTimes(2);
    for (const [request] of vi.mocked(agentCompletion).mock.calls) {
      expect(request).toEqual(expect.objectContaining({
        tool_choice: "auto",
        tools: [expect.objectContaining({
          function: expect.objectContaining({ name: "submit_chapter_summary" }),
        })],
      }));
    }
  });

  it("stops after three transient transport attempts", async () => {
    vi.useFakeTimers();
    vi.mocked(agentCompletion).mockRejectedValue(
      new Error("模型服务请求失败：connection reset by peer"),
    );

    const assertion = expect(createOutlinePlan({
      mode: "rewrite",
      instruction: "统一改写全文",
      markdown: "# 方案",
    }, config)).rejects.toThrow("connection reset by peer");
    await vi.runAllTimersAsync();
    await assertion;

    expect(agentCompletion).toHaveBeenCalledTimes(3);
  });

  it("accepts a strict JSON content response when a gateway ignores tool calls", async () => {
    vi.mocked(agentCompletion).mockResolvedValue({
      choices: [{ message: { role: "assistant", content: JSON.stringify(chapterSummary) } }],
    });

    await expect(createChapterSummary({
      chapterId: "chapter-1",
      titlePath: ["第一章 项目概述"],
      markdown: "## 第一章 项目概述\n\n正文。",
      documentTitle: "技术方案",
      instruction: "统一改写全文",
    }, config)).resolves.toEqual(chapterSummary);
  });

  it("builds a deterministic local summary for a failed chapter worker", () => {
    expect(createLocalChapterSummary({
      chapterId: "chapter-1",
      titlePath: ["第一章 项目概述"],
      markdown: "## 第一章 项目概述\n\n建设统一平台。\n\n- 部署在内网\n- 支持审计",
    })).toEqual({
      chapterId: "chapter-1",
      titlePath: ["第一章 项目概述"],
      summary: "建设统一平台。 部署在内网 支持审计",
      facts: ["部署在内网", "支持审计"],
      terminology: [],
      unresolvedQuestions: [],
    });
  });

  it("forces isolated submit_chapter_summary for long-document preprocessing", async () => {
    vi.mocked(agentCompletion).mockResolvedValue(toolResponse("submit_chapter_summary", chapterSummary));
    const input: ChapterSummaryInput = {
      chapterId: "chapter-1",
      titlePath: ["第一章 项目概述"],
      markdown: "## 第一章 项目概述\n\n正文。",
      documentTitle: "技术方案",
      instruction: "统一改写全文",
    };

    await expect(createChapterSummary(input, config)).resolves.toEqual(chapterSummary);
    expectForcedOnly("submit_chapter_summary");
    expect((lastPayload().tools as unknown[])).toHaveLength(1);
  });

  it("forces submit_chapter_draft without exposing any other tools", async () => {
    vi.mocked(agentCompletion).mockResolvedValue(toolResponse("submit_chapter_draft", draft));
    const input: ChapterDraftInput = {
      chapterId: "chapter-1",
      titlePath: ["第一章 项目概述"],
      originalMarkdown: "## 第一章 项目概述\n\n### 1.1 建设背景",
      chapterGoal: "说明建设背景和目标",
      outlinePlan: plan as ChapterDraftInput["outlinePlan"],
    };

    await expect(createChapterDraft(input, config)).resolves.toEqual(draft);

    expectForcedOnly("submit_chapter_draft");
    const payload = lastPayload();
    expect((payload.tools as unknown[])).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain("replace_section");
    expect(JSON.stringify(payload)).not.toContain("write_text_file");
  });

  it("forces submit_consistency_report and returns only the issue list", async () => {
    vi.mocked(agentCompletion).mockResolvedValue(toolResponse("submit_consistency_report", { issues }));
    const input: ConsistencyCheckInput = {
      outlinePlan: plan as ConsistencyCheckInput["outlinePlan"],
      markdown: "# 方案\n\n## 第一章 项目概述\n\n正文。",
    };

    await expect(createConsistencyReport(input, config)).resolves.toEqual(issues);
    expectForcedOnly("submit_consistency_report");
  });

  it("rejects non-JSON plain text instead of using it as a fallback", async () => {
    vi.mocked(agentCompletion).mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "我已经完成了目录规划。" } }],
    });

    await expect(createOutlinePlan({
      mode: "fill",
      instruction: "补写",
      markdown: "# 方案",
    }, config)).rejects.toThrow("无效 JSON");
  });

  it("accepts strict JSON content for outline planning when the gateway omits tool_calls", async () => {
    vi.mocked(agentCompletion).mockResolvedValue({
      choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }],
    });

    await expect(createOutlinePlan({
      mode: "rewrite",
      instruction: "统一改写全文",
      markdown: "# 方案\n\n## 第一章 项目概述\n\n正文。",
    }, config)).resolves.toEqual(plan);
  });

  it("asks the isolated worker to correct invalid function argument JSON once", async () => {
    vi.mocked(agentCompletion)
      .mockResolvedValueOnce(rawToolResponse("submit_chapter_summary", "{invalid"))
      .mockResolvedValueOnce(toolResponse("submit_chapter_summary", chapterSummary));
    const input: ChapterSummaryInput = {
      chapterId: "chapter-1",
      titlePath: ["第一章 项目概述"],
      markdown: "## 第一章 项目概述\n\n正文。",
      documentTitle: "技术方案",
      instruction: "统一改写全文",
    };

    await expect(createChapterSummary(input, config)).resolves.toEqual(chapterSummary);

    expect(agentCompletion).toHaveBeenCalledTimes(2);
    const retryPayload = vi.mocked(agentCompletion).mock.calls[1][0] as Record<string, unknown>;
    expect(retryPayload.tool_choice).toEqual({
      type: "function",
      function: { name: "submit_chapter_summary" },
    });
    expect(retryPayload.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: "submit_chapter_summary" }),
      }),
    ]);
    const retryMessages = retryPayload.messages as Array<{ role: string; content: string }>;
    expect(retryMessages.at(-1)).toEqual(expect.objectContaining({
      role: "user",
      content: expect.stringContaining("严格合法的 JSON"),
    }));
    expect(retryMessages.at(-1)?.content).toContain("无效 JSON");
    expect(JSON.stringify(retryPayload)).not.toContain("write_text_file");
    expect(JSON.stringify(retryPayload)).not.toContain("replace_section");
  });

  it("fails explicitly after two invalid structured outputs", async () => {
    vi.mocked(agentCompletion)
      .mockResolvedValueOnce(rawToolResponse("submit_chapter_draft", "{invalid"))
      .mockResolvedValueOnce(rawToolResponse("submit_chapter_draft", "{still-invalid"));

    const input: ChapterDraftInput = {
      chapterId: "chapter-1",
      titlePath: ["第一章 项目概述"],
      originalMarkdown: "## 第一章 项目概述",
      chapterGoal: "补写",
      outlinePlan: plan as ChapterDraftInput["outlinePlan"],
    };
    await expect(createChapterDraft(input, config)).rejects.toThrow("连续两次结构化输出无效");
    expect(agentCompletion).toHaveBeenCalledTimes(2);
  });

  it("also retries schema validation failures once", async () => {
    const missingFacts = { ...chapterSummary } as Record<string, unknown>;
    delete missingFacts.facts;
    vi.mocked(agentCompletion)
      .mockResolvedValueOnce(toolResponse("submit_chapter_summary", missingFacts))
      .mockResolvedValueOnce(toolResponse("submit_chapter_summary", chapterSummary));

    await expect(createChapterSummary({
      chapterId: "chapter-1",
      titlePath: ["第一章 项目概述"],
      markdown: "## 第一章 项目概述\n\n正文。",
      documentTitle: "技术方案",
      instruction: "统一改写全文",
    }, config)).resolves.toEqual(chapterSummary);

    expect(agentCompletion).toHaveBeenCalledTimes(2);
    const retryPayload = vi.mocked(agentCompletion).mock.calls[1][0] as Record<string, unknown>;
    const retryMessages = retryPayload.messages as Array<{ role: string; content: string }>;
    expect(retryMessages.at(-1)?.content).toContain("facts");
  });

  it("rejects missing required fields and mismatched chapter ids", async () => {
    vi.mocked(agentCompletion).mockResolvedValueOnce(toolResponse("submit_outline_plan", {
      ...plan,
      targetChapterIds: undefined,
    }));
    await expect(createOutlinePlan({
      mode: "targeted",
      instruction: "修改受影响章节",
      markdown: "# 方案",
    }, config)).rejects.toThrow("targetChapterIds");

    vi.mocked(agentCompletion).mockResolvedValueOnce(toolResponse("submit_chapter_draft", {
      ...draft,
      chapterId: "chapter-other",
    }));
    await expect(createChapterDraft({
      chapterId: "chapter-1",
      titlePath: ["第一章 项目概述"],
      originalMarkdown: "## 第一章 项目概述",
      chapterGoal: "改写",
      outlinePlan: plan as ChapterDraftInput["outlinePlan"],
    }, config)).rejects.toThrow("chapterId 不匹配");
  });

  it("rejects a wrong or additional tool call", async () => {
    vi.mocked(agentCompletion).mockResolvedValueOnce(toolResponse("other_tool", plan));
    await expect(createOutlinePlan({
      mode: "fill",
      instruction: "补写",
      markdown: "# 方案",
    }, config)).rejects.toThrow("错误工具");

    const response = toolResponse("submit_outline_plan", plan);
    response.choices[0].message.tool_calls.push({
      id: "call-2",
      type: "function",
      function: { name: "submit_outline_plan", arguments: JSON.stringify(plan) },
    });
    vi.mocked(agentCompletion).mockResolvedValueOnce(response);
    await expect(createOutlinePlan({
      mode: "fill",
      instruction: "补写",
      markdown: "# 方案",
    }, config)).rejects.toThrow("只调用 submit_outline_plan");
  });
});
