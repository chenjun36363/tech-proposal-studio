import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isLocalModelEndpoint, modelListHeaders, modelsEndpoint, normalizeModelList } from "../modelCatalog";
import type { AiDraft, DocumentBlock, ModelOption, OpenAICompatibleConfig } from "../types";
import { isDesktop } from "./runtime";

type StreamUpdate = (content: string) => void;

interface DraftRequest {
  blockId: string;
  before: string;
  instruction: string;
  payload: Record<string, unknown>;
}

interface ModelAdapter {
  complete(payload: Record<string, unknown>, config: OpenAICompatibleConfig, signal?: AbortSignal): Promise<unknown>;
  list(config: OpenAICompatibleConfig): Promise<ModelOption[]>;
  draft(request: DraftRequest, config: OpenAICompatibleConfig): Promise<AiDraft>;
  streamDraft(request: DraftRequest, config: OpenAICompatibleConfig, onUpdate: StreamUpdate): Promise<AiDraft>;
}

function browserKeyRequired(config: OpenAICompatibleConfig): boolean {
  return !config.apiKey.trim() && !isLocalModelEndpoint(config.baseUrl);
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

const browserAdapter: ModelAdapter = {
  async complete(payload, config, signal) {
    if (browserKeyRequired(config)) throw new Error("请先在设置中填写 API Key");
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, ...config.headers },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(config.timeoutMs),
    });
    return parseJsonResponse(response, "模型服务");
  },

  async list(config) {
    const baseUrl = config.baseUrl.trim();
    if (!baseUrl) throw new Error("请先填写模型服务 API 地址");
    if (browserKeyRequired(config)) throw new Error("请先在设置中填写 API Key");
    const response = await fetch(modelsEndpoint(baseUrl), {
      headers: modelListHeaders(config),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const models = normalizeModelList(await parseJsonResponse(response, "模型列表请求"));
    if (!models.length) throw new Error("上游未返回可识别的模型列表");
    return models;
  },

  async draft(request, config) {
    const payload = await this.complete(request.payload, config) as { choices?: Array<{ message?: { content?: string } }> };
    return {
      blockId: request.blockId,
      before: request.before,
      after: payload.choices?.[0]?.message?.content ?? "",
      instruction: request.instruction,
    };
  },

  async streamDraft(request, config, onUpdate) {
    if (browserKeyRequired(config)) throw new Error("请先在设置中填写 API Key");
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, ...config.headers },
      body: JSON.stringify({ ...request.payload, stream: true }),
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
        if (!data || data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data).choices?.[0]?.delta?.content ?? "";
          if (chunk) { after += chunk; onUpdate(chunk); }
        } catch {
          // Ignore incomplete or provider-specific SSE frames.
        }
      }
    }
    return { blockId: request.blockId, before: request.before, after, instruction: request.instruction };
  },
};

const tauriAdapter: ModelAdapter = {
  complete(payload, config) {
    return invoke("agent_completion", { config, payload });
  },

  async list(config) {
    const models = normalizeModelList(await invoke<unknown>("list_models", { config }));
    if (!models.length) throw new Error("上游未返回可识别的模型列表");
    return models;
  },

  draft(request, config) {
    return invoke("generate_text", {
      blockId: request.blockId,
      config,
      payload: request.payload,
      instruction: request.instruction,
      before: request.before,
    });
  },

  async streamDraft(request, config, onUpdate) {
    const runId = crypto.randomUUID();
    const unlisten = await listen<{ runId: string; content: string }>("session://ai", event => {
      if (event.payload.runId === runId) onUpdate(event.payload.content);
    });
    try {
      return await invoke<AiDraft>("generate_text_stream", {
        runId,
        blockId: request.blockId,
        config,
        payload: request.payload,
        instruction: request.instruction,
        before: request.before,
      });
    } finally {
      unlisten();
    }
  },
};

function adapter(): ModelAdapter {
  return isDesktop() ? tauriAdapter : browserAdapter;
}

function ensureEnabled(config: OpenAICompatibleConfig): void {
  if (!config.enabled) throw new Error("当前项目已禁用联网 AI");
  if (!config.baseUrl.trim()) throw new Error("请先填写模型服务 API 地址");
}

function draftRequest(block: DocumentBlock, instruction: string, context: string[], stream: boolean): DraftRequest {
  return {
    blockId: block.id,
    before: block.content,
    instruction,
    payload: {
      model: undefined,
      messages: [
        { role: "system", content: "你是软件技术方案编辑。只返回修改后的正文，不解释，不添加 Markdown 围栏。" },
        { role: "user", content: `编辑要求：${instruction}\n\n参考上下文：\n${context.join("\n---\n")}\n\n待修改内容：\n${block.content}` },
      ],
      stream,
    },
  };
}

export async function agentCompletion(payload: Record<string, unknown>, config: OpenAICompatibleConfig, signal?: AbortSignal): Promise<unknown> {
  ensureEnabled(config);
  return adapter().complete(payload, config, signal);
}

export async function listModels(config: OpenAICompatibleConfig): Promise<ModelOption[]> {
  return adapter().list(config);
}

export async function improveBlock(block: DocumentBlock, instruction: string, context: string[], config: OpenAICompatibleConfig): Promise<AiDraft> {
  ensureEnabled(config);
  const request = draftRequest(block, instruction, context, false);
  request.payload.model = config.model;
  return adapter().draft(request, config);
}

export async function improveBlockStream(block: DocumentBlock, instruction: string, context: string[], config: OpenAICompatibleConfig, onUpdate: StreamUpdate): Promise<AiDraft> {
  ensureEnabled(config);
  const request = draftRequest(block, instruction, context, true);
  request.payload.model = config.model;
  return adapter().streamDraft(request, config, onUpdate);
}
