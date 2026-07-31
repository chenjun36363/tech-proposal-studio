import { describe, expect, it } from "vitest";
import { modelsEndpoint, modelListHeaders, normalizeModelList } from "./modelCatalog";

describe("model catalog", () => {
  it("normalizes OpenAI-compatible model responses", () => {
    expect(normalizeModelList({
      object: "list",
      data: [
        { id: "gpt-4o", owned_by: "openai" },
        { id: "gpt-4o", owned_by: "duplicate" },
        { id: "qwen-max", name: "Qwen Max", ownedBy: "qwen" },
      ],
    })).toEqual([
      { id: "gpt-4o", displayName: "gpt-4o", ownedBy: "openai" },
      { id: "qwen-max", displayName: "Qwen Max", ownedBy: "qwen" },
    ]);
  });

  it("supports Anthropic and Ollama-style fields", () => {
    expect(normalizeModelList({ models: [
      { id: "claude-sonnet", display_name: "Claude Sonnet" },
      { name: "llama3.2", model: "llama3.2:latest" },
      "custom-model",
    ]})).toEqual([
      { id: "claude-sonnet", displayName: "Claude Sonnet" },
      { id: "llama3.2:latest", displayName: "llama3.2", },
      { id: "custom-model", displayName: "custom-model" },
    ]);
  });

  it("uses Anthropic auth headers without overriding explicit headers", () => {
    const headers = modelListHeaders({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "secret",
      model: "claude-sonnet",
      timeoutMs: 60000,
      headers: {},
      enabled: true,
    });
    expect(headers["x-api-key"]).toBe("secret");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    expect(modelListHeaders({
      baseUrl: "https://gateway.example/v1",
      apiKey: "secret",
      model: "custom",
      timeoutMs: 60000,
      headers: { Authorization: "Custom token" },
      enabled: true,
    }).Authorization).toBe("Custom token");
  });

  it("does not append /models twice", () => {
    expect(modelsEndpoint("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/models");
    expect(modelsEndpoint("https://gateway.example/models")).toBe("https://gateway.example/models");
  });
});
