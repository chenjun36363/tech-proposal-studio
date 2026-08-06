import type { LlmProtocol, LlmProvider, ModelOption, SelectedModel } from "../../core/types";
import { LEGACY_PROVIDER_ID } from "./resolve";

export const LLM_PROTOCOL_LABELS: Record<LlmProtocol, string> = {
  "openai-completions": "OpenAI Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Google Gemini",
};

export type ProviderPreset = {
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  defaultModel?: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { name: "OpenAI Responses", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4.1-mini" },
  { name: "OpenAI Completions", protocol: "openai-completions", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4.1-mini" },
  { name: "Anthropic", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-5" },
  { name: "Google Gemini", protocol: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-2.0-flash" },
];

export function createDefaultProvider(id = crypto.randomUUID()): LlmProvider {
  const preset = PROVIDER_PRESETS[0];
  return {
    id,
    name: preset.name,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    apiKey: "",
    timeoutMs: 60000,
    headers: {},
    enabled: true,
    reasoningEffort: "off",
    activeModels: preset.defaultModel ? [preset.defaultModel] : [],
    catalog: preset.defaultModel ? [{ id: preset.defaultModel, displayName: preset.defaultModel }] : [],
  };
}

export function createDefaultSelection(provider: LlmProvider): SelectedModel | null {
  const model = provider.activeModels[0];
  return model ? { providerId: provider.id, model } : null;
}

export function defaultProvidersAndSelection(): { providers: LlmProvider[]; selectedModel: SelectedModel | null } {
  const provider = createDefaultProvider(LEGACY_PROVIDER_ID === "legacy-default" ? crypto.randomUUID() : crypto.randomUUID());
  // Stable-ish default for new projects: use random id (not legacy-default, reserved for migration).
  return {
    providers: [provider],
    selectedModel: createDefaultSelection(provider),
  };
}

export function catalogFromActive(activeModels: string[], existing?: ModelOption[]): ModelOption[] {
  const byId = new Map((existing ?? []).map(item => [item.id, item]));
  return activeModels.map(id => byId.get(id) ?? { id, displayName: id });
}
