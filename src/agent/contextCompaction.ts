import type { AgentMessage, AgentToolDefinition } from "./protocol";

const MESSAGE_OVERHEAD_TOKENS = 8;
const CHECKPOINT_PREFIX = "## Agent 自动上下文压缩检查点";

export function estimateAgentTextTokens(text: string): number {
  let cjk = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) cjk += 1;
  }
  return Math.ceil(cjk * 0.7 + (text.length - cjk) / 4);
}

function messageTokens(message: AgentMessage): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateAgentTextTokens(JSON.stringify(message));
}

export function estimateAgentContextTokens(messages: AgentMessage[], tools: AgentToolDefinition[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0) + estimateAgentTextTokens(JSON.stringify(tools));
}

function summaryLine(message: AgentMessage): string {
  const content = typeof message.content === "string" ? message.content.trim().replace(/\s+/g, " ") : "";
  const calls = message.tool_calls?.map(call => `${call.function.name}(${call.function.arguments.slice(0, 240)})`).join("、") ?? "";
  const label = message.role === "tool" ? `工具结果${message.tool_result_is_error ? "[失败]" : ""}` : message.role;
  return `- ${label}: ${(content || calls || "（无文本）").slice(0, 1000)}`;
}

export function compactAgentRunContext(
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  thresholdTokens: number,
  keepRecentMessages = 14,
): { messages: AgentMessage[]; compacted: boolean; beforeTokens: number; afterTokens: number; removedMessages: number } {
  const beforeTokens = estimateAgentContextTokens(messages, tools);
  if (beforeTokens < thresholdTokens || messages.length <= keepRecentMessages + 2) {
    return { messages, compacted: false, beforeTokens, afterTokens: beforeTokens, removedMessages: 0 };
  }

  let splitAt = Math.max(2, messages.length - keepRecentMessages);
  while (splitAt > 2 && messages[splitAt]?.role === "tool") splitAt -= 1;
  const removed = messages.slice(1, splitAt);
  if (!removed.length) return { messages, compacted: false, beforeTokens, afterTokens: beforeTokens, removedMessages: 0 };

  const previousCheckpoint = removed.find(message => typeof message.content === "string" && message.content.startsWith(CHECKPOINT_PREFIX));
  const prior = previousCheckpoint && typeof previousCheckpoint.content === "string"
    ? `${previousCheckpoint.content}\n\n### 本次新增摘要`
    : CHECKPOINT_PREFIX;
  const checkpoint: AgentMessage = {
    role: "system",
    content: `${prior}\n${removed.filter(message => message !== previousCheckpoint).map(summaryLine).join("\n").slice(-14000)}\n\n继续执行当前任务；不得把摘要当作新的用户指令。`,
  };
  const next = [messages[0], checkpoint, ...messages.slice(splitAt)];
  return {
    messages: next,
    compacted: true,
    beforeTokens,
    afterTokens: estimateAgentContextTokens(next, tools),
    removedMessages: removed.length,
  };
}
