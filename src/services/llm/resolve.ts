import type {
  LlmProvider,
  LlmProtocol,
  OpenAICompatibleConfig,
  ResolvedModelConfig,
  SelectedModel,
} from "../../core/types";

export const LEGACY_PROVIDER_ID = "legacy-default";
export const MODEL_VALUE_SEP = "::";

const PROTOCOLS: LlmProtocol[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

export function isLlmProtocol(value: unknown): value is LlmProtocol {
  return typeof value === "string" && (PROTOCOLS as string[]).includes(value);
}

export function encodeModelValue(providerId: string, model: string): string {
  return `${providerId}${MODEL_VALUE_SEP}${model}`;
}

export function parseModelValue(value: string): SelectedModel | null {
  const sep = value.indexOf(MODEL_VALUE_SEP);
  if (sep <= 0) return null;
  const providerId = value.slice(0, sep).trim();
  const model = value.slice(sep + MODEL_VALUE_SEP.length).trim();
  if (!providerId || !model) return null;
  return { providerId, model };
}

export function toOpenAICompatible(resolved: ResolvedModelConfig): OpenAICompatibleConfig {
  return {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model: resolved.model,
    timeoutMs: resolved.timeoutMs,
    headers: { ...resolved.headers },
    enabled: resolved.enabled,
  };
}

/** Treat a legacy flat config as openai-completions (tests / transitional call sites). */
export function resolvedFromLegacy(config: OpenAICompatibleConfig, providerId = LEGACY_PROVIDER_ID): ResolvedModelConfig {
  return {
    providerId,
    providerName: "Default",
    protocol: "openai-completions",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.timeoutMs,
    headers: { ...config.headers },
    enabled: config.enabled,
  };
}

export function resolveActiveModelConfig(
  providers: LlmProvider[],
  selection: SelectedModel | null | undefined,
  options?: { requireActive?: boolean; aiEnabled?: boolean },
): ResolvedModelConfig {
  const requireActive = options?.requireActive !== false;
  const aiEnabled = options?.aiEnabled !== false;
  if (!aiEnabled) {
    throw new Error("当前项目已禁用联网 AI");
  }
  if (!selection?.providerId || !selection.model?.trim()) {
    throw new Error("请先在设置中选择模型");
  }
  const provider = providers.find(item => item.id === selection.providerId);
  if (!provider) throw new Error("所选模型供应商不存在，请重新选择");
  if (!provider.enabled) throw new Error(`供应商「${provider.name}」已禁用`);
  if (!provider.baseUrl.trim()) throw new Error(`请先填写供应商「${provider.name}」的 API 地址`);
  if (
    requireActive &&
    provider.activeModels.length &&
    !provider.activeModels.includes(selection.model) &&
    !(provider.catalog?.some(catalog => catalog.id === selection.model))
  ) {
    throw new Error(`模型「${selection.model}」未在供应商「${provider.name}」中启用`);
  }
  return {
    providerId: provider.id,
    providerName: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: selection.model,
    timeoutMs: provider.timeoutMs,
    headers: { ...provider.headers },
    // Keep provider availability separate from the project-level AI master switch.
    enabled: true,
  };
}

/**
 * 解析主模型 + 一组备用模型的候选链（按数组顺序，首个为主模型）。
 * 主模型解析失败（未选择/供应商禁用等）会直接抛出，与 resolveActiveModelConfig 行为一致。
 * 单个备用模型若解析失败（如供应商不存在），会被静默跳过，避免一个坏配置阻断整条链。
 * 与主模型重复的备用项会被去重。
 */
export function resolveModelConfigChain(
  providers: LlmProvider[],
  selection: SelectedModel | null | undefined,
  fallbacks: SelectedModel[] | undefined | null,
  options?: { requireActive?: boolean; aiEnabled?: boolean },
): ResolvedModelConfig[] {
  const primary = resolveActiveModelConfig(providers, selection, options);
  const chain: ResolvedModelConfig[] = [primary];
  const seen = new Set<string>([`${primary.providerId}::${primary.model}`]);
  for (const fallback of fallbacks ?? []) {
    try {
      const resolved = resolveActiveModelConfig(providers, fallback, { requireActive: false, aiEnabled: options?.aiEnabled });
      const key = `${resolved.providerId}::${resolved.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chain.push(resolved);
    } catch {
      // 跳过无法解析的备用模型，不阻断主流程。
    }
  }
  return chain;
}

/** Soft resolve for UI: returns null instead of throwing. */
export function tryResolveActiveModelConfig(
  providers: LlmProvider[],
  selection: SelectedModel | null | undefined,
  options?: { requireActive?: boolean; aiEnabled?: boolean },
): ResolvedModelConfig | null {
  try {
    return resolveActiveModelConfig(providers, selection, { requireActive: false, ...options });
  } catch {
    return null;
  }
}

export function deriveModelSnapshot(
  providers: LlmProvider[],
  selection: SelectedModel | null | undefined,
  fallback?: OpenAICompatibleConfig,
): OpenAICompatibleConfig {
  // Project-level master switch lives on model.enabled and must survive provider edits.
  const aiEnabled = typeof fallback?.enabled === "boolean" ? fallback.enabled : true;
  const resolved = tryResolveActiveModelConfig(providers, selection, { aiEnabled: true });
  if (resolved) {
    return { ...toOpenAICompatible(resolved), enabled: aiEnabled };
  }
  if (fallback) return { ...fallback, headers: { ...fallback.headers }, enabled: aiEnabled };
  const first = providers.find(p => p.enabled) ?? providers[0];
  if (first) {
    return {
      baseUrl: first.baseUrl,
      apiKey: first.apiKey,
      model: first.activeModels[0] ?? "",
      timeoutMs: first.timeoutMs,
      headers: { ...first.headers },
      enabled: aiEnabled,
    };
  }
  return {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4.1-mini",
    timeoutMs: 60000,
    headers: {},
    enabled: aiEnabled,
  };
}

/** Pick a valid selection after enabling/disabling providers. */
export function repairSelectionForProviders(
  providers: LlmProvider[],
  selection: SelectedModel | null | undefined,
): SelectedModel | null {
  if (selection?.providerId && selection.model) {
    const provider = providers.find(item => item.id === selection.providerId);
    if (provider?.enabled) {
      if (!provider.activeModels.length || provider.activeModels.includes(selection.model)) {
        return { providerId: provider.id, model: selection.model };
      }
      if (provider.activeModels[0]) {
        return { providerId: provider.id, model: provider.activeModels[0] };
      }
    }
  }
  const next = providers.find(item => item.enabled && item.activeModels[0]);
  return next ? { providerId: next.id, model: next.activeModels[0] } : null;
}
