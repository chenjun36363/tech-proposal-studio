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

function geminiAuth(config: ResolvedModelConfig): Record<string, string> {
  if (!config.apiKey.trim()) return {};
  return { "x-goog-api-key": config.apiKey };
}

function ensureGeminiBase(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  if (/\/v1beta$/i.test(trimmed) || /\/v1$/i.test(trimmed)) return trimmed;
  return trimmed;
}

function contentOf(message: AgentMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function geminiModelId(model: string): string {
  return model.replace(/^models\//, "");
}

function geminiTools(tools: AgentToolDefinition[] | undefined) {
  if (!tools?.length) return undefined;
  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    })),
  }];
}

function toGeminiContents(messages: AgentMessage[]): { systemInstruction?: { parts: Array<{ text: string }> }; contents: unknown[] } {
  const systemParts: string[] = [];
  const contents: unknown[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(contentOf(message));
      continue;
    }
    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: contentOf(message) }] });
      continue;
    }
    if (message.role === "assistant") {
      const parts: unknown[] = [];
      if (contentOf(message)) parts.push({ text: contentOf(message) });
      for (const call of message.tool_calls ?? []) {
        let args: unknown = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = { raw: call.function.arguments }; }
        parts.push({ functionCall: { name: call.function.name, args } });
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }
    if (message.role === "tool") {
      let response: unknown = contentOf(message);
      try { response = JSON.parse(contentOf(message)); } catch { /* keep string */ }
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: message.tool_call_id ? undefined : undefined,
            response: typeof response === "object" && response ? response : { result: response },
          },
        }],
      });
      // Gemini wants the function name on functionResponse; stash via tool name if present in content prefix is unavailable.
      const last = asRecord(contents[contents.length - 1]);
      const parts = Array.isArray(last?.parts) ? last.parts : [];
      const fr = asRecord(asRecord(parts[0])?.functionResponse);
      if (fr) {
        // Best effort: many gateways accept response-only; name filled from prior assistant call when available.
        fr.name = typeof fr.name === "string" && fr.name ? fr.name : "tool";
      }
    }
  }

  // Improve tool response names by scanning previous model functionCall names in order
  const callNames: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) callNames.push(call.function.name);
    }
  }
  let callIndex = 0;
  for (const item of contents) {
    const rec = asRecord(item);
    const parts = Array.isArray(rec?.parts) ? rec.parts : [];
    for (const part of parts) {
      const fr = asRecord(asRecord(part)?.functionResponse);
      if (fr && callNames[callIndex]) {
        fr.name = callNames[callIndex];
        callIndex += 1;
      }
    }
  }

  return {
    systemInstruction: systemParts.length ? { parts: [{ text: systemParts.join("\n\n") }] } : undefined,
    contents,
  };
}

export const googleGenerativeAiAdapter: ProtocolAdapter = {
  protocol: "google-generative-ai",

  buildListRequest(config) {
    const root = ensureGeminiBase(baseUrl(config));
    return {
      url: `${root}/models`,
      method: "GET",
      headers: mergeHeaders(config, geminiAuth(config)),
    };
  },

  buildChatRequest(config, request: CanonicalChatRequest) {
    const model = geminiModelId(request.model || config.model);
    const root = ensureGeminiBase(baseUrl(config));
    const { systemInstruction, contents } = toGeminiContents(request.messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (typeof request.temperature === "number" || typeof request.max_tokens === "number") {
      body.generationConfig = {
        ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
        ...(typeof request.max_tokens === "number" ? { maxOutputTokens: request.max_tokens } : {}),
      };
    }
    const tools = geminiTools(request.tools);
    if (tools) {
      body.tools = tools;
      const forcedTool = request.tool_choice && typeof request.tool_choice === "object"
        ? request.tool_choice.function.name
        : null;
      body.toolConfig = {
        functionCallingConfig: {
          mode: request.tool_choice === "none" ? "NONE" : forcedTool ? "ANY" : "AUTO",
          ...(forcedTool ? { allowedFunctionNames: [forcedTool] } : {}),
        },
      };
    }
    const action = request.stream ? "streamGenerateContent" : "generateContent";
    const query = request.stream ? "?alt=sse" : "";
    return {
      url: `${root}/models/${encodeURIComponent(model)}:${action}${query}`,
      method: "POST",
      headers: mergeHeaders(config, geminiAuth(config), { "Content-Type": "application/json" }),
      body,
    };
  },

  parseChatResponse(payload) {
    const root = asRecord(payload);
    // stream aggregates sometimes wrap as array
    const candidateRoot = Array.isArray(payload) ? asRecord(payload[payload.length - 1]) : root;
    const candidates = Array.isArray(candidateRoot?.candidates) ? candidateRoot!.candidates : [];
    const first = asRecord(candidates[0]);
    const content = asRecord(first?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const texts: string[] = [];
    const toolCalls: NonNullable<AgentMessage["tool_calls"]> = [];
    for (const part of parts) {
      const rec = asRecord(part);
      if (!rec) continue;
      if (typeof rec.text === "string") texts.push(rec.text);
      const fc = asRecord(rec.functionCall);
      if (fc && typeof fc.name === "string") {
        toolCalls.push({
          id: crypto.randomUUID(),
          type: "function",
          function: {
            name: fc.name,
            arguments: JSON.stringify(fc.args ?? fc.arguments ?? {}),
          },
        });
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
      const json = JSON.parse(data) as unknown;
      const parsed = this.parseChatResponse(json);
      const text = parsed.choices?.[0]?.message?.content;
      return typeof text === "string" && text ? text : null;
    } catch {
      return null;
    }
  },
};
