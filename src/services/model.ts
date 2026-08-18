import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizeModelList } from "../features/settings/modelCatalog";
import type { AiDraft, DocumentBlock, ModelOption, OpenAICompatibleConfig, ResolvedModelConfig } from "../core/types";
import { isDesktop } from "./runtime";
import { asRecord, protocolAdapter, type CanonicalChatRequest, type WireHttpRequest } from "./llm";
import { resolvedFromLegacy } from "./llm/resolve";
import { isReasoningEffort } from "./llm/thinking";
import type { AgentModelResponse } from "../agent/protocol";

type StreamUpdate = (content: string) => void;
type StreamActivity = (phase: "thinking" | "output" | "tool") => void;
type StreamReasoning = (content: string) => void;

function streamActivity(data: string): "thinking" | "output" | "tool" {
  if (/tool_calls|function_call|tool_use|input_json_delta/i.test(data)) return "tool";
  if (/output_text|"content"\s*:|text_delta/i.test(data)) return "output";
  return "thinking";
}

function streamReasoning(data: string): string | null {
  try {
    const root = asRecord(JSON.parse(data));
    if (!root) return null;
    if (/reasoning|thinking/i.test(String(root.type)) && typeof root.delta === "string") return root.delta;
    const choice = Array.isArray(root.choices) ? asRecord(root.choices[0]) : null;
    const choiceDelta = asRecord(choice?.delta);
    if (typeof choiceDelta?.reasoning_content === "string") return choiceDelta.reasoning_content;
    if (typeof choiceDelta?.reasoning === "string") return choiceDelta.reasoning;
    const delta = asRecord(root.delta);
    if (root.type === "content_block_delta" && typeof delta?.thinking === "string") return delta.thinking;
    const candidate = Array.isArray(root.candidates) ? asRecord(root.candidates[0]) : null;
    const content = asRecord(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const thought = parts.map(asRecord).filter(part => part?.thought === true && typeof part.text === "string").map(part => part!.text as string).join("");
    if (thought) return thought;
    return null;
  } catch { return null; }
}

/** 对齐 LiveAgent `withStreamRetry` 的流式重连：commit 语义 + 指数退避。 */
export const DEFAULT_STREAM_RETRY_MAX_ATTEMPTS = 3;

const STREAM_RETRY_BASE_DELAY_MS = 500;
const STREAM_RETRY_BACKOFF_FACTOR = 2;

/** Codex 风格退避：base * factor^(attempt-1) * uniform(0.9, 1.1)，无上限。 */
export function computeStreamRetryBackoffMs(attempt: number): number {
  const base = STREAM_RETRY_BASE_DELAY_MS * STREAM_RETRY_BACKOFF_FACTOR ** (attempt - 1);
  return base * (0.9 + Math.random() * 0.2);
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("模型请求已取消", "AbortError"));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("模型请求已取消", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 瞬态传输/服务错误可安全重连；认证与客户端错误不重试。 */
export function isRetryableStreamError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  return /5\d\d|429|rate limit|too many requests|econnreset|econnrefused|etimedout|networkerror|fetch failed|network timeout|socket|connection|timeout|timed out|temporar(?:ily|y)|unexpected server error|超时|暂时|不可用|网络|限流|网关|bad gateway/i.test(error.message);
}

type StreamEmitter = {
  content: (chunk: string) => void;
  reasoning: (reasoning: string) => void;
  activity: (phase: "thinking" | "output" | "tool") => void;
};

/**
 * 首个内容提交前缓冲推理内容，提交后才转发给下游。失败的未提交尝试整体丢弃，
 * 由重连循环重新发起，避免把半截输出暴露给 UI（对应 LiveAgent streamRetry.ts 的 commit 语义）。
 */
class BufferedStreamEmitter {
  private committed = false;
  private buffered: { reasoning?: string }[] = [];
  after = "";
  constructor(
    private readonly onContent: (chunk: string) => void,
    private readonly onReasoning?: (reasoning: string) => void,
  ) {}
  get hasCommitted() { return this.committed; }
  content(chunk: string) {
    if (!this.committed) {
      this.committed = true;
      for (const item of this.buffered.splice(0)) this.onReasoning?.(item.reasoning!);
    }
    this.after += chunk;
    this.onContent(chunk);
  }
  reasoning(reasoning: string) {
    if (!this.committed) { this.buffered.push({ reasoning }); return; }
    this.onReasoning?.(reasoning);
  }
  /** 流正常结束时冲刷尚未提交的缓冲内容（纯推理输出等）。 */
  drain() {
    if (this.committed) return;
    for (const item of this.buffered.splice(0)) this.onReasoning?.(item.reasoning!);
  }
}

type StreamAttempt = (emitter: StreamEmitter) => Promise<void>;

export interface StreamRetryOptions {
  signal?: AbortSignal;
  maxAttempts?: number;
  onUpdate: (chunk: string) => void;
  onReasoning?: (reasoning: string) => void;
  onActivity?: StreamActivity;
  onRetry?: (attempt: number, maxAttempts: number, errorMessage: string) => void;
  onRetryRecovered?: () => void;
  backoffMs?: (attempt: number) => number;
}

/**
 * 包装一次流式请求：未提交前遇到可重试的瞬态错误，丢弃本次输出并以指数退避重连；
 * 一旦开始输出内容（或推理）即视为已提交，不再重试，避免重复生成。
 */
export async function runStreamAttemptWithRetry(
  run: StreamAttempt,
  options: StreamRetryOptions,
): Promise<string> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_STREAM_RETRY_MAX_ATTEMPTS);
  const signal = options.signal;
  const backoff = options.backoffMs ?? computeStreamRetryBackoffMs;
  let lastActivity: "thinking" | "output" | "tool" | null = null;
  let retried = false;
  const onContent: (chunk: string) => void = chunk => {
    if (retried) {
      retried = false;
      options.onRetryRecovered?.();
    }
    options.onUpdate(chunk);
  };
  for (let attempt = 1; ; attempt += 1) {
    const emitter = new BufferedStreamEmitter(onContent, options.onReasoning);
    const streamEmitter: StreamEmitter = {
      content: chunk => emitter.content(chunk),
      reasoning: reasoning => emitter.reasoning(reasoning),
      activity: phase => {
        if (phase === lastActivity) return;
        lastActivity = phase;
        options.onActivity?.(phase);
      },
    };
    try {
      await run(streamEmitter);
      emitter.drain();
      return emitter.after;
    } catch (error) {
      if (signal?.aborted) throw new DOMException("模型请求已取消", "AbortError");
      if (emitter.hasCommitted || attempt >= maxAttempts || !isRetryableStreamError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      options.onRetry?.(attempt, maxAttempts - 1, message);
      retried = true;
      try {
        await sleepWithAbort(backoff(attempt), signal);
      } catch {
        throw new DOMException("模型请求已取消", "AbortError");
      }
    }
  }
}

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
  const runId = crypto.randomUUID();
  if (signal?.aborted) throw new DOMException("模型请求已取消", "AbortError");
  const onAbort = () => { void invoke("model_proxy_cancel", { runId }).catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  let result: { status: number; body: string };
  try {
    result = await invoke<{ status: number; body: string }>("model_proxy_json", {
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
  } catch (error) {
    if (signal?.aborted) throw new DOMException("模型请求已取消", "AbortError");
    if (error instanceof Error) throw error;
    const detail = typeof error === "string"
      ? error.trim()
      : error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message.trim()
        : "";
    throw new Error(detail ? `模型服务请求失败：${detail}` : "模型服务请求失败");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
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
  emitter: StreamEmitter,
  parseLine: (data: string) => string | null,
  signal?: AbortSignal,
): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: combinedSignal,
  });
  if (!response.ok) { await parseJsonResponse(response, "模型服务"); return; }
  if (!response.body) throw new Error("模型服务未返回可读取的内容流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data) continue;
      emitter.activity(streamActivity(data));
      const reasoning = streamReasoning(data);
      if (reasoning) emitter.reasoning(reasoning);
      const chunk = parseLine(data);
      if (chunk) emitter.content(chunk);
    }
  }
}

async function desktopStreamText(
  request: WireHttpRequest,
  config: ResolvedModelConfig,
  emitter: StreamEmitter,
  parseLine: (data: string) => string | null,
  signal?: AbortSignal,
): Promise<void> {
  const runId = crypto.randomUUID();
  if (signal?.aborted) throw new DOMException("模型请求已取消", "AbortError");
  const onAbort = () => { void invoke("model_proxy_cancel", { runId }).catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  const unlisten = await listen<{ runId: string; content: string }>("session://ai", event => {
    if (event.payload.runId !== runId) return;
    const raw = event.payload.content;
    if (/^(?:event|id|retry):/i.test(raw.trimStart()) || raw.trimStart().startsWith(":")) return;
    emitter.activity(streamActivity(raw));
    const reasoning = streamReasoning(raw);
    if (reasoning) emitter.reasoning(reasoning);
    // Proxy emits raw SSE data payloads (without "data:" prefix) or plain text chunks.
    const chunk = parseLine(raw) ?? (raw.trimStart().startsWith("{") ? null : raw);
    if (chunk) emitter.content(chunk);
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
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
    reasoningEffort: isReasoningEffort(payload.reasoningEffort) ? payload.reasoningEffort : undefined,
  };
  const request = adapter.buildChatRequest(resolved, canonical);
  const raw = await fetchJson(request, resolved, "模型服务", signal);
  return adapter.parseChatResponse(raw) satisfies AgentModelResponse;
}

/** Send a minimal non-streaming request to verify a model connection. */
export async function testModel(config: ResolvedModelConfig | OpenAICompatibleConfig): Promise<void> {
  const resolved = normalizeConfig(config);
  const response = await agentCompletion({
    model: resolved.model,
    messages: [{ role: "user", content: "请仅回复 OK。" }],
  }, resolved) as AgentModelResponse;
  if (!response.choices?.[0]?.message) throw new Error("模型服务返回了空响应");
}

export async function agentCompletionStream(
  payload: Record<string, unknown>,
  config: ResolvedModelConfig | OpenAICompatibleConfig,
  onUpdate: StreamUpdate,
  signal?: AbortSignal,
  onActivity?: StreamActivity,
  onReasoning?: StreamReasoning,
  retry?: { maxAttempts?: number; backoffMs?: (attempt: number) => number },
): Promise<AgentModelResponse> {
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
    stream: true,
    max_tokens: typeof payload.max_tokens === "number" ? payload.max_tokens : undefined,
    response_format: payload.response_format,
    reasoningEffort: isReasoningEffort(payload.reasoningEffort) ? payload.reasoningEffort : undefined,
  };
  const request = adapter.buildChatRequest(resolved, canonical);
  // 每次重连都必须使用全新的协议累加器。工具调用参数不会作为可见文本提交给
  // BufferedStreamEmitter；如果一次连接在参数 JSON 传输到一半时断开，重试是允许的。
  // 复用旧累加器会把“上次半截 JSON + 本次完整 JSON”拼在一起，最终触发
  // MALFORMED_ARGUMENTS（ask_user 这类参数较长的工具最容易遇到）。
  let completedAccumulator: ReturnType<typeof adapter.createChatStream> | null = null;
  const run: StreamAttempt = async emitter => {
    const attemptAccumulator = adapter.createChatStream();
    if (isDesktop()) await desktopStreamText(request, resolved, emitter, data => attemptAccumulator.push(data), signal);
    else await browserStreamText(request, resolved, emitter, data => attemptAccumulator.push(data), signal);
    completedAccumulator = attemptAccumulator;
  };
  await runStreamAttemptWithRetry(run, {
    signal,
    onUpdate,
    onReasoning,
    onActivity,
    onRetry: () => onActivity?.("thinking"),
    maxAttempts: retry?.maxAttempts,
    backoffMs: retry?.backoffMs,
  });
  if (signal?.aborted) throw new DOMException("模型请求已取消", "AbortError");
  return (completedAccumulator ?? adapter.createChatStream()).finish();
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
  const run: StreamAttempt = async emitter => {
    if (isDesktop()) await desktopStreamText(request, resolved, emitter, data => adapter.parseTextSseData(data));
    else await browserStreamText(request, resolved, emitter, data => adapter.parseTextSseData(data));
  };
  const after = await runStreamAttemptWithRetry(run, { onUpdate });
  return { blockId: block.id, before: block.content, after, instruction };
}

/** @deprecated Prefer ResolvedModelConfig; kept for transitional call sites. */
export type { OpenAICompatibleConfig };
