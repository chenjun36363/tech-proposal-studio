import type { ModelOption, OpenAICompatibleConfig } from "../../core/types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function firstString(value: UnknownRecord, keys: string[]): string {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return "";
}

function modelItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = asRecord(payload);
  if (!root) return [];
  for (const key of ["data", "models", "modelList"]) {
    if (Array.isArray(root[key])) return root[key];
  }
  return [];
}

/** Normalize common OpenAI-compatible, Anthropic, Ollama and gateway list shapes. */
export function normalizeModelList(payload: unknown): ModelOption[] {
  const seen = new Set<string>();
  const result: ModelOption[] = [];
  for (const item of modelItems(payload)) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        result.push({ id, displayName: id });
      }
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    const id = firstString(record, ["id", "model", "model_name", "name"]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = firstString(record, ["display_name", "displayName", "name", "model_name"]) || id;
    const ownedBy = firstString(record, ["owned_by", "ownedBy", "provider"]);
    result.push(ownedBy ? { id, displayName, ownedBy } : { id, displayName });
  }
  return result;
}

export function modelsEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return /\/models$/i.test(base) ? base : `${base}/models`;
}

export function isLocalModelEndpoint(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return /(?:localhost|127\.0\.0\.1|\[::1\]|::1)/i.test(baseUrl);
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase());
}

function isAnthropicEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return /https?:\/\/api\.anthropic\.com(?:[/:]|$)/i.test(baseUrl);
  }
}

/** Add the standard auth only when the caller did not provide an explicit header. */
export function modelListHeaders(config: OpenAICompatibleConfig): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json", ...config.headers };
  if (!config.apiKey || hasHeader(headers, "authorization") || hasHeader(headers, "x-api-key")) return headers;
  if (isAnthropicEndpoint(config.baseUrl)) {
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}
