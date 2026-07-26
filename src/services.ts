import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AiDraft, CommandPreset, CommandResult, DocumentBlock, ModelOption, OpenAICompatibleConfig, Project, SearchConfig, SearchResult } from "./types";
import { isLocalModelEndpoint, modelListHeaders, modelsEndpoint, normalizeModelList } from "./modelCatalog";

const inTauri = () => "__TAURI_INTERNALS__" in window;
export const isDesktop = () => inTauri();
export async function listModels(config: OpenAICompatibleConfig): Promise<ModelOption[]> {
  const baseUrl = config.baseUrl.trim();
  if (!baseUrl) throw new Error("请先填写模型服务 API 地址");
  if (inTauri()) {
    const payload = await invoke<unknown>("list_models", { config });
    const models = normalizeModelList(payload);
    if (!models.length) throw new Error("上游未返回可识别的模型列表");
    return models;
  }
  if (!config.apiKey.trim() && !isLocalModelEndpoint(baseUrl)) throw new Error("请先在设置中填写 API Key");
  const response = await fetch(modelsEndpoint(baseUrl), {
    headers: modelListHeaders(config),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text.trim()) {
    try { payload = JSON.parse(text); } catch { throw new Error("上游模型列表不是有效 JSON"); }
  }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "error" in payload
      ? (payload.error as { message?: unknown })?.message
      : undefined;
    throw new Error(`模型列表请求返回 ${response.status}${typeof detail === "string" && detail ? `：${detail}` : ""}`);
  }
  const models = normalizeModelList(payload);
  if (!models.length) throw new Error("上游未返回可识别的模型列表");
  return models;
}
export async function improveBlock(block: DocumentBlock, instruction: string, context: string[], config: OpenAICompatibleConfig): Promise<AiDraft> {
  if (!config.enabled) throw new Error("当前项目已禁用联网 AI");
  if (!config.apiKey && !config.baseUrl.includes("localhost")) throw new Error("请先在设置中填写 API Key");
  const payload = { model: config.model, messages: [
    { role: "system", content: "你是软件技术方案编辑。只返回修改后的正文，不解释，不添加 Markdown 围栏。" },
    { role: "user", content: `编辑要求：${instruction}\n\n参考上下文：\n${context.join("\n---\n")}\n\n待修改内容：\n${block.content}` }
  ], stream: false };
  if (inTauri()) return invoke("generate_text", { blockId: block.id, config, payload, instruction, before: block.content });
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, ...config.headers }, body: JSON.stringify(payload), signal: AbortSignal.timeout(config.timeoutMs) });
  if (!response.ok) throw new Error(`模型服务返回 ${response.status}`);
  const json = await response.json();
  return { blockId: block.id, before: block.content, after: json.choices?.[0]?.message?.content ?? "", instruction };
}
export async function searchWeb(query: string, config: SearchConfig): Promise<SearchResult[]> {
  if (!config.endpoint) throw new Error("请先配置搜索服务地址");
  if (inTauri()) return invoke("search_web", { query, config });
  if (config.provider === "searxng") {
    const engines = config.engines?.length ? config.engines : ["baidu", "360search", "bing"];
    const params = new URLSearchParams({ q: query, format: "json", language: "zh-CN", engines: engines.join(",") });
    const r = await fetch(`${config.endpoint.replace(/\/$/, "")}/search?${params}`, {
      headers: { "Accept": "application/json" },
    });
    if (!r.ok) throw new Error(`搜索服务返回 ${r.status}${r.status === 0 ? "（CORS 受限或无法连接）" : ""}`);
    const j = await r.json();
    if (!(j.results ?? []).length && j.unresponsive_engines?.length) {
      throw new Error(`上游搜索失败：${j.unresponsive_engines.map((item: unknown[]) => `${item[0]}（${item[1]}）`).join("、")}`);
    }
    return (j.results ?? []).slice(0, 12).map((x: any) => ({ title: x.title, url: x.url, excerpt: x.content ?? "" }));
  }
  const r = await fetch(`${config.endpoint || "https://api.search.brave.com/res/v1/web/search"}?q=${encodeURIComponent(query)}`, { headers: { "X-Subscription-Token": config.apiKey } });
  const j = await r.json(); return (j.web?.results ?? []).slice(0, 8).map((x: any) => ({ title: x.title, url: x.url, excerpt: x.description ?? "" }));
}
type StreamUpdate = (content: string) => void;
async function streamModel(blockId: string, before: string, instruction: string, payload: Record<string, unknown>, config: OpenAICompatibleConfig, onUpdate: StreamUpdate): Promise<AiDraft> {
  const runId = crypto.randomUUID();
  if (inTauri()) {
    const unlisten = await listen<{ runId: string; content: string }>("session://ai", event => {
      if (event.payload.runId === runId) onUpdate(event.payload.content);
    });
    try { return await invoke<AiDraft>("generate_text_stream", { runId, blockId, config, payload, instruction, before }); }
    finally { unlisten(); }
  }
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, ...config.headers }, body: JSON.stringify({ ...payload, stream: true }), signal: AbortSignal.timeout(config.timeoutMs) });
  if (!response.ok) throw new Error(`模型服务返回 ${response.status}`);
  if (!response.body) throw new Error("模型服务未返回可读取的内容流");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ""; let after = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : ""; if (!data || data === "[DONE]") continue;
      try { const chunk = JSON.parse(data).choices?.[0]?.delta?.content ?? ""; if (chunk) { after += chunk; onUpdate(chunk); } } catch { /* wait for the next valid SSE frame */ }
    }
  }
  return { blockId, before, after, instruction };
}
export async function improveBlockStream(block: DocumentBlock, instruction: string, context: string[], config: OpenAICompatibleConfig, onUpdate: StreamUpdate): Promise<AiDraft> {
  if (!config.enabled) throw new Error("当前项目已禁用联网 AI");
  if (!config.apiKey && !config.baseUrl.includes("localhost")) throw new Error("请先在设置中填写 API Key");
  const payload = { model: config.model, messages: [
    { role: "system", content: "你是软件技术方案编辑。只返回修改后的正文，不解释，不添加 Markdown 围栏。" },
    { role: "user", content: `编辑要求：${instruction}\n\n参考上下文：\n${context.join("\n---\n")}\n\n待修改内容：\n${block.content}` },
  ] };
  return streamModel(block.id, block.content, instruction, payload, config, onUpdate);
}
export async function openExternalUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url.trim())) throw new Error("仅允许打开 http/https 来源链接");
  if (inTauri()) {
    await invoke("open_external_url", { url: url.trim() });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
export async function saveMarkdown(project: Project, markdown: string) { if (inTauri()) return invoke("save_markdown", { projectName: project.name, markdown }); const blob = new Blob([markdown], { type: "text/markdown" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${project.name}.md`; a.click(); URL.revokeObjectURL(a.href); }
export async function runCommand(preset: CommandPreset): Promise<CommandResult> {
  if (!inTauri()) throw new Error("请在 Tauri 桌面端运行此任务");
  return invoke<CommandResult>("run_command", {
    preset: {
      program: preset.program,
      args: preset.args,
      cwd: preset.cwd || ".",
      timeoutMs: preset.timeoutMs,
      allowShell: preset.allowShell,
      stdin: preset.stdin,
    },
  });
}

export async function detectTools(): Promise<Record<string, string>> {
  if (!inTauri()) return {};
  return invoke<Record<string, string>>("detect_tools");
}

export async function terminalOpen(cols: number, rows: number, cwd = "."): Promise<number> {
  if (!inTauri()) throw new Error("请在 Tauri 桌面端使用终端");
  return invoke<number>("terminal_open", { cols, rows, cwd });
}

export async function terminalWrite(id: number, data: string): Promise<void> {
  if (!inTauri()) throw new Error("请在 Tauri 桌面端使用终端");
  await invoke("terminal_write", { id, data });
}

export async function terminalResize(id: number, cols: number, rows: number): Promise<void> {
  if (!inTauri()) return;
  await invoke("terminal_resize", { id, cols, rows });
}

export async function terminalClose(id: number): Promise<void> {
  if (!inTauri()) return;
  await invoke("terminal_close", { id });
}
export async function runCommandStream(preset: CommandPreset, onUpdate: (channel: "stdout" | "stderr", content: string) => void): Promise<CommandResult> {
  if (!inTauri()) throw new Error("请在 Tauri 桌面端运行此任务");
  const runId = crypto.randomUUID();
  const unlisten = await listen<{ runId: string; channel: "stdout" | "stderr"; content: string }>("session://command", event => {
    if (event.payload.runId === runId) onUpdate(event.payload.channel, event.payload.content);
  });
  try { return await invoke<CommandResult>("run_command_stream", { runId, preset: { program: preset.program, args: preset.args, cwd: preset.cwd || ".", timeoutMs: preset.timeoutMs, allowShell: preset.allowShell, stdin: preset.stdin } }); }
  finally { unlisten(); }
}

export async function openWorkspacePowerShell(cwd: string): Promise<void> {
  if (!inTauri()) throw new Error("请在 Tauri 桌面端打开 PowerShell");
  await invoke("open_workspace_powershell", { cwd });
}
