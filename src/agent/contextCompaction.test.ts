import { describe, expect, it } from "vitest";
import type { AgentMessage } from "./protocol";
import { compactAgentRunContext, estimateAgentTextTokens } from "./contextCompaction";

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
});
