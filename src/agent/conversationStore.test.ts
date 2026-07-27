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
});
