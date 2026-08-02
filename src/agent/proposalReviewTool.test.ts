import { describe, expect, it, vi } from "vitest";
import { createProject } from "../core/data";
import type { DocumentBlock, ResolvedModelConfig } from "../core/types";
import { reviewContent } from "./contentReview";
import { createProposalToolRegistry } from "./proposalTools";

vi.mock("./contentReview", () => ({
  reviewContent: vi.fn(),
  formatContentReview: vi.fn(() => "审核结论：通过"),
}));

const block: DocumentBlock = {
  id: "block-review",
  sectionId: "markdown",
  type: "text",
  content: "",
  order: 0,
  status: "draft",
  sourceRefs: [],
};

const modelConfig: ResolvedModelConfig = {
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

describe("proposal review_content tool", () => {
  it("registers with a resolved model and reviews the current document without editing it", async () => {
    vi.mocked(reviewContent).mockResolvedValue({
      overallStatus: "pass",
      summary: "满足要求。",
      checks: [{ requirementIndex: 1, requirement: "包含部署方案", status: "pass", evidence: "部署方案", explanation: "存在对应章节。", suggestion: "" }],
      passedCount: 1,
      failedCount: 0,
      uncertainCount: 0,
    });
    const project = createProject();
    project.markdown = `# 方案

## 部署方案

采用离线部署。`;
    const tools = createProposalToolRegistry({
      project,
      modelConfig,
      block,
      reviewDraft: () => true,
      onTodos: () => undefined,
    });

    const result = await tools.execute({
      id: "review-1",
      name: "review_content",
      arguments: { scope: "document", requirements: ["包含部署方案"] },
    }, new AbortController().signal);

    expect(result.isError).toBe(false);
    expect(result.content).toBe("审核结论：通过");
    expect(reviewContent).toHaveBeenCalledWith({
      content: project.markdown,
      requirements: ["包含部署方案"],
      scopeLabel: "当前方案全文",
    }, modelConfig, expect.any(AbortSignal));
    expect(project.markdown).toContain("采用离线部署");
  });

  it("is unavailable when no resolved model config is provided", () => {
    const tools = createProposalToolRegistry({
      project: createProject(),
      block,
      reviewDraft: () => true,
      onTodos: () => undefined,
    });
    expect(tools.has("review_content")).toBe(false);
  });
});
