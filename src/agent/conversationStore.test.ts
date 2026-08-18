// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { applyAgentConversationChange, clearAgentConversations, compactAgentConversation, compactAgentConversationToBudget, createAgentConversation, listAgentConversations, saveAgentConversation } from "./conversationStore";

describe("agent conversation storage", () => {
  beforeEach(() => localStorage.clear());

  it("persists conversations independently by project", async () => {
    await saveAgentConversation({ ...createAgentConversation("project-a"), title: "A" });
    await saveAgentConversation({ ...createAgentConversation("project-b"), title: "B" });
    expect((await listAgentConversations("project-a")).map(item => item.title)).toEqual(["A"]);
  });
  it("keeps the complete message timeline on ordinary saves", async () => {
    const conversation = createAgentConversation("project-a");
    conversation.messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? "assistant" as const : "user" as const,
      content: `message-${index}`,
    }));
    await saveAgentConversation(conversation);
    const [saved] = await listAgentConversations("project-a");
    expect(saved.messages).toHaveLength(30);
    expect(saved.summary).toBe("");
  });

  it("does not remove an explicitly saved empty conversation", async () => {
    await saveAgentConversation(createAgentConversation("project-a"));
    expect(await listAgentConversations("project-a")).toHaveLength(1);
  });

  it("starts new conversations with web search disabled", () => {
    const conversation = createAgentConversation("project-a");
    expect(conversation.webSearchEnabled).toBe(false);
    expect(conversation.knowledgeSearchEnabled).toBe(false);
    expect(conversation.memorySearchEnabled).toBe(false);
    expect(conversation.fullAccessEnabled).toBe(false);
    expect(conversation.fullAccessAcknowledged).toBe(false);
    expect(conversation.mode).toBe("build");
  });
  it("applies conversation changes without reloading storage", () => {
    const first = createAgentConversation("project-a");
    const second = { ...createAgentConversation("project-a"), updatedAt: first.updatedAt + 1 };
    const other = createAgentConversation("project-b");
    other.updatedAt = first.updatedAt - 1;
    const saved = applyAgentConversationChange([first, other], { projectId: "project-a", type: "saved", conversation: second });
    expect(saved.map(item => item.id)).toEqual([second.id, first.id, other.id]);
    const deleted = applyAgentConversationChange(saved, { projectId: "project-a", type: "deleted", conversationId: first.id });
    expect(deleted.map(item => item.id)).toEqual([second.id, other.id]);
    expect(applyAgentConversationChange(deleted, { projectId: "project-a", type: "cleared" })).toEqual([other]);
  });

  it("compacts old messages into a bounded summary", () => {
    const conversation = createAgentConversation("project-a");
    conversation.messages = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `message-${index}` }));
    const compacted = compactAgentConversation(conversation);
    expect(compacted.messages).toHaveLength(20);
    expect(compacted.summary).toContain("自动上下文压缩检查点");
    expect(compacted.summary).toContain("message-0");
    expect(compacted.summary).not.toContain("message-29");
  });

  it("budget-aware compact shrinks kept messages until under threshold", () => {
    const conversation = createAgentConversation("project-a");
    // 制造大量消息，使消息正文本身就超过阈值。
    conversation.messages = Array.from({ length: 60 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `long-content-${index}-`.padEnd(400, "x") }));
    const threshold = 4000;
    const overhead = 0;
    const compacted = compactAgentConversationToBudget(conversation, { keepRecent: 20, thresholdTokens: threshold, fixedOverheadTokens: overhead });

    // 默认 keepRecent 下仍超阈值 → 应自动减少保留条数（低于 20）。
    expect(compacted.messages.length).toBeLessThan(20);
    expect(compacted.summary).toContain("自动上下文压缩检查点");

    // 估算总上下文需落入阈值：固定开销 + 摘要 + 保留消息。
    const total = overhead
      + JSON.stringify(compacted.messages).length / 4
      + compacted.summary.length / 4;
    expect(total).toBeLessThanOrEqual(threshold);
  });

  it("budget-aware compact keeps recent messages when already under threshold", () => {
    const conversation = createAgentConversation("project-a");
    conversation.messages = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `message-${index}` }));
    const compacted = compactAgentConversationToBudget(conversation, { keepRecent: 20, thresholdTokens: 1_000_000, fixedOverheadTokens: 0 });
    expect(compacted.messages).toHaveLength(20);
    expect(compacted.summary).toContain("message-0");
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

  it("never persists transient coaching messages", async () => {
    const conversation = createAgentConversation("project-a");
    conversation.messages = [{ role: "user", content: "真实任务" }, { role: "user", content: "内部提示", transient: true }];
    await saveAgentConversation(conversation);
    expect((await listAgentConversations("project-a"))[0].messages).toEqual([{ role: "user", content: "真实任务" }]);
  });

  it("redacts sensitive tool output while retaining audit metadata", async () => {
    const conversation = createAgentConversation("project-a");
    conversation.messages = [{ role: "tool", tool_call_id: "tool-1", content: "secret output", tool_result_data: { sensitive: true, persistedSummary: "[PowerShell] exit 0", logPath: "C:\\logs\\1.log" } }];
    await saveAgentConversation(conversation);
    const [saved] = await listAgentConversations("project-a");
    expect(saved.messages[0]).toEqual(expect.objectContaining({ content: "[PowerShell] exit 0", tool_result_data: { logPath: "C:\\logs\\1.log" } }));
  });

  it("clears only the selected project's history", async () => {
    await saveAgentConversation({ ...createAgentConversation("project-a"), title: "A" });
    await saveAgentConversation({ ...createAgentConversation("project-b"), title: "B" });
    expect(await clearAgentConversations("project-a")).toBe(1);
    expect(await listAgentConversations("project-a")).toEqual([]);
    expect((await listAgentConversations("project-b")).map(item => item.title)).toEqual(["B"]);
  });
});
