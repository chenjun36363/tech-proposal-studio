import { invoke } from "@tauri-apps/api/core";
import type { LlmProvider, LlmProtocol } from "./types";

export interface CcSwitchProviderItem { sourceId: string; appType: string; name: string; baseUrl: string; apiKey: string; protocol: LlmProtocol; models: string[] }
export interface CcSwitchProvidersResponse { databasePath: string | null; checkedPaths: string[]; providers: CcSwitchProviderItem[] }

export async function listCcSwitchProviders(): Promise<CcSwitchProvidersResponse> { return invoke("list_ccswitch_providers"); }

function identity(provider: Pick<LlmProvider, "protocol" | "name" | "baseUrl">): string {
  return `${provider.protocol}\n${provider.name.replace(/[（(]ccswitch[）)]/i, "").trim().toLowerCase()}\n${provider.baseUrl.trim().replace(/\/+$/, "").toLowerCase()}`;
}

export function ccSwitchItemKey(item: CcSwitchProviderItem): string { return `${item.appType}:${item.sourceId}`; }
export function isCcSwitchItemImportable(item: CcSwitchProviderItem): boolean { return Boolean(item.models.length || (item.baseUrl.trim() && item.apiKey.trim())); }
export function isCcSwitchItemImported(item: CcSwitchProviderItem, providers: LlmProvider[]): boolean {
  return providers.some(provider => identity(provider) === identity({ protocol: item.protocol, name: item.name, baseUrl: item.baseUrl }));
}

export function mergeCcSwitchProviders(existing: LlmProvider[], items: CcSwitchProviderItem[]): { providers: LlmProvider[]; imported: number } {
  const next = [...existing];
  const ids = new Set(next.map(provider => provider.id));
  let imported = 0;
  for (const item of items) {
    if (!isCcSwitchItemImportable(item) || isCcSwitchItemImported(item, next)) continue;
    const stem = `ccswitch-${item.appType}-${item.sourceId}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ccswitch-provider";
    let id = stem;
    for (let index = 2; ids.has(id); index += 1) id = `${stem}-${index}`;
    ids.add(id);
    next.push({ id, name: `${item.name.replace(/[（(]ccswitch[）)]/i, "").trim()}（CCSwitch）`, protocol: item.protocol, baseUrl: item.baseUrl, apiKey: item.apiKey, timeoutMs: 60000, headers: {}, enabled: true, activeModels: [...item.models], catalog: item.models.map(model => ({ id: model, displayName: model })) });
    imported += 1;
  }
  return { providers: next, imported };
}
