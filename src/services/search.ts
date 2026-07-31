import { invoke } from "@tauri-apps/api/core";
import type { SearchConfig, SearchResult } from "../core/types";
import { isDesktop } from "./runtime";

interface SearchAdapter {
  search(query: string, config: SearchConfig): Promise<SearchResult[]>;
}

const tauriAdapter: SearchAdapter = {
  search(query, config) {
    return invoke("search_web", { query, config });
  },
};

const browserAdapter: SearchAdapter = {
  async search(query, config) {
    if (config.provider === "searxng") {
      if (!config.endpoint.trim()) throw new Error("请先配置 SearXNG 服务地址");
      const engines = config.engines?.length ? config.engines : ["baidu", "360search", "bing"];
      const params = new URLSearchParams({ q: query, format: "json", language: "zh-CN", engines: engines.join(",") });
      const response = await fetch(`${config.endpoint.replace(/\/$/, "")}/search?${params}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`搜索服务返回 ${response.status}${response.status === 0 ? "（CORS 受限或无法连接）" : ""}`);
      const payload = await response.json() as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
        unresponsive_engines?: unknown[][];
      };
      if (!(payload.results ?? []).length && payload.unresponsive_engines?.length) {
        const failures = payload.unresponsive_engines.map(item => `${item[0]}（${item[1]}）`).join("、");
        throw new Error(`上游搜索失败：${failures}`);
      }
      return (payload.results ?? []).slice(0, 12).map(item => ({
        title: item.title ?? "",
        url: item.url ?? "",
        excerpt: item.content ?? "",
      }));
    }

    const endpoint = config.endpoint.trim() || "https://api.search.brave.com/res/v1/web/search";
    const response = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, {
      headers: { "X-Subscription-Token": config.apiKey },
    });
    if (!response.ok) throw new Error(`搜索服务返回 ${response.status}`);
    const payload = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    return (payload.web?.results ?? []).slice(0, 8).map(item => ({
      title: item.title ?? "",
      url: item.url ?? "",
      excerpt: item.description ?? "",
    }));
  },
};

export async function searchWeb(query: string, config: SearchConfig): Promise<SearchResult[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  return (isDesktop() ? tauriAdapter : browserAdapter).search(normalized, config);
}
