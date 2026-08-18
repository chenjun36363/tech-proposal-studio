import { beforeEach, describe, expect, it, vi } from "vitest";
import { runProposalAgent } from "./runner";
import { AgentToolRegistry, objectSchema } from "./toolRegistry";

const agentCompletion = vi.fn();
vi.mock("../services/model", () => ({
  agentCompletion: (...args: unknown[]) => agentCompletion(...args),
  agentCompletionStream: (payload: unknown, modelConfig: unknown, _onUpdate: unknown, signal: unknown) => agentCompletion(payload, modelConfig, signal),
}));

const config = { baseUrl: "http://localhost:1234/v1", apiKey: "", model: "tool-reliability-eval", timeoutMs: 1000, headers: {}, enabled: true };

type EvaluationCase = {
  name: string;
  label: string;
  properties: Record<string, unknown>;
  required?: string[];
  arguments: Record<string, unknown>;
};

/**
 * Deterministic mock-completion regression set. The names mirror all high-risk
 * tool families; concrete domain behavior stays covered in each tool module's tests.
 */
const evaluationCases: EvaluationCase[] = [
  { name: "propose_section_update", label: "方案编辑", properties: { section_id: { type: "string" }, markdown: { type: "string" } }, required: ["section_id", "markdown"], arguments: { section_id: "heading-1", markdown: "修订内容" } },
  { name: "search_knowledge", label: "知识库", properties: { query: { type: "string" } }, required: ["query"], arguments: { query: "验收标准" } },
  { name: "web_search", label: "联网", properties: { query: { type: "string" } }, required: ["query"], arguments: { query: "最新标准" } },
  { name: "read_memory", label: "记忆", properties: { memory_id: { type: "string" } }, required: ["memory_id"], arguments: { memory_id: "memory-1" } },
  { name: "open_workspace_document", label: "工作区", properties: { path: { type: "string" } }, required: ["path"], arguments: { path: "proposal.md" } },
  { name: "git_status", label: "Git", properties: {}, arguments: {} },
  { name: "skills_manager", label: "Skill", properties: { action: { type: "string", enum: ["list"] } }, required: ["action"], arguments: { action: "list" } },
];

function completionFor(name: string, argumentsValue: Record<string, unknown>) {
  return {
    choices: [{ message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(argumentsValue) } }],
    } }],
  };
}

function registryFor(testCase: EvaluationCase, execute = vi.fn(() => ({ content: "ok", isError: false }))) {
  const registry = new AgentToolRegistry().register({
    definition: { type: "function", function: { name: testCase.name, description: `${testCase.label} evaluation tool`, parameters: objectSchema(testCase.properties, testCase.required) } },
    execute,
  });
  return { registry, execute };
}

describe("tool reliability mock-completion evaluation", () => {
  beforeEach(() => agentCompletion.mockReset());

  it.each(evaluationCases)("$label 工具可完成标准调用", async (testCase) => {
    agentCompletion
      .mockResolvedValueOnce(completionFor(testCase.name, testCase.arguments))
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "已完成" } }] });
    const { registry, execute } = registryFor(testCase);

    const result = await runProposalAgent({ task: `评测${testCase.label}`, config, registry, signal: new AbortController().signal, onEvent: () => undefined });

    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledWith(testCase.arguments, expect.any(AbortSignal));
  });

  it.each(evaluationCases.filter(testCase => (testCase.required?.length ?? 0) > 0))("$label 工具在一次结构化纠错后恢复", async (testCase) => {
    agentCompletion
      .mockResolvedValueOnce(completionFor(testCase.name, { unexpected_field: true }))
      .mockResolvedValueOnce(completionFor(testCase.name, testCase.arguments))
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "已完成" } }] });
    const { registry, execute } = registryFor(testCase);

    const result = await runProposalAgent({ task: `纠错评测${testCase.label}`, config, registry, signal: new AbortController().signal, onEvent: () => undefined, maxToolCalls: 1 });

    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(agentCompletion.mock.calls[1][0].messages).toContainEqual(expect.objectContaining({
      role: "tool",
      content: expect.stringContaining("INVALID_ARGUMENTS"),
    }));
  });

  it("松散参数（未知字段、camelCase、字符串数字）一次调用即完成", async () => {
    agentCompletion
      .mockResolvedValueOnce(completionFor("search_knowledge", { query: "验收标准", limit: "3", caseSensitive: "false", note: "额外说明" }))
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "已完成" } }] });
    const execute = vi.fn(() => ({ content: "ok", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "search_knowledge", description: "知识库评测工具", parameters: objectSchema({
        query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 }, case_sensitive: { type: "boolean" },
      }, ["query"]) } },
      execute,
    });

    const result = await runProposalAgent({ task: "评测松散参数", config, registry, signal: new AbortController().signal, onEvent: () => undefined });

    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ query: "验收标准", limit: 3, case_sensitive: false }, expect.any(AbortSignal));
    expect(agentCompletion).toHaveBeenCalledTimes(2);
  });
});
