import { describe, expect, it } from "vitest";
import { buildAgentPreferencePrompt, defaultAgentSettings, normalizeAgentSettings } from "./settings";

describe("agent settings", () => {
  it("fills missing values and clamps unsafe numeric ranges", () => {
    const settings = normalizeAgentSettings({ contextCompressionTokens: 999999, webSearchMaxCalls: 99, recentMessages: 1, temperature: -1 });
    expect(settings.contextCompressionTokens).toBe(200000);
    expect(settings.webSearchMaxCalls).toBe(10);
    expect(settings.recentMessages).toBe(4);
    expect(settings.temperature).toBe(0);
    expect(settings.knowledgeToolsEnabled).toBe(true);
  });

  it("uses the default web search limit for existing settings", () => {
    expect(normalizeAgentSettings({}).webSearchMaxCalls).toBe(2);
  });

  it("turns response and citation preferences into model instructions", () => {
    const prompt = buildAgentPreferencePrompt({ ...defaultAgentSettings, responseStyle: "concise", citationMode: "required", customInstructions: "风险使用表格。" });
    expect(prompt).toContain("回答保持简洁");
    expect(prompt).toContain("必须标注来源标题");
    expect(prompt).toContain("风险使用表格");
  });
});
