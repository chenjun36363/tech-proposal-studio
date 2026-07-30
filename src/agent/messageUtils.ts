import type { AgentMessage } from "./protocol";

export function summarizeAgentMessage(message: AgentMessage): string {
  const content = typeof message.content === "string" ? message.content.trim().replace(/\s+/g, " ") : "";
  const calls = message.tool_calls?.map(call => `${call.function.name}(${call.function.arguments.slice(0, 240)})`).join("、") ?? "";
  const label = message.role === "tool" ? `工具结果${message.tool_result_is_error ? "[失败]" : ""}` : message.role;
  return `- ${label}: ${(content || calls || "（无文本）").slice(0, 1000)}`;
}

export function safeTurnSplitIndex(messages: AgentMessage[], target: number, minimum = 0): number {
  let splitAt = Math.max(minimum, Math.min(messages.length, target));
  while (splitAt > minimum && messages[splitAt]?.role !== "user") splitAt -= 1;
  if (splitAt === minimum && messages[splitAt]?.role !== "user") {
    splitAt = Math.max(minimum, Math.min(messages.length, target));
    while (splitAt > minimum && messages[splitAt]?.role === "tool") splitAt -= 1;
  }
  return splitAt;
}

export function persistentAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(message => !message.transient).map(({ transient: _transient, ...message }) => {
    const data = message.tool_result_data;
    if (message.role === "tool" && data && typeof data === "object" && (data as Record<string, unknown>).sensitive === true) {
      const { sensitive: _sensitive, persistedSummary, ...audit } = data as Record<string, unknown>;
      return { ...message, content: typeof persistedSummary === "string" ? persistedSummary : "[敏感工具结果未持久化]", tool_result_data: audit };
    }
    return message;
  });
}
