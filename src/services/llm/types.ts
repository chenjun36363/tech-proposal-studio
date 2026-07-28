import type { AgentMessage, AgentModelResponse, AgentToolDefinition } from "../../agent/protocol";
import type { LlmProtocol, ResolvedModelConfig } from "../../types";

export type HttpMethod = "GET" | "POST";

export interface WireHttpRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: unknown;
}

export interface CanonicalChatRequest {
  model: string;
  messages: AgentMessage[];
  tools?: AgentToolDefinition[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  temperature?: number;
  stream?: boolean;
  max_tokens?: number;
  response_format?: unknown;
}

export interface ProtocolAdapter {
  protocol: LlmProtocol;
  buildListRequest(config: ResolvedModelConfig): WireHttpRequest;
  buildChatRequest(config: ResolvedModelConfig, request: CanonicalChatRequest): WireHttpRequest;
  parseChatResponse(payload: unknown): AgentModelResponse;
  /** Extract plain assistant text from a non-stream response. */
  extractText(payload: unknown): string;
  /** Parse one SSE data payload (already without the `data:` prefix). */
  parseTextSseData(data: string): string | null;
}

export function baseUrl(config: ResolvedModelConfig): string {
  return config.baseUrl.trim().replace(/\/+$/, "");
}

export function mergeHeaders(
  config: ResolvedModelConfig,
  auth: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Accept: "application/json",
    ...auth,
    ...config.headers,
    ...extra,
  };
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some(key => key.toLowerCase() === lower);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function openAiStyleResponse(message: AgentMessage, finishReason?: string | null): AgentModelResponse {
  return { choices: [{ message, finish_reason: finishReason ?? null }] };
}
