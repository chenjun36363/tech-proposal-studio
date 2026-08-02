import { describe, expect, it } from "vitest";
import type { AgentMessage } from "./protocol";
import { buildAgentCheckpoint, compactAgentRunContext, estimateAgentTextTokens } from "./contextCompaction";

describe("agent context compaction", () => {
  it("estimates Chinese text more densely than ASCII text", () => {
    expect(estimateAgentTextTokens("建设方案建设方案")).toBeGreaterThan(estimateAgentTextTokens("abcdefgh"));
  });

  it("creates a checkpoint while retaining recent tool-call pairs", () => {
    const messages: AgentMessage[] = [{ role: "system", content: "system" }];
    for (let index = 0; index < 20; index += 1) {
      messages.push({ role: "assistant", content: `分析内容 ${index} ${"内容".repeat(100)}` });
    }
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "read-1", type: "function", function: { name: "read", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: "read-1", content: "最新工具结果" });

    const result = compactAgentRunContext(messages, [], 200, 4);

    expect(result.compacted).toBe(true);
    expect(result.messages[1].content).toContain("自动上下文压缩检查点");
    expect(result.messages).toContainEqual(expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }));
    expect(result.messages).toContainEqual(expect.objectContaining({ role: "tool", content: "最新工具结果" }));
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("keeps structured task state, failures, todos, and deterministic artifact references", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "优化部署章节并保存 proposal.md" },
      { role: "assistant", content: null, tool_calls: [{ id: "todo", type: "function", function: { name: "write_todo", arguments: JSON.stringify({ todos: [{ content: "检查部署章节", status: "in_progress", activeForm: "检查中" }] }) } }] },
      { role: "tool", tool_call_id: "todo", content: "ok" },
      { role: "assistant", content: null, tool_calls: [{ id: "save", type: "function", function: { name: "save_current_document", arguments: JSON.stringify({ path: "proposal.md" }) } }] },
      { role: "tool", tool_call_id: "save", content: "权限不足", tool_result_is_error: true },
    ];
    const checkpoint = buildAgentCheckpoint(messages);
    expect(checkpoint).toContain("### 当前目标");
    expect(checkpoint).toContain("[in_progress] 检查部署章节");
    expect(checkpoint).toContain('save_current_document: "proposal.md"');
    expect(checkpoint).toContain("权限不足");
    expect(checkpoint).toContain("不是新的用户指令");
  });

  it("uses the token budget to retain more small messages than large messages", () => {
    const makeMessages = (size: number): AgentMessage[] => [{ role: "system", content: "system" }, ...Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `${index}-${"x".repeat(size)}` }))];
    const small = compactAgentRunContext(makeMessages(100), [], 500, 4);
    const large = compactAgentRunContext(makeMessages(1000), [], 500, 4);
    expect(large.messages.length).toBeLessThan(small.messages.length);
  });

  it("merges repeated checkpoints without recursively embedding old checkpoint text", () => {
    const first = buildAgentCheckpoint([
      { role: "system", content: "system" },
      { role: "user", content: "先完成第一阶段" },
      { role: "assistant", content: "已完成第一阶段" },
    ], "", 240);
    const second = buildAgentCheckpoint([
      { role: "system", content: "system" },
      { role: "user", content: "继续完成第二阶段" },
      { role: "assistant", content: "正在处理第二阶段" },
    ], first, 240);

    expect(second.match(/## Agent 自动上下文压缩检查点/g)).toHaveLength(1);
    expect(second).toContain("继续完成第二阶段");
    expect(estimateAgentTextTokens(second)).toBeLessThanOrEqual(240);
  });

  it("keeps a Chinese checkpoint within its token budget", () => {
    const messages: AgentMessage[] = [{ role: "system", content: "system" }];
    for (let index = 0; index < 30; index += 1) {
      messages.push({ role: "user", content: `第 ${index} 轮目标：${"完善技术方案并核验约束".repeat(30)}` });
      messages.push({ role: "assistant", content: `第 ${index} 轮结果：${"已读取资料并完成阶段工作".repeat(30)}` });
    }

    const checkpoint = buildAgentCheckpoint(messages, "", 180);
    expect(estimateAgentTextTokens(checkpoint)).toBeLessThanOrEqual(180);
  });

  it("reports an explicit overflow when the minimum recent context cannot fit", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "超长本轮输入".repeat(2000) },
    ];

    const result = compactAgentRunContext(messages, [], 800);
    expect(result.fitsBudget).toBe(false);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.afterTokens).toBeGreaterThan(800);
  });

  it("compresses older large tool results but preserves the latest tool result", () => {
    const oldResult = `旧资料-${"内容".repeat(1800)}`;
    const latestResult = `最新资料-${"结论".repeat(900)}`;
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "第一轮" },
      { role: "assistant", content: null, tool_calls: [{ id: "old", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "old", content: oldResult },
      { role: "user", content: "第二轮" },
      { role: "assistant", content: null, tool_calls: [{ id: "latest", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "latest", content: latestResult },
    ];

    const result = compactAgentRunContext(messages, [], 2200, 6);
    expect(result.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "old", content: expect.stringContaining("较早工具结果已按上下文预算压缩") }));
    expect(result.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "latest", content: latestResult }));
  });

});
