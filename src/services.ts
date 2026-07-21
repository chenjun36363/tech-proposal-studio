import { invoke } from "@tauri-apps/api/core";
import type { AiDraft, DocumentBlock, OpenAICompatibleConfig, Project, SearchConfig, SearchResult } from "./types";

const inTauri = () => "__TAURI_INTERNALS__" in window;
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
    const r = await fetch(`${config.endpoint.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`);
    const j = await r.json(); return (j.results ?? []).slice(0, 8).map((x: any) => ({ title: x.title, url: x.url, excerpt: x.content ?? "" }));
  }
  const r = await fetch(`${config.endpoint || "https://api.search.brave.com/res/v1/web/search"}?q=${encodeURIComponent(query)}`, { headers: { "X-Subscription-Token": config.apiKey } });
  const j = await r.json(); return (j.web?.results ?? []).slice(0, 8).map((x: any) => ({ title: x.title, url: x.url, excerpt: x.description ?? "" }));
}
export async function saveMarkdown(project: Project, markdown: string) { if (inTauri()) return invoke("save_markdown", { projectName: project.name, markdown }); const blob = new Blob([markdown], { type: "text/markdown" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${project.name}.md`; a.click(); URL.revokeObjectURL(a.href); }
