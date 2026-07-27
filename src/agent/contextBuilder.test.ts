// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { buildProposalAgentMessages } from "./contextBuilder";
import { createAgentConversation } from "./conversationStore";

describe("buildProposalAgentMessages", () => {
  beforeEach(() => localStorage.clear());

  it("injects pinned sources and project memory deterministically", () => {
    const conversation = createAgentConversation("project-1");
    conversation.messages = [{ role: "user", content: "继续上一轮" }];
    const messages = buildProposalAgentMessages({
      systemPrompt: "system",
      conversation,
      pinnedContext: [{
        source: { id: "source-1", kind: "manual", title: "验收要求", location: "manual", excerpt: "", fingerprint: "f", accessedAt: "now" },
        content: "所有接口必须提供审计日志。",
      }],
      memories: [{ id: "m1", memoryType: "decision", title: "部署目标", content: "部署目标是 Windows Server 2022", confidence: "confirmed", status: "active", createdAt: 1, updatedAt: 1 }],
    });

    expect(messages[0].content).toContain("部署目标 [m1 | decision]");
    expect(messages[0].content).not.toContain("Windows Server 2022");
    expect(messages[0].content).toContain("所有接口必须提供审计日志");
    expect(messages[1]).toEqual({ role: "user", content: "继续上一轮" });
  });

  it("can exclude memory and cap explicitly pinned context", () => {
    const conversation = createAgentConversation("project-2");
    const messages = buildProposalAgentMessages({
      systemPrompt: "system",
      conversation,
      pinnedContext: [{ source: { id: "s", kind: "manual", title: "长资料", location: "manual", excerpt: "", fingerprint: "f", accessedAt: "now" }, content: "A".repeat(3000) }],
      pinnedContextChars: 2000,
      memoryEnabled: false,
      memories: [{ id: "m2", memoryType: "fact", title: "不应注入的记忆", content: "内容", confidence: "confirmed", status: "active", createdAt: 1, updatedAt: 1 }],
    });
    expect(messages[0].content).not.toContain("不应注入的记忆");
    expect((String(messages[0].content ?? "").match(/A/g) ?? [])).toHaveLength(2000);
  });
});
