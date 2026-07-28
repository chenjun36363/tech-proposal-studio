import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizeModelList } from "../modelCatalog";
import type { AiDraft, DocumentBlock, ModelOption, OpenAICompatibleConfig, ResolvedModelConfig } from "../types";
import { isDesktop } from "./runtime";
import { protocolAdapter, type CanonicalChatRequest, type WireHttpRequest } from "./llm";
import { resolvedFromLegacy } from "./llm/resolve";
import type { AgentModelResponse } from "../agent/protocol";

type StreamUpdate = (content: string) => void;

function ensureEnabled(config: ResolvedModelConfig): void {
  if (!config.enabled) throw new Error("当前项目已禁用联网 AI");
  if (!config.baseUrl.trim()) throw new Error("请先填写模型服务 API 地址");
}

function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return /(?:localhost|127\.0\.0\.1|\[::1\]|::1)/i.test(baseUrl);
  }
}

function requireKey(config: ResolvedModelConfig): void {
  if (!config.apiKey.trim() && !isLocalEndpoint(config.baseUrl) && !isDesktop()) {
    throw new Error("请先在设置中填写 API Key");
  }
}

async function parseJsonResponse(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  let payload: unknown = null;
  if (text.trim()) {
    try { payload = JSON.parse(text); }
    catch { throw new Error(`${label}返回了无效 JSON`); }
  }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "error" in payload
      ? (payload.error as { message?: unknown })?.message
      : undefined;
    throw new Error(`${label}返回 ${response.status}${typeof detail === "string" && detail ? `：${detail}` : ""}`);
  }
  return payload;
}

async function browserFetchJson(request: WireHttpRequest, timeoutMs: number, label: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  return parseJsonResponse(response, label);
}

async function desktopProxyJson(request: WireHttpRequest, config: ResolvedModelConfig, signal?: AbortSignal): Promise<unknown> {
  // AbortSignal is not forwarded through invoke; timeout is enforced server-side.
  void signal;
  const result = await invoke<{ status: number; body: string }>("model_proxy_json", {
    request: {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body ?? null,
      timeoutMs: config.timeoutMs,
      apiKey: config.apiKey,
      protocol: config.protocol,
      providerId: config.providerId,
    },
  });
  let payload: unknown = null;
  if (result.body?.trim()) {
    try { payload = JSON.parse(result.body); }
    catch {
      if (result.status >= 200 && result.status < 300) throw new Error("模型服务返回了无效 JSON");
      throw new Error(`模型服务返回 ${result.status}`);
    }
  }
  if (result.status < 200 || result.status >= 300) {
    const detail = payload && typeof payload === "object" && payload && "error" in payload
      ? (payload as { error?: { message?: string } }).error?.message
      : undefined;
    throw new Error(`模型服务返回 ${result.status}${detail ? `：${detail}` : ""}`);
  }
  return payload;
}

async function fetchJson(request: WireHttpRequest, config: ResolvedModelConfig, label: string, signal?: AbortSignal): Promise<unknown> {
  if (isDesktop()) return desktopProxyJson(request, config, signal);
  return browserFetchJson(request, config.timeoutMs, label, signal);
}

async function browserStreamText(
  request: WireHttpRequest,
  config: ResolvedModelConfig,
  onUpdate: StreamUpdate,
  parseLine: (data: string) => string | null,
): Promise<string> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`模型服务返回 ${response.status}`);
  if (!response.body) throw new Error("模型服务未返回可读取的内容流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let after = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data) continue;
      const chunk = parseLine(data);
      if (chunk) { after += chunk; onUpdate(chunk); }
    }
  }
  return after;
}

async function desktopStreamText(
  request: WireHttpRequest,
  config: ResolvedModelConfig,
  onUpdate: StreamUpdate,
  parseLine: (data: string) => string | null,
): Promise<string> {
  const runId = crypto.randomUUID();
  let after = "";
  const unlisten = await listen<{ runId: string; content: string }>("session://ai", event => {
    if (event.payload.runId !== runId) return;
    const raw = event.payload.content;
    // Proxy emits raw SSE data payloads (without "data:" prefix) or plain text chunks.
    const chunk = parseLine(raw) ?? (raw.startsWith("{") ? parseLine(raw) : raw);
    if (chunk) {
      after += chunk;
      onUpdate(chunk);
    }
  });
  try {
    await invoke("model_proxy_stream", {
      runId,
      request: {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body ?? null,
        timeoutMs: config.timeoutMs,
        apiKey: config.apiKey,
        protocol: config.protocol,
        providerId: config.providerId,
      },
    });
    return after;
  } finally {
    unlisten();
  }
}

function draftRequest(block: DocumentBlock, instruction: string, context: string[], stream: boolean): CanonicalChatRequest {
  return {
    model: "",
    messages: [
      { role: "system", content: "你是软件技术方案编辑。只返回修改后的正文，不解释，不添加 Markdown 围栏。" },
      { role: "user", content: `编辑要求：${instruction}\n\n参考上下文：\n${context.join("\n---\n")}\n\n待修改内容：\n${block.content}` },
    ],
    stream,
  };
}

function normalizeConfig(config: ResolvedModelConfig | OpenAICompatibleConfig): ResolvedModelConfig {
  if ("protocol" in config && "providerId" in config) return config;
  return resolvedFromLegacy(config);
}

export async function agentCompletion(
  payload: Record<string, unknown>,
  config: ResolvedModelConfig | OpenAICompatibleConfig,
  signal?: AbortSignal,
): Promise<unknown> {
  const resolved = normalizeConfig(config);
  ensureEnabled(resolved);
  requireKey(resolved);
  const adapter = protocolAdapter(resolved.protocol);
  const canonical: CanonicalChatRequest = {
    model: typeof payload.model === "string" ? payload.model : resolved.model,
    messages: (payload.messages as CanonicalChatRequest["messages"]) ?? [],
    tools: payload.tools as CanonicalChatRequest["tools"],
    tool_choice: payload.tool_choice as CanonicalChatRequest["tool_choice"],
    temperature: typeof payload.temperature === "number" ? payload.temperature : undefined,
    stream: false,
    max_tokens: typeof payload.max_tokens === "number" ? payload.max_tokens : undefined,
    response_format: payload.response_format,
  };
  const request = adapter.buildChatRequest(resolved, canonical);
  const raw = await fetchJson(request, resolved, "模型服务", signal);
  return adapter.parseChatResponse(raw) satisfies AgentModelResponse;
}

export async function listModels(config: ResolvedModelConfig | OpenAICompatibleConfig): Promise<ModelOption[]> {
  const resolved = normalizeConfig(config);
  if (!resolved.baseUrl.trim()) throw new Error("请先填写模型服务 API 地址");
  requireKey(resolved);
  const adapter = protocolAdapter(resolved.protocol);
  const request = adapter.buildListRequest(resolved);
  const raw = await fetchJson(request, resolved, "模型列表请求");
  let models = normalizeModelList(raw);
  if (resolved.protocol === "google-generative-ai") {
    models = models.map(item => ({
      ...item,
      id: item.id.replace(/^models\//, ""),
      displayName: item.displayName.replace(/^models\//, ""),
    }));
  }
  if (!models.length) throw new Error("上游未返回可识别的模型列表");
  return models;
}

export async function improveBlock(
  block: DocumentBlock,
  instruction: string,
  context: string[],
  config: ResolvedModelConfig | OpenAICompatibleConfig,
): Promise<AiDraft> {
  const resolved = normalizeConfig(config);
  ensureEnabled(resolved);
  requireKey(resolved);
  const adapter = protocolAdapter(resolved.protocol);
  const canonical = draftRequest(block, instruction, context, false);
  canonical.model = resolved.model;
  const request = adapter.buildChatRequest(resolved, canonical);
  const raw = await fetchJson(request, resolved, "模型服务");
  return {
    blockId: block.id,
    before: block.content,
    after: adapter.extractText(raw),
    instruction,
  };
}

export async function improveBlockStream(
  block: DocumentBlock,
  instruction: string,
  context: string[],
  config: ResolvedModelConfig | OpenAICompatibleConfig,
  onUpdate: StreamUpdate,
): Promise<AiDraft> {
  const resolved = normalizeConfig(config);
  ensureEnabled(resolved);
  requireKey(resolved);
  const adapter = protocolAdapter(resolved.protocol);
  const canonical = draftRequest(block, instruction, context, true);
  canonical.model = resolved.model;
  const request = adapter.buildChatRequest(resolved, { ...canonical, stream: true });
  const after = isDesktop()
    ? await desktopStreamText(request, resolved, onUpdate, data => adapter.parseTextSseData(data))
    : await browserStreamText(request, resolved, onUpdate, data => adapter.parseTextSseData(data));
  return { blockId: block.id, before: block.content, after, instruction };
}

/** @deprecated Prefer ResolvedModelConfig; kept for transitional call sites. */
export type { OpenAICompatibleConfig };
