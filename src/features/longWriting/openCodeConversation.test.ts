import { describe, expect, it } from "vitest";
import { normalizeOpenCodeConversation } from "./openCodeConversation";

describe("normalizeOpenCodeConversation", () => {
  it("normalizes visible prompts, replies, tools and results", () => {
    const messages = normalizeOpenCodeConversation([
      {
        info: {
          id: "user-1",
          role: "user",
          system: "只读取目标章节",
          time: { created: 1_700_000_000_000 },
        },
        parts: [{ id: "text-1", type: "text", text: "请优化部署章节" }],
      },
      {
        info: { id: "assistant-1", role: "assistant", modelID: "gpt-5", time: { created: 1_700_000_001_000 } },
        parts: [
          { id: "text-2", type: "text", text: "我先读取文件。" },
          { id: "tool-1", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "proposal.md" }, output: "正文" } },
        ],
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", system: "只读取目标章节" });
    expect(messages[0].parts.map(part => part.text)).toContain("请优化部署章节");
    expect(messages[1].parts[1]).toMatchObject({
      kind: "tool",
      tool: "read",
      status: "completed",
      input: { filePath: "proposal.md" },
      output: "正文",
    });
  });

  it("degrades unknown parts and errors without dropping the message", () => {
    const messages = normalizeOpenCodeConversation({
      messages: [{
        id: "assistant-2",
        role: "assistant",
        error: { message: "模型失败" },
        parts: [{ id: "part-x", type: "future-part", content: "可见内容" }],
      }],
    });

    expect(messages[0].error).toBe("模型失败");
    expect(messages[0].parts[0]).toMatchObject({ kind: "unknown", rawType: "future-part", text: "可见内容" });
  });

  it("never exposes reasoning part text", () => {
    const messages = normalizeOpenCodeConversation([{
      id: "assistant-3",
      role: "assistant",
      parts: [{ id: "reasoning-1", type: "reasoning", text: "隐藏推理内容" }],
    }]);

    expect(messages[0].parts[0]).toEqual({ id: "reasoning-1", kind: "unknown", rawType: "reasoning" });
  });
});
