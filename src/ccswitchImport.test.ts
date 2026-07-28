import { describe, expect, it } from "vitest";
import { isCcSwitchItemImportable, isCcSwitchItemImported, mergeCcSwitchProviders, type CcSwitchProviderItem } from "./ccswitchImport";

const item: CcSwitchProviderItem = { sourceId: "abc", appType: "claude", name: "Claude Proxy", baseUrl: "https://proxy.example/v1/", apiKey: "secret", protocol: "anthropic-messages", models: ["claude-sonnet-4-5"] };
describe("CCSwitch import", () => {
  it("maps a provider and its models", () => { const result = mergeCcSwitchProviders([], [item]); expect(result.imported).toBe(1); expect(result.providers[0]).toMatchObject({ id: "ccswitch-claude-abc", name: "Claude Proxy（CCSwitch）", apiKey: "secret", protocol: "anthropic-messages", activeModels: item.models }); });
  it("does not duplicate an equivalent provider", () => { const existing = mergeCcSwitchProviders([], [item]).providers[0]; expect(isCcSwitchItemImported({ ...item, name: "Claude Proxy（ccswitch）", baseUrl: "https://proxy.example/v1" }, [existing])).toBe(true); expect(mergeCcSwitchProviders([existing], [item]).imported).toBe(0); });
  it("requires models or a usable connection", () => { expect(isCcSwitchItemImportable({ ...item, models: [], apiKey: "" })).toBe(false); expect(isCcSwitchItemImportable({ ...item, models: [], apiKey: "key" })).toBe(true); expect(isCcSwitchItemImportable({ ...item, models: ["model"], apiKey: "", baseUrl: "" })).toBe(true); });
});
