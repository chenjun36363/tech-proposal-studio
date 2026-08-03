import { describe, expect, it } from "vitest";
import { buildAgentPreferencePrompt, defaultAgentSettings, normalizeAgentSettings } from "./settings";

describe("agent settings", () => {
  it("fills missing values and clamps unsafe numeric ranges", () => {
    const settings = normalizeAgentSettings({ contextCompressionTokens: 999999, maxRounds: 999, webSearchMaxCalls: 99, recentMessages: 1, temperature: -1 });
    expect(settings.contextCompressionTokens).toBe(500000);
    expect(settings.maxRounds).toBe(50);
    expect(settings.webSearchMaxCalls).toBe(10);
    expect(settings.longWritingContextWindowTokens).toBe(32768);
    expect(settings.recentMessages).toBe(4);
    expect(settings.temperature).toBe(0);
    expect(settings.knowledgeToolsEnabled).toBe(false);
    expect(settings.webSearchEnabled).toBe(false);
    expect(settings.memoryEnabled).toBe(false);
    expect(settings.disabledTools).toEqual([]);
  });

  it("preserves disabled tool names without duplicates", () => {
    expect(normalizeAgentSettings({ disabledTools: ["web_search", "web_search", "run_powershell"] }).disabledTools)
      .toEqual(["web_search", "run_powershell"]);
  });

  it("uses the default web search limit for existing settings", () => {
    expect(normalizeAgentSettings({}).webSearchMaxCalls).toBe(2);
    expect(normalizeAgentSettings({}).maxRounds).toBe(20);
    expect(normalizeAgentSettings({ longWritingContextWindowTokens: 9999999 }).longWritingContextWindowTokens).toBe(1000000);
  });

  it("turns response and citation preferences into model instructions", () => {
    const prompt = buildAgentPreferencePrompt({ ...defaultAgentSettings, responseStyle: "concise", citationMode: "required", customInstructions: "风险使用表格。" });
    expect(prompt).toContain("回答保持简洁");
    expect(prompt).toContain("必须标注来源标题");
    expect(prompt).toContain("风险使用表格");
  });
});
