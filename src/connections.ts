import type { ConnectionSettings, OpenAICompatibleConfig, Project, SearchConfig } from "./types";
import { createProject } from "./data";
import { isDesktop } from "./services";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile, writeTextFile } from "./workspace";

const BROWSER_CONNECTIONS_KEY = "tech-proposal-studio.connections.v1";

export function connectionsFilePath(root: string): string {
  const base = root.replace(/[\\/]+$/, "");
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base}${sep}.gouan${sep}connections.json`;
}

function defaults(): ConnectionSettings {
  const base = createProject();
  return { model: { ...base.model }, search: { ...base.search } };
}

function normalizeModel(raw: Partial<OpenAICompatibleConfig> | undefined): OpenAICompatibleConfig {
  const d = defaults().model;
  return {
    baseUrl: typeof raw?.baseUrl === "string" ? raw.baseUrl : d.baseUrl,
    apiKey: typeof raw?.apiKey === "string" ? raw.apiKey : "",
    model: typeof raw?.model === "string" ? raw.model : d.model,
    timeoutMs: typeof raw?.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : d.timeoutMs,
    headers: raw?.headers && typeof raw.headers === "object" ? { ...raw.headers } : {},
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : d.enabled,
  };
}

function normalizeSearch(raw: Partial<SearchConfig> | undefined): SearchConfig {
  const d = defaults().search;
  const provider = raw?.provider === "brave" || raw?.provider === "searxng" ? raw.provider : d.provider;
  return {
    provider,
    endpoint: typeof raw?.endpoint === "string" ? raw.endpoint : d.endpoint,
    apiKey: typeof raw?.apiKey === "string" ? raw.apiKey : "",
  };
}

export function normalizeConnections(raw: unknown): ConnectionSettings {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Partial<ConnectionSettings>;
  return {
    model: normalizeModel(obj.model),
    search: normalizeSearch(obj.search),
  };
}

export function connectionsFromProject(project: Project): ConnectionSettings {
  return {
    model: { ...project.model, headers: { ...project.model.headers } },
    search: { ...project.search },
  };
}

export function applyConnections(project: Project, conn: ConnectionSettings | null | undefined): Project {
  if (!conn) return project;
  const next = normalizeConnections(conn);
  return {
    ...project,
    model: next.model,
    search: next.search,
  };
}

function loadBrowserConnections(): ConnectionSettings | null {
  try {
    const raw = localStorage.getItem(BROWSER_CONNECTIONS_KEY);
    if (!raw) return null;
    return normalizeConnections(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveBrowserConnections(conn: ConnectionSettings) {
  localStorage.setItem(BROWSER_CONNECTIONS_KEY, JSON.stringify(normalizeConnections(conn)));
}

export async function loadWorkspaceConnections(root?: string): Promise<ConnectionSettings | null> {
  if (root && isDesktop()) {
    try {
      const text = await readTextFile(connectionsFilePath(root));
      if (!text.trim()) return null;
      return normalizeConnections(JSON.parse(text));
    } catch {
      // missing file is fine
    }
  }
  if (!isDesktop()) return loadBrowserConnections();
  return null;
}

export async function saveWorkspaceConnections(root: string | undefined, conn: ConnectionSettings): Promise<string | void> {
  const normalized = normalizeConnections(conn);
  if (root && isDesktop()) {
    const path = connectionsFilePath(root);
    await writeTextFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
    return path;
  }
  if (!isDesktop()) {
    saveBrowserConnections(normalized);
  }
}

/** Mirror secrets into OS keyring as a secondary source for Rust generate_text fallback. */
export async function syncConnectionSecrets(conn: ConnectionSettings): Promise<void> {
  if (!isDesktop()) return;
  try {
    if (conn.model.apiKey) {
      await invoke("store_secret", { name: "openai-api-key", value: conn.model.apiKey });
    }
    if (conn.search.apiKey) {
      await invoke("store_secret", { name: "search-api-key", value: conn.search.apiKey });
    }
  } catch {
    /* keyring optional */
  }
}
