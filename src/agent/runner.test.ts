import { beforeEach, describe, expect, it, vi } from "vitest";
import { runProposalAgent } from "./runner";
import { AgentToolRegistry, objectSchema } from "./toolRegistry";
import type { AgentEvent, AgentMessage } from "./protocol";

const agentCompletion = vi.fn();
vi.mock("../services/model", () => ({ agentCompletion: (...args: unknown[]) => agentCompletion(...args) }));

const config = { baseUrl: "http://localhost:1234/v1", apiKey: "", model: "test-model", timeoutMs: 1000, headers: {}, enabled: true };

describe("runProposalAgent", () => {
  beforeEach(() => agentCompletion.mockReset());

  it("feeds tool results into the next model round", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{\"path\":\"proposal.md\"}" } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "任务完成" } }] });
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({ path: { type: "string" } }, ["path"]) } },
      execute: () => ({ content: "章节正文", data: { blockId: "section-1" }, isError: false }),
    });
    const events: AgentEvent[] = [];
    const result = await runProposalAgent({ task: "检查方案", messages: [{ role: "system", content: "system" }, { role: "user", content: "上一轮" }, { role: "assistant", content: "上一轮回复" }], config, registry, signal: new AbortController().signal, onEvent: event => events.push(event), temperature: 0.7 });

    expect(agentCompletion).toHaveBeenCalledTimes(2);
    const secondPayload = agentCompletion.mock.calls[1][0] as { messages: Array<{ role: string; content: string }> };
    expect(secondPayload.messages).toContainEqual(expect.objectContaining({ role: "tool", content: "章节正文" }));
    expect(secondPayload.messages).not.toContainEqual(expect.objectContaining({ tool_result_data: expect.anything() }));
    expect(result.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_result_data: { blockId: "section-1" }, tool_result_is_error: false }));
    expect(events.some(event => event.type === "tool_result")).toBe(true);
    expect(secondPayload.messages).toContainEqual(expect.objectContaining({ role: "user", content: "上一轮" }));
    expect(events.at(-1)?.type).toBe("run_completed");
    expect(agentCompletion.mock.calls[0][0]).toEqual(expect.objectContaining({ temperature: 0.7 }));
  });

  it("forces the configured planning tool in the first model round, then returns to auto", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "plan-1", type: "function", function: { name: "write_todo", arguments: '{"todos":[{"content":"搜索资料","status":"in_progress"}]}' } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "完成" } }] });
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "write_todo", description: "plan", parameters: objectSchema({ todos: { type: "array" } }) } },
      execute: () => ({ content: "计划已更新", isError: false }),
    });

    await runProposalAgent({ task: "联网搜索", config, registry, signal: new AbortController().signal, onEvent: () => undefined, firstRoundToolName: "write_todo" });

    expect(agentCompletion).toHaveBeenCalledTimes(2);
    expect(agentCompletion.mock.calls[0][0]).toEqual(expect.objectContaining({
      tool_choice: { type: "function", function: { name: "write_todo" } },
      tools: [expect.objectContaining({ function: expect.objectContaining({ name: "write_todo" }) })],
    }));
    expect(agentCompletion.mock.calls[1][0]).toEqual(expect.objectContaining({ tool_choice: "auto" }));
  });

  it("falls back to auto when a gateway rejects forced tool choice", async () => {
    agentCompletion
      .mockRejectedValueOnce(new Error("模型服务返回 429：Upstream request failed: [invalid_request_error] Failed to deserialize the JSON body into the target type: tool_choice: field 'function': invalid type: null, expected struct ToolChoiceFunction (free model rate limit)"))
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "plan-fallback", type: "function", function: { name: "write_todo", arguments: '{"todos":[]}' } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "完成" } }] });
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "write_todo", description: "plan", parameters: objectSchema({ todos: { type: "array" } }) } },
      execute: () => ({ content: "计划已更新", isError: false }),
    });

    await runProposalAgent({ task: "完成任务", config, registry, signal: new AbortController().signal, onEvent: () => undefined, firstRoundToolName: "write_todo" });

    expect(agentCompletion).toHaveBeenCalledTimes(3);
    expect(agentCompletion.mock.calls[0][0]).toEqual(expect.objectContaining({
      tool_choice: { type: "function", function: { name: "write_todo" } },
    }));
    expect(agentCompletion.mock.calls[1][0]).toEqual(expect.objectContaining({
      tool_choice: "auto",
      tools: [expect.objectContaining({ function: expect.objectContaining({ name: "write_todo" }) })],
    }));
  });

  it("retries planning when the model returns text before the required first tool", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "我先分析任务" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "plan-2", type: "function", function: { name: "write_todo", arguments: '{"todos":[]}' } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "完成" } }] });
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "write_todo", description: "plan", parameters: objectSchema({ todos: { type: "array" } }) } },
      execute: () => ({ content: "计划已更新", isError: false }),
    });

    await runProposalAgent({ task: "完成任务", config, registry, signal: new AbortController().signal, onEvent: () => undefined, firstRoundToolName: "write_todo" });

    expect(agentCompletion).toHaveBeenCalledTimes(3);
    expect(agentCompletion.mock.calls[1][0]).toEqual(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({ role: "user", content: expect.stringContaining("必须先调用 write_todo") })]),
    }));
  });

  it("persists a completed todo snapshot before finishing", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "plan-3", type: "function", function: { name: "write_todo", arguments: JSON.stringify({ todos: [
        { content: "读取章节", status: "in_progress", activeForm: "正在读取章节" },
        { content: "提交修改", status: "pending", activeForm: "正在提交修改" },
      ] }) } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "任务完成" } }] });
    const execute = vi.fn(args => ({ content: "计划已更新", data: args.todos, isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "write_todo", description: "plan", parameters: objectSchema({ todos: { type: "array" } }) } },
      execute,
    });
    const events: AgentEvent[] = [];

    const result = await runProposalAgent({ task: "优化章节", config, registry, signal: new AbortController().signal, onEvent: event => events.push(event), firstRoundToolName: "write_todo" });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0]).toEqual({ todos: [
      { content: "读取章节", status: "completed", activeForm: "正在读取章节" },
      { content: "提交修改", status: "completed", activeForm: "正在提交修改" },
    ] });
    expect(result.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_result_data: expect.arrayContaining([expect.objectContaining({ status: "completed" })]) }));
    expect(events.filter(event => event.type === "tool_result")).toHaveLength(2);
  });

  it("continues tool execution until the model finishes", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-2", type: "function", function: { name: "read", arguments: "{}" } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "已完成收尾" } }] });
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({}) } },
      execute: () => ({ content: "资料", isError: false }),
    });

    const result = await runProposalAgent({ task: "研究", config, registry, signal: new AbortController().signal, onEvent: () => undefined });

    expect(result.summary).toBe("已完成收尾");
    expect(agentCompletion).toHaveBeenCalledTimes(3);
  });

  it("executes DSML tool calls returned as assistant text", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: '<|DSML|tool_calls>\n<|DSML|invoke name="submit">\n<|DSML|parameter name="content" string="true">优化稿</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "已提交" } }] });
    const execute = vi.fn(() => ({ content: "待审批", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "submit", description: "submit", parameters: objectSchema({ content: { type: "string" } }, ["content"]) } },
      execute,
    });

    const result = await runProposalAgent({ task: "优化", config, registry, signal: new AbortController().signal, onEvent: () => undefined });

    expect(execute).toHaveBeenCalledWith({ content: "优化稿" }, expect.any(AbortSignal));
    expect(result.messages).toContainEqual(expect.objectContaining({ content: null, tool_calls: [expect.objectContaining({ function: expect.objectContaining({ name: "submit" }) })] }));
  });

  it("executes a DSML proposal after multiple tool rounds", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: '方案已整理。\n<|DSML|invoke name="submit"><|DSML|parameter name="content">最终稿</|DSML|parameter></|DSML|invoke>' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "修改稿已提交" } }] });
    const submit = vi.fn(() => ({ content: "待审批", isError: false }));
    const registry = new AgentToolRegistry()
      .register({ definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({}) } }, execute: () => ({ content: "原文", isError: false }) })
      .register({ definition: { type: "function", function: { name: "submit", description: "submit", parameters: objectSchema({ content: { type: "string" } }, ["content"]) } }, execute: submit });

    const result = await runProposalAgent({ task: "优化", config, registry, signal: new AbortController().signal, onEvent: () => undefined });

    expect(submit).toHaveBeenCalledWith({ content: "最终稿" }, expect.any(AbortSignal));
    expect(result.messages).not.toContainEqual(expect.objectContaining({ role: "user", content: expect.stringContaining("工具执行轮次已经用完") }));
  });

  it("compacts an oversized run context and continues", async () => {
    agentCompletion.mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "压缩后完成" } }] });
    const messages: AgentMessage[] = [{ role: "system", content: "system" }];
    for (let index = 0; index < 24; index += 1) messages.push({ role: "user", content: `历史消息 ${index} ${"内容".repeat(120)}` });
    const events: AgentEvent[] = [];

    const result = await runProposalAgent({ task: "继续任务", messages, config, registry: new AgentToolRegistry(), signal: new AbortController().signal, onEvent: event => events.push(event), contextCompressionTokens: 800 });

    expect(result.summary).toBe("压缩后完成");
    expect(events).toContainEqual(expect.objectContaining({ type: "context_compacted" }));
    const payload = agentCompletion.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(payload.messages.some(message => message.content?.includes("自动上下文压缩检查点"))).toBe(true);
  });

  it("fails before calling the model when the minimum recent context still exceeds the budget", async () => {
    const events: AgentEvent[] = [];

    await expect(runProposalAgent({
      task: "本轮超长输入".repeat(2000),
      config,
      registry: new AgentToolRegistry(),
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
      contextCompressionTokens: 800,
    })).rejects.toThrow("上下文压缩后仍超出预算");

    expect(agentCompletion).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "run_failed", error: expect.stringContaining("提高上下文压缩阈值") }));
  });

  it("does not execute or emit calls for unavailable tools", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "missing-1", type: "function", function: { name: "search_knowledge", arguments: "{}" } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "已改用可用信息完成任务" } }] });
    const events: AgentEvent[] = [];

    const result = await runProposalAgent({ task: "研究", config, registry: new AgentToolRegistry(), signal: new AbortController().signal, onEvent: event => events.push(event) });

    expect(events.some(event => event.type === "tool_call")).toBe(false);
    expect(result.messages).not.toContainEqual(expect.objectContaining({ tool_calls: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: "search_knowledge" }) })]) }));
    expect(agentCompletion.mock.calls[1][0]).toEqual(expect.objectContaining({ messages: expect.arrayContaining([expect.objectContaining({ role: "user", content: expect.stringMatching(/TOOL_ERROR.*UNKNOWN_TOOL[\s\S]*search_knowledge/) })]) }));
    expect(result.messages).not.toContainEqual(expect.objectContaining({ role: "user", content: expect.stringContaining("search_knowledge") }));
  });

  it("opens the unavailable-tool circuit breaker on a repeated call", async () => {
    agentCompletion.mockResolvedValue({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: crypto.randomUUID(), type: "function", function: { name: "missing_tool", arguments: "{}" } }] } }] });
    const events: AgentEvent[] = [];

    await expect(runProposalAgent({ task: "研究", config, registry: new AgentToolRegistry(), signal: new AbortController().signal, onEvent: event => events.push(event) }))
      .rejects.toThrow(/连续两次不可用/);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "run_failed", error: expect.stringContaining("UNKNOWN_TOOL") }));
  });

  it("supports a low-tool local transport budget and stops unavailable-tool retries", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "read-once", type: "function", function: { name: "read", arguments: "{}" } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "已完成" } }] });
    const execute = vi.fn(() => ({ content: "当前章节", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({}) } },
      execute,
    });

    const result = await runProposalAgent({
      task: "回答问题",
      config,
      registry,
      signal: new AbortController().signal,
      onEvent: () => undefined,
      maxToolCalls: 1,
      stopOnUnavailableTools: true,
    });

    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(agentCompletion).toHaveBeenCalledTimes(2);
    expect(agentCompletion.mock.calls[1][0]).toEqual(expect.objectContaining({ tools: [], tool_choice: "auto" }));
  });

  it("stops at the configured round limit and preserves incomplete todos", async () => {
    agentCompletion.mockResolvedValue({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: crypto.randomUUID(), type: "function", function: { name: "read", arguments: "{}" } }] } }] });
    const execute = vi.fn(() => ({ content: "继续", isError: false }));
    const registry = new AgentToolRegistry().register({ definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({}) } }, execute });
    const events: AgentEvent[] = [];

    const result = await runProposalAgent({ task: "持续读取", config, registry, signal: new AbortController().signal, onEvent: event => events.push(event), maxRounds: 2 });

    expect(result.status).toBe("round_limit_reached");
    expect(agentCompletion).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "round_limit_reached", maxRounds: 2 }));
  });

  it("returns completed messages when a run is cancelled", async () => {
    const controller = new AbortController();
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "read-before-stop", type: "function", function: { name: "read", arguments: "{}" } }] } }] })
      .mockImplementationOnce((_request, _config, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({}) } },
      execute: () => ({ content: "停止前已读取的资料", isError: false }),
    });
    const events: AgentEvent[] = [];
    const running = runProposalAgent({ task: "读取后继续分析", config, registry, signal: controller.signal, onEvent: event => events.push(event) });
    await vi.waitFor(() => expect(agentCompletion).toHaveBeenCalledTimes(2));

    controller.abort();
    const result = await running;

    expect(result.status).toBe("cancelled");
    expect(result.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "read-before-stop", content: "停止前已读取的资料" }));
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "run_cancelled" }));
  });

  it("returns malformed JSON arguments as a tool error without executing the tool", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "bad-json", type: "function", function: { name: "read", arguments: "{bad" } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "已修正" } }] });
    const execute = vi.fn(() => ({ content: "不应执行", isError: false }));
    const registry = new AgentToolRegistry().register({ definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({}) } }, execute });

    const result = await runProposalAgent({ task: "读取", config, registry, signal: new AbortController().signal, onEvent: () => undefined });

    expect(execute).not.toHaveBeenCalled();
    expect(result.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_result_is_error: true, content: expect.stringContaining("MALFORMED_ARGUMENTS") }));
  });

  it("lets the model repair one invalid parameter call without consuming the execution cap", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "bad", type: "function", function: { name: "read", arguments: "{}" } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "fixed", type: "function", function: { name: "read", arguments: '{"path":"proposal.md"}' } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "已完成" } }] });
    const execute = vi.fn(() => ({ content: "章节", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({ path: { type: "string" } }, ["path"]) } }, execute,
    });

    const result = await runProposalAgent({ task: "读取", config, registry, signal: new AbortController().signal, onEvent: () => undefined, maxToolCalls: 1 });

    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(agentCompletion).toHaveBeenCalledTimes(3);
    expect(result.messages).toContainEqual(expect.objectContaining({ role: "tool", content: expect.stringContaining("INVALID_ARGUMENTS") }));
  });

  it("opens the circuit breaker after the same parameter failure is repeated", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "bad-1", type: "function", function: { name: "read", arguments: "{}" } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "bad-2", type: "function", function: { name: "read", arguments: "{}" } }] } }] });
    const execute = vi.fn(() => ({ content: "不应执行", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({ path: { type: "string" } }, ["path"]) } }, execute,
    });

    await expect(runProposalAgent({ task: "读取", config, registry, signal: new AbortController().signal, onEvent: () => undefined })).rejects.toThrow("连续两次无效");
    expect(execute).not.toHaveBeenCalled();
    expect(agentCompletion).toHaveBeenCalledTimes(2);
  });

  it("keeps valid calls in a batch when a sibling call has invalid arguments", async () => {
    agentCompletion
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "bad", type: "function", function: { name: "read", arguments: "{}" } },
        { id: "good", type: "function", function: { name: "status", arguments: "{}" } },
      ] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "完成" } }] });
    const read = vi.fn(() => ({ content: "不应执行", isError: false }));
    const status = vi.fn(() => ({ content: "正常执行", isError: false }));
    const registry = new AgentToolRegistry()
      .register({ definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({ path: { type: "string" } }, ["path"]) } }, execute: read })
      .register({ definition: { type: "function", function: { name: "status", description: "status", parameters: objectSchema({}) } }, execute: status });

    const result = await runProposalAgent({ task: "批量", config, registry, signal: new AbortController().signal, onEvent: () => undefined });

    expect(result.status).toBe("completed");
    expect(read).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(1);
    expect(result.messages).toContainEqual(expect.objectContaining({ tool_call_id: "bad", content: expect.stringContaining("INVALID_ARGUMENTS") }));
    expect(result.messages).toContainEqual(expect.objectContaining({ tool_call_id: "good", content: "正常执行" }));
  });

});
