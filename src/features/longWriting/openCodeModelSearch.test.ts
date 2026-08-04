import { describe, expect, it } from "vitest";
import type { OpenCodeModelOption } from "./opencodeService";
import { filterOpenCodeModels } from "./openCodeModelSearch";

const models: OpenCodeModelOption[] = [
  { providerId: "openai", providerName: "OpenAI", modelId: "gpt-5.2-codex", modelName: "GPT 5.2 Codex", isDefault: true },
  { providerId: "deepseek", providerName: "DeepSeek", modelId: "deepseek-chat", modelName: "DeepSeek V3", isDefault: false },
];

describe("filterOpenCodeModels", () => {
  it.each([
    ["OPENAI", "gpt-5.2-codex"],
    ["v3", "deepseek-chat"],
    ["GPT-5.2", "gpt-5.2-codex"],
  ])("searches provider, model name, and model id case-insensitively", (query, expectedId) => {
    expect(filterOpenCodeModels(models, query, null).map(model => model.modelId)).toEqual([expectedId]);
  });

  it("keeps the selected model available when it does not match the query", () => {
    expect(filterOpenCodeModels(models, "deepseek", { providerId: "openai", modelId: "gpt-5.2-codex" })
      .map(model => model.modelId)).toEqual(["gpt-5.2-codex", "deepseek-chat"]);
  });
});
