// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { compactAgentConversation, createAgentConversation, listAgentConversations, saveAgentConversation } from "./conversationStore";

describe("agent conversation storage", () => {
  beforeEach(() => localStorage.clear());

  it("persists conversations independently by project", () => {
    saveAgentConversation({ ...createAgentConversation("project-a"), title: "A" });
    saveAgentConversation({ ...createAgentConversation("project-b"), title: "B" });
    expect(listAgentConversations("project-a").map(item => item.title)).toEqual(["A"]);
  });

  it("starts new conversations with web search disabled", () => {
    const conversation = createAgentConversation("project-a");
    expect(conversation.webSearchEnabled).toBe(false);
    expect(conversation.knowledgeSearchEnabled).toBe(true);
  });

  it("compacts old messages into a bounded summary", () => {
    const conversation = createAgentConversation("project-a");
    conversation.messages = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `message-${index}` }));
    const compacted = compactAgentConversation(conversation);
    expect(compacted.messages).toHaveLength(20);
    expect(compacted.summary).toContain("message-0");
    expect(compacted.summary).not.toContain("message-29");
  });

  it("keeps complete tool chains and summarizes tool evidence", () => {
    const conversation = createAgentConversation("project-a");
    conversation.messages = [];
    for (let index = 0; index < 8; index += 1) {
      conversation.messages.push({ role: "user", content: `task-${index}` });
      conversation.messages.push({ role: "assistant", content: null, tool_calls: [{ id: `call-${index}`, type: "function", function: { name: "read", arguments: JSON.stringify({ index }) } }] });
      conversation.messages.push({ role: "tool", tool_call_id: `call-${index}`, content: `result-${index}`, tool_result_is_error: index === 0 });
    }
    const compacted = compactAgentConversation(conversation, 8);

    expect(compacted.messages[0].role).toBe("user");
    expect(compacted.summary).toContain("read(");
    expect(compacted.summary).toContain("工具结果[失败]");
    const callIds = new Set(compacted.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
    expect(compacted.messages.filter(message => message.role === "tool").every(message => Boolean(message.tool_call_id && callIds.has(message.tool_call_id)))).toBe(true);
  });

  it("never persists transient coaching messages", () => {
    const conversation = createAgentConversation("project-a");
    conversation.messages = [{ role: "user", content: "真实任务" }, { role: "user", content: "内部提示", transient: true }];
    saveAgentConversation(conversation);
    expect(listAgentConversations("project-a")[0].messages).toEqual([{ role: "user", content: "真实任务" }]);
  });
});
