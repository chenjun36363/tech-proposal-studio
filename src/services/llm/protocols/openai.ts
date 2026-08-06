import type { AgentMessage, AgentToolCall, AgentToolDefinition } from "../../../agent/protocol";
import type { ResolvedModelConfig } from "../../../core/types";
import {
  asRecord,
  baseUrl,
  mergeHeaders,
  openAiStyleResponse,
  type ProtocolAdapter,
} from "../types";
import { openaiReasoningEffort } from "../thinking";

function bearerAuth(config: ResolvedModelConfig): Record<string, string> {
  if (!config.apiKey.trim()) return {};
  return { Authorization: `Bearer ${config.apiKey}` };
}

function contentOf(message: AgentMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

export const openaiCompletionsAdapter: ProtocolAdapter = {
  protocol: "openai-completions",

  buildListRequest(config) {
    const root = baseUrl(config);
    const url = /\/models$/i.test(root) ? root : `${root}/models`;
    return {
      url,
      method: "GET",
      headers: mergeHeaders(config, bearerAuth(config)),
    };
  },

  buildChatRequest(config, request) {
    const body: Record<string, unknown> = {
      model: request.model || config.model,
      messages: request.messages.map(({ reasoning_content: _reasoning, ...message }) => message),
      stream: Boolean(request.stream),
    };
    if (typeof request.temperature === "number") body.temperature = request.temperature;
    if (typeof request.max_tokens === "number") body.max_tokens = request.max_tokens;
    if (request.tools?.length) body.tools = request.tools;
    if (request.tool_choice) body.tool_choice = request.tool_choice;
    if (request.response_format) body.response_format = request.response_format;
    const effort = openaiReasoningEffort(request.reasoningEffort ?? config.reasoningEffort);
    if (effort) body.reasoning_effort = effort;
    return {
      url: `${baseUrl(config)}/chat/completions`,
      method: "POST",
      headers: mergeHeaders(config, bearerAuth(config), { "Content-Type": "application/json" }),
      body,
    };
  },

  parseChatResponse(payload) {
    const root = asRecord(payload);
    const choice = Array.isArray(root?.choices) ? asRecord(root!.choices[0]) : null;
    const message = asRecord(choice?.message) as AgentMessage | null;
    if (!message) return { choices: [] };
    return openAiStyleResponse(
      {
        role: "assistant",
        content: typeof message.content === "string" ? message.content : message.content ?? null,
        tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls as AgentMessage["tool_calls"] : undefined,
      },
      typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    );
  },

  extractText(payload) {
    const response = this.parseChatResponse(payload);
    const content = response.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  },

  parseTextSseData(data) {
    if (!data || data === "[DONE]") return null;
    try {
      const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      const chunk = json.choices?.[0]?.delta?.content;
      return typeof chunk === "string" && chunk ? chunk : null;
    } catch {
      return null;
    }
  },

  createChatStream() {
    let content = "";
    let finishReason: string | null = null;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    return {
      push(data) {
        if (!data || data === "[DONE]") return null;
        try {
          const root = asRecord(JSON.parse(data));
          const choice = Array.isArray(root?.choices) ? asRecord(root.choices[0]) : null;
          const delta = asRecord(choice?.delta);
          if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
          for (const raw of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
            const call = asRecord(raw);
            const index = typeof call?.index === "number" ? call.index : calls.size;
            const fn = asRecord(call?.function);
            const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
            if (typeof call?.id === "string") current.id = call.id;
            if (typeof fn?.name === "string") current.name += fn.name;
            if (typeof fn?.arguments === "string") current.arguments += fn.arguments;
            calls.set(index, current);
          }
          const text = typeof delta?.content === "string" ? delta.content : "";
          content += text;
          return text || null;
        } catch { return null; }
      },
      finish() {
        const toolCalls = [...calls.values()].filter(call => call.name).map(call => ({
          id: call.id || crypto.randomUUID(), type: "function" as const,
          function: { name: call.name, arguments: call.arguments || "{}" },
        }));
        return openAiStyleResponse({ role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined }, finishReason ?? (toolCalls.length ? "tool_calls" : "stop"));
      },
    };
  },
};

/** Map OpenAI-style tools into Responses API function tools. */
function responsesTools(tools: AgentToolDefinition[] | undefined) {
  if (!tools?.length) return undefined;
  return tools.map(tool => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

function responsesInput(messages: AgentMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      input.push({ role: "system", content: contentOf(message) });
      continue;
    }
    if (message.role === "user") {
      input.push({ role: "user", content: contentOf(message) });
      continue;
    }
    if (message.role === "assistant") {
      if (message.tool_calls?.length) {
        for (const call of message.tool_calls) {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
      }
      const text = contentOf(message);
      if (text) input.push({ role: "assistant", content: text });
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output: contentOf(message),
      });
    }
  }
  return input;
}

function parseResponsesToolCalls(payload: Record<string, unknown>): AgentMessage["tool_calls"] {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const calls: NonNullable<AgentMessage["tool_calls"]> = [];
  for (const item of output) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (rec.type === "function_call" || rec.type === "custom_tool_call") {
      const name = typeof rec.name === "string" ? rec.name : "";
      const id = typeof rec.call_id === "string" ? rec.call_id : (typeof rec.id === "string" ? rec.id : crypto.randomUUID());
      const args = typeof rec.arguments === "string" ? rec.arguments : JSON.stringify(rec.arguments ?? {});
      if (name) calls.push({ id, type: "function", function: { name, arguments: args } });
    }
  }
  return calls.length ? calls : undefined;
}

function responsesOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string" && payload.output_text) return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (rec.type === "message") {
      const content = Array.isArray(rec.content) ? rec.content : [];
      for (const block of content) {
        const b = asRecord(block);
        if (b && (b.type === "output_text" || b.type === "text") && typeof b.text === "string") parts.push(b.text);
      }
    }
  }
  return parts.join("");
}

export const openaiResponsesAdapter: ProtocolAdapter = {
  protocol: "openai-responses",

  buildListRequest(config) {
    return openaiCompletionsAdapter.buildListRequest(config);
  },

  buildChatRequest(config, request) {
    const body: Record<string, unknown> = {
      model: request.model || config.model,
      input: responsesInput(request.messages),
      stream: Boolean(request.stream),
    };
    if (typeof request.temperature === "number") body.temperature = request.temperature;
    if (typeof request.max_tokens === "number") body.max_output_tokens = request.max_tokens;
    const tools = responsesTools(request.tools);
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = request.tool_choice === "none"
        ? "none"
        : request.tool_choice && typeof request.tool_choice === "object"
          ? { type: "function", name: request.tool_choice.function.name }
          : "auto";
    }
    const effort = openaiReasoningEffort(request.reasoningEffort ?? config.reasoningEffort);
    if (effort) body.reasoning = { effort };
    return {
      url: `${baseUrl(config)}/responses`,
      method: "POST",
      headers: mergeHeaders(config, bearerAuth(config), { "Content-Type": "application/json" }),
      body,
    };
  },

  parseChatResponse(payload) {
    const root = asRecord(payload);
    if (!root) return { choices: [] };
    const toolCalls = parseResponsesToolCalls(root);
    const text = responsesOutputText(root);
    return openAiStyleResponse({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls,
    }, toolCalls?.length ? "tool_calls" : "stop");
  },

  extractText(payload) {
    const root = asRecord(payload);
    return root ? responsesOutputText(root) : "";
  },

  parseTextSseData(data) {
    if (!data || data === "[DONE]") return null;
    try {
      const json = JSON.parse(data) as Record<string, unknown>;
      if (json.type === "response.output_text.delta" && typeof json.delta === "string") return json.delta;
      return null;
    } catch {
      return null;
    }
  },

  createChatStream() {
    let content = "";
    const calls = new Map<string, { id: string; name: string; arguments: string }>();
    const chatFallback = openaiCompletionsAdapter.createChatStream();
    let usesChatFallback = false;
    return {
      push(data) {
        if (!data || data === "[DONE]") return null;
        try {
          const event = asRecord(JSON.parse(data));
          if (!event) return null;
          if (Array.isArray(event.choices)) {
            usesChatFallback = true;
            return chatFallback.push(data);
          }
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            content += event.delta;
            return event.delta;
          }
          const item = asRecord(event.item);
          if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") && item?.type === "function_call") {
            const key = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : crypto.randomUUID();
            const current = calls.get(key) ?? { id: key, name: "", arguments: "" };
            if (typeof item.name === "string") current.name = item.name;
            if (typeof item.arguments === "string") current.arguments = item.arguments;
            calls.set(key, current);
          }
          if ((event.type === "response.function_call_arguments.delta" || event.type === "response.function_call_arguments.done") && typeof event.call_id === "string") {
            const current = calls.get(event.call_id) ?? { id: event.call_id, name: "", arguments: "" };
            if (typeof event.name === "string") current.name = event.name;
            if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") current.arguments += event.delta;
            if (event.type === "response.function_call_arguments.done" && typeof event.arguments === "string") current.arguments = event.arguments;
            calls.set(event.call_id, current);
          }
          return null;
        } catch { return null; }
      },
      finish() {
        if (usesChatFallback) return chatFallback.finish();
        const toolCalls = [...calls.values()].filter(call => call.name).map(call => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments || "{}" } }));
        return openAiStyleResponse({ role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined }, toolCalls.length ? "tool_calls" : "stop");
      },
    };
  },
};

// silence unused import for AgentToolCall if tree-shaken differently
void (null as unknown as AgentToolCall);
