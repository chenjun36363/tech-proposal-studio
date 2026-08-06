import type { AgentMessage, AgentToolDefinition } from "../../../agent/protocol";
import type { ResolvedModelConfig } from "../../../core/types";
import {
  asRecord,
  baseUrl,
  mergeHeaders,
  openAiStyleResponse,
  type CanonicalChatRequest,
  type ProtocolAdapter,
} from "../types";
import { anthropicThinkingConfig } from "../thinking";

function anthropicAuth(config: ResolvedModelConfig): Record<string, string> {
  if (!config.apiKey.trim()) return {};
  return {
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01",
  };
}

function contentOf(message: AgentMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function anthropicTools(tools: AgentToolDefinition[] | undefined) {
  if (!tools?.length) return undefined;
  return tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters?.type
      ? tool.function.parameters
      : { type: "object", properties: tool.function.parameters?.properties ?? {}, ...(tool.function.parameters ?? {}) },
  }));
}

function splitSystem(messages: AgentMessage[]): { system: string; rest: AgentMessage[] } {
  const systemParts: string[] = [];
  const rest: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") systemParts.push(contentOf(message));
    else rest.push(message);
  }
  return { system: systemParts.filter(Boolean).join("\n\n"), rest };
}

function toAnthropicMessages(messages: AgentMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: contentOf(message) });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: unknown[] = [];
      if (contentOf(message)) blocks.push({ type: "text", text: contentOf(message) });
      for (const call of message.tool_calls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(call.function.arguments || "{}"); } catch { input = { raw: call.function.arguments }; }
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
      continue;
    }
    if (message.role === "tool") {
      out.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id ?? "",
          content: contentOf(message),
          is_error: Boolean(message.tool_result_is_error),
        }],
      });
    }
  }
  // Merge consecutive user tool_result messages
  const merged: unknown[] = [];
  for (const item of out) {
    const rec = asRecord(item);
    const prev = asRecord(merged[merged.length - 1]);
    if (rec?.role === "user" && prev?.role === "user" && Array.isArray(rec.content) && Array.isArray(prev.content)) {
      prev.content = [...prev.content, ...rec.content];
      continue;
    }
    merged.push(item);
  }
  return merged;
}

export const anthropicMessagesAdapter: ProtocolAdapter = {
  protocol: "anthropic-messages",

  buildListRequest(config) {
    const root = baseUrl(config);
    const url = /\/models$/i.test(root) ? root : `${root}/models`;
    return {
      url,
      method: "GET",
      headers: mergeHeaders(config, anthropicAuth(config)),
    };
  },

  buildChatRequest(config, request: CanonicalChatRequest) {
    const { system, rest } = splitSystem(request.messages);
    const effort = request.reasoningEffort ?? config.reasoningEffort;
    let maxTokens = request.max_tokens ?? 8192;
    const thinking = anthropicThinkingConfig(effort, maxTokens);
    const body: Record<string, unknown> = {
      model: request.model || config.model,
      messages: toAnthropicMessages(rest),
      max_tokens: thinking ? thinking.maxTokens : maxTokens,
      stream: Boolean(request.stream),
    };
    if (thinking) body.thinking = { type: "enabled" as const, budget_tokens: thinking.budgetTokens };
    if (system) body.system = system;
    if (typeof request.temperature === "number") body.temperature = request.temperature;
    const tools = anthropicTools(request.tools);
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = request.tool_choice === "none"
        ? { type: "none" }
        : request.tool_choice && typeof request.tool_choice === "object"
          ? { type: "tool", name: request.tool_choice.function.name }
          : { type: "auto" };
    }
    return {
      url: `${baseUrl(config)}/messages`,
      method: "POST",
      headers: mergeHeaders(config, anthropicAuth(config), { "Content-Type": "application/json" }),
      body,
    };
  },

  parseChatResponse(payload) {
    const root = asRecord(payload);
    if (!root) return { choices: [] };
    const content = Array.isArray(root.content) ? root.content : [];
    const texts: string[] = [];
    const toolCalls: NonNullable<AgentMessage["tool_calls"]> = [];
    for (const block of content) {
      const rec = asRecord(block);
      if (!rec) continue;
      if (rec.type === "text" && typeof rec.text === "string") texts.push(rec.text);
      if (rec.type === "tool_use") {
        const id = typeof rec.id === "string" ? rec.id : crypto.randomUUID();
        const name = typeof rec.name === "string" ? rec.name : "";
        if (name) {
          toolCalls.push({
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(rec.input ?? {}) },
          });
        }
      }
    }
    return openAiStyleResponse({
      role: "assistant",
      content: texts.join("") || null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    }, toolCalls.length ? "tool_calls" : "stop");
  },

  extractText(payload) {
    const response = this.parseChatResponse(payload);
    const content = response.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  },

  parseTextSseData(data) {
    if (!data || data === "[DONE]") return null;
    try {
      const json = JSON.parse(data) as Record<string, unknown>;
      if (json.type === "content_block_delta") {
        const delta = asRecord(json.delta);
        if (delta?.type === "text_delta" && typeof delta.text === "string") return delta.text;
      }
      return null;
    } catch {
      return null;
    }
  },

  createChatStream() {
    let content = "";
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    return {
      push(data) {
        if (!data || data === "[DONE]") return null;
        try {
          const event = asRecord(JSON.parse(data));
          const index = typeof event?.index === "number" ? event.index : 0;
          const block = asRecord(event?.content_block);
          if (event?.type === "content_block_start" && block?.type === "tool_use") {
            calls.set(index, { id: typeof block.id === "string" ? block.id : crypto.randomUUID(), name: typeof block.name === "string" ? block.name : "", arguments: "" });
          }
          const delta = asRecord(event?.delta);
          if (event?.type === "content_block_delta" && delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const call = calls.get(index);
            if (call) call.arguments += delta.partial_json;
          }
          const text = event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
          content += text;
          return text || null;
        } catch { return null; }
      },
      finish() {
        const toolCalls = [...calls.values()].filter(call => call.name).map(call => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments || "{}" } }));
        return openAiStyleResponse({ role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined }, toolCalls.length ? "tool_calls" : "stop");
      },
    };
  },
};
