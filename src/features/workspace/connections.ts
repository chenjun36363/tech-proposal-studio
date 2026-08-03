import type {
  ConnectionSettings,
  LlmProvider,
  LlmProtocol,
  MinerUConfig,
  ModelOption,
  OpenAICompatibleConfig,
  Project,
  SearchConfig,
  SelectedModel,
} from "../../core/types";
import { createProject, makeId } from "../../core/data";
import { isDesktop } from "../../services/runtime";
import { invoke } from "@tauri-apps/api/core";
import { isLlmProtocol, deriveModelSnapshot, LEGACY_PROVIDER_ID } from "../../services/llm/resolve";
import { createDefaultProvider, createDefaultSelection } from "../../services/llm/defaults";

const BROWSER_CONNECTIONS_KEY = "tech-proposal-studio.connections.v1";

export function connectionsFilePath(root: string): string {
  const base = root.replace(/[\\/]+$/, "");
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base}${sep}.gouan${sep}connections.json`;
}

export function sameWorkspaceRoot(left?: string, right?: string): boolean {
  const normalize = (value?: string) => (value ?? "")
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\//g, "\\")
    .toLowerCase();
  return normalize(left) === normalize(right);
}

function defaults(): ConnectionSettings {
  const base = createProject();
  return {
    version: 2,
    providers: base.providers.map(p => ({ ...p, headers: { ...p.headers }, activeModels: [...p.activeModels], catalog: p.catalog?.map(c => ({ ...c })) })),
    selectedModel: base.selectedModel ? { ...base.selectedModel } : null,
    model: { ...base.model, headers: { ...base.model.headers } },
    search: { ...base.search, engines: [...(base.search.engines ?? [])] },
    mineru: { ...base.mineru },
  };
}

function stripEndpointSuffix(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "");
  const suffixes = [
    /\/chat\/completions$/i,
    /\/responses$/i,
    /\/response$/i,
    /\/messages$/i,
    /\/models$/i,
    /:streamGenerateContent$/i,
    /:generateContent$/i,
  ];
  for (const re of suffixes) {
    if (re.test(url)) url = url.replace(re, "").replace(/\/+$/, "");
  }
  return url;
}

function inferProtocol(baseUrl: string): LlmProtocol {
  const lower = baseUrl.toLowerCase();
  if (lower.includes("api.anthropic.com")) return "anthropic-messages";
  if (lower.includes("generativelanguage.googleapis.com")) return "google-generative-ai";
  if (/\/responses(?:\/|$)/i.test(baseUrl)) return "openai-responses";
  return "openai-completions";
}

function inferProviderName(baseUrl: string, protocol: LlmProtocol): string {
  try {
    const host = new URL(baseUrl).hostname;
    if (host && host !== "localhost") return host;
  } catch { /* ignore */ }
  if (protocol === "anthropic-messages") return "Anthropic";
  if (protocol === "google-generative-ai") return "Google Gemini";
  if (protocol === "openai-responses") return "OpenAI Responses";
  return "默认模型";
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
    engines: Array.isArray(raw?.engines) && raw.engines.length
      ? raw.engines.filter(engine => typeof engine === "string" && engine.trim()).map(engine => engine.trim())
      : [...(d.engines ?? ["baidu", "360search", "bing"])],
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeMineru(raw: Partial<MinerUConfig> | undefined | null): MinerUConfig {
  const d = defaults().mineru;
  const modelVersion = typeof raw?.modelVersion === "string" && raw.modelVersion.trim()
    ? raw.modelVersion.trim()
    : d.modelVersion;
  return {
    baseUrl: typeof raw?.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : d.baseUrl,
    apiKey: typeof raw?.apiKey === "string" ? raw.apiKey : "",
    modelVersion,
    language: typeof raw?.language === "string" && raw.language.trim() ? raw.language.trim() : d.language,
    isOcr: typeof raw?.isOcr === "boolean" ? raw.isOcr : d.isOcr,
    enableTable: typeof raw?.enableTable === "boolean" ? raw.enableTable : d.enableTable,
    enableFormula: typeof raw?.enableFormula === "boolean" ? raw.enableFormula : d.enableFormula,
    timeoutSeconds: clampInt(raw?.timeoutSeconds, d.timeoutSeconds, 30, 1800),
    pollIntervalSeconds: clampInt(raw?.pollIntervalSeconds, d.pollIntervalSeconds, 1, 30),
  };
}

function normalizeCatalog(raw: unknown): ModelOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: ModelOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string" && item.trim() && !seen.has(item.trim())) {
      seen.add(item.trim());
      result.push({ id: item.trim(), displayName: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = typeof rec.displayName === "string" && rec.displayName.trim() ? rec.displayName.trim() : id;
    const ownedBy = typeof rec.ownedBy === "string" && rec.ownedBy.trim() ? rec.ownedBy.trim() : undefined;
    result.push(ownedBy ? { id, displayName, ownedBy } : { id, displayName });
  }
  return result.length ? result : undefined;
}

export function normalizeProvider(raw: Partial<LlmProvider> | null | undefined): LlmProvider {
  const fallback = createDefaultProvider(makeId());
  const id = typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : fallback.id;
  const protocol = isLlmProtocol(raw?.protocol) ? raw.protocol : "openai-completions";
  const baseUrl = typeof raw?.baseUrl === "string" && raw.baseUrl.trim()
    ? stripEndpointSuffix(raw.baseUrl)
    : fallback.baseUrl;
  const activeModels = Array.isArray(raw?.activeModels)
    ? raw!.activeModels.filter(m => typeof m === "string" && m.trim()).map(m => m.trim())
    : [];
  const catalog = normalizeCatalog(raw?.catalog);
  const headers = raw?.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)
    ? Object.fromEntries(Object.entries(raw.headers).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"))
    : {};
  return {
    id,
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : inferProviderName(baseUrl, protocol),
    protocol,
    baseUrl,
    apiKey: typeof raw?.apiKey === "string" ? raw.apiKey : "",
    timeoutMs: typeof raw?.timeoutMs === "number" && raw.timeoutMs > 0 ? Math.trunc(raw.timeoutMs) : 60000,
    headers,
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : true,
    activeModels,
    catalog,
  };
}

function repairSelectedModel(providers: LlmProvider[], selection: SelectedModel | null | undefined): SelectedModel | null {
  if (!providers.length) return null;
  if (selection?.providerId && selection.model) {
    const provider = providers.find(p => p.id === selection.providerId);
    if (provider) {
      if (!provider.activeModels.length || provider.activeModels.includes(selection.model)) {
        return { providerId: provider.id, model: selection.model };
      }
      if (provider.activeModels[0]) return { providerId: provider.id, model: provider.activeModels[0] };
    }
  }
  const enabled = providers.find(p => p.enabled && p.activeModels[0]) ?? providers.find(p => p.activeModels[0]) ?? providers[0];
  return createDefaultSelection(enabled);
}

function migrateV1Model(legacyRaw: Partial<OpenAICompatibleConfig> | undefined): { providers: LlmProvider[]; selectedModel: SelectedModel | null } {
  const legacy = normalizeModel(legacyRaw);
  const protocol = inferProtocol(legacy.baseUrl);
  const baseUrl = stripEndpointSuffix(legacy.baseUrl);
  const provider: LlmProvider = {
    id: LEGACY_PROVIDER_ID,
    name: inferProviderName(baseUrl, protocol),
    protocol,
    baseUrl,
    apiKey: legacy.apiKey,
    timeoutMs: legacy.timeoutMs,
    headers: { ...legacy.headers },
    enabled: legacy.enabled,
    activeModels: legacy.model ? [legacy.model] : [],
    catalog: legacy.model ? [{ id: legacy.model, displayName: legacy.model }] : undefined,
  };
  return {
    providers: [provider],
    selectedModel: legacy.model ? { providerId: LEGACY_PROVIDER_ID, model: legacy.model } : null,
  };
}

export function normalizeConnections(raw: unknown): ConnectionSettings {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const search = normalizeSearch(obj.search as Partial<SearchConfig> | undefined);
  const mineru = normalizeMineru(obj.mineru as Partial<MinerUConfig> | undefined);

  const hasProviders = Array.isArray(obj.providers);
  const isV2 = obj.version === 2 || hasProviders;

  let providers: LlmProvider[];
  let selectedModel: SelectedModel | null;

  if (isV2 && hasProviders) {
    providers = (obj.providers as unknown[]).map(item => normalizeProvider(item as Partial<LlmProvider>));
    if (!providers.length) {
      const migrated = migrateV1Model(obj.model as Partial<OpenAICompatibleConfig> | undefined);
      providers = migrated.providers;
      selectedModel = migrated.selectedModel;
    } else {
      const rawSel = obj.selectedModel && typeof obj.selectedModel === "object"
        ? obj.selectedModel as Partial<SelectedModel>
        : null;
      selectedModel = repairSelectedModel(providers, rawSel?.providerId && rawSel.model
        ? { providerId: String(rawSel.providerId), model: String(rawSel.model) }
        : null);
    }
  } else {
    const migrated = migrateV1Model(obj.model as Partial<OpenAICompatibleConfig> | undefined);
    providers = migrated.providers;
    selectedModel = migrated.selectedModel;
  }

  selectedModel = repairSelectedModel(providers, selectedModel);
  const model = deriveModelSnapshot(providers, selectedModel, normalizeModel(obj.model as Partial<OpenAICompatibleConfig> | undefined));

  return {
    version: 2,
    providers,
    selectedModel,
    model,
    search,
    mineru,
  };
}

export function connectionsFromProject(project: Project): ConnectionSettings {
  const providers = (project.providers?.length
    ? project.providers
    : migrateV1Model(project.model).providers
  ).map(p => normalizeProvider(p));
  const selectedModel = repairSelectedModel(providers, project.selectedModel ?? (
    project.model?.model ? { providerId: providers[0]?.id ?? LEGACY_PROVIDER_ID, model: project.model.model } : null
  ));
  return {
    version: 2,
    providers,
    selectedModel,
    model: deriveModelSnapshot(providers, selectedModel, project.model),
    search: { ...project.search, engines: project.search.engines ? [...project.search.engines] : undefined },
    mineru: normalizeMineru(project.mineru),
  };
}

export function applyConnections(project: Project, conn: ConnectionSettings | null | undefined): Project {
  if (!conn) return project;
  const next = normalizeConnections(conn);
  return {
    ...project,
    providers: next.providers,
    selectedModel: next.selectedModel,
    model: next.model,
    search: next.search,
    mineru: next.mineru,
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

/**
 * Reconcile empty apiKeys from the same fallback sources the Rust runtime uses at
 * call time (`fill_mineru_api_key`, model `load_secret`): OS keyring mirror + the
 * legacy `<root>/.gouan/connections.json`. This keeps the config page display
 * consistent with the supplier (model) apiKey, whose value is likewise restored
 * whenever the authoritative store is missing it. When a key is recovered we also
 * write it back so the SQLite `workspace.db` row stays authoritative (self-heal).
 */
async function reconcileConnectionSecrets(
  conn: ConnectionSettings | null,
  root?: string,
): Promise<ConnectionSettings | null> {
  if (!conn || !isDesktop() || !root) return conn;
  const workspaceRoot = root;
  let changed = false;

  const fill = async (
    current: string,
    keyringName: string,
    legacyPointer: string,
  ): Promise<string> => {
    if (current.trim()) return current;
    const fromLegacy = await readLegacyConnectionsApiKey(workspaceRoot, legacyPointer);
    if (fromLegacy) {
      changed = true;
      return fromLegacy;
    }
    const fromKeyring = await readKeyringSecret(keyringName);
    if (fromKeyring) {
      changed = true;
      return fromKeyring;
    }
    return current;
  };

  const mineruApiKey = await fill(conn.mineru.apiKey, "mineru-api-key", "/mineru/apiKey");
  const searchApiKey = await fill(conn.search.apiKey, "search-api-key", "/search/apiKey");

  const next: ConnectionSettings = {
    ...conn,
    mineru: { ...conn.mineru, apiKey: mineruApiKey },
    search: { ...conn.search, apiKey: searchApiKey },
  };

  if (changed) {
    try {
      await saveWorkspaceConnections(workspaceRoot, next);
    } catch {
      /* best-effort self-heal; display still uses the in-memory value */
    }
    return next;
  }
  return conn;
}

async function readKeyringSecret(name: string): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    const value = await invoke<string>("load_secret_value", { name });
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

async function readLegacyConnectionsApiKey(root: string, pointer: string): Promise<string | null> {
  try {
    const path = connectionsFilePath(root);
    const raw = await invoke<string>("read_text_file", { path });
    const value = JSON.parse(raw);
    const key = pointer
      .split("/")
      .filter(Boolean)
      .reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), value);
    const str = typeof key === "string" ? key.trim() : "";
    return str || null;
  } catch {
    return null;
  }
}

export async function loadWorkspaceConnections(root?: string): Promise<ConnectionSettings | null> {
  if (root && isDesktop()) {
    const payload = await invoke<unknown | null>("load_workspace_connections", { root });
    const conn = payload ? normalizeConnections(payload) : null;
    return reconcileConnectionSecrets(conn, root);
  }
  if (!isDesktop()) return loadBrowserConnections();
  return null;
}

/** Persist v2 shape only (no top-level legacy-only fields beyond derived model for readability). */
export async function saveWorkspaceConnections(root: string | undefined, conn: ConnectionSettings): Promise<string | void> {
  const normalized = normalizeConnections(conn);
  const payload = {
    version: 2 as const,
    providers: normalized.providers,
    selectedModel: normalized.selectedModel,
    search: normalized.search,
    mineru: normalized.mineru,
  };
  if (root && isDesktop()) {
    return invoke<string>("save_workspace_connections", { root, payload });
  }
  if (!isDesktop()) {
    saveBrowserConnections(normalized);
  }
}

/** Mirror secrets into OS keyring as a secondary source for Rust generate_text fallback. */
export async function syncConnectionSecrets(conn: ConnectionSettings): Promise<void> {
  if (!isDesktop()) return;
  try {
    for (const provider of conn.providers) {
      if (provider.apiKey) {
        await invoke("store_secret", { name: `llm-provider:${provider.id}`, value: provider.apiKey });
      }
    }
    const selected = conn.selectedModel
      ? conn.providers.find(p => p.id === conn.selectedModel?.providerId)
      : conn.providers[0];
    if (selected?.apiKey) {
      await invoke("store_secret", { name: "openai-api-key", value: selected.apiKey });
    }
    if (conn.search.apiKey) {
      await invoke("store_secret", { name: "search-api-key", value: conn.search.apiKey });
    }
    if (conn.mineru.apiKey) {
      await invoke("store_secret", { name: "mineru-api-key", value: conn.mineru.apiKey });
    }
  } catch {
    /* keyring optional */
  }
}

/** Persist every connection target as one transaction and return the normalized Project view. */
export async function saveProjectConnections(project: Project, root?: string): Promise<Project> {
  const connections = connectionsFromProject(project);
  await saveWorkspaceConnections(root, connections);
  await syncConnectionSecrets(connections);
  return applyConnections(project, connections);
}
