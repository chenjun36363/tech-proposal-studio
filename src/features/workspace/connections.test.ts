// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createProject } from "../../core/data";
import {
  applyConnections,
  connectionsFilePath,
  connectionsFromProject,
  loadWorkspaceConnections,
  normalizeConnections,
  saveWorkspaceConnections,
  sameWorkspaceRoot,
} from "./connections";

describe("workspace connections", () => {
  beforeEach(() => localStorage.clear());

  it("builds .gouan/connections.json under workspace root", () => {
    expect(connectionsFilePath("D:\\work\\demo")).toBe("D:\\work\\demo\\.gouan\\connections.json");
    expect(connectionsFilePath("/tmp/ws/")).toBe("/tmp/ws/.gouan/connections.json");
  });

  it("compares Windows workspace roots without case or separator noise", () => {
    expect(sameWorkspaceRoot("E:\\Work\\Demo\\", "e:/work/demo")).toBe(true);
    expect(sameWorkspaceRoot("E:\\Work\\Demo", "E:\\Work\\Other")).toBe(false);
  });

  it("migrates v1 single-model payload to providers v2", () => {
    const conn = normalizeConnections({
      model: { baseUrl: "http://localhost:11434/v1/chat/completions", model: "qwen", apiKey: "k1" },
      search: { provider: "brave", endpoint: "https://api.search.brave.com", apiKey: "k2" },
      mineru: { apiKey: "k3", modelVersion: "pipeline", timeoutSeconds: 120 },
    });
    expect(conn.version).toBe(2);
    expect(conn.providers).toHaveLength(1);
    expect(conn.providers[0].id).toBe("legacy-default");
    expect(conn.providers[0].baseUrl).toBe("http://localhost:11434/v1");
    expect(conn.providers[0].protocol).toBe("openai-completions");
    expect(conn.providers[0].apiKey).toBe("k1");
    expect(conn.providers[0].activeModels).toEqual(["qwen"]);
    expect(conn.selectedModel).toEqual({ providerId: "legacy-default", model: "qwen" });
    expect(conn.model.baseUrl).toBe("http://localhost:11434/v1");
    expect(conn.model.model).toBe("qwen");
    expect(conn.model.apiKey).toBe("k1");
    expect(conn.search.provider).toBe("brave");
    expect(conn.search.apiKey).toBe("k2");
    expect(conn.search.engines).toEqual(["baidu", "360search", "bing"]);
    expect(conn.mineru.apiKey).toBe("k3");
    expect(conn.mineru.modelVersion).toBe("pipeline");
    expect(conn.mineru.baseUrl).toBe("https://mineru.net");
    expect(conn.mineru.timeoutSeconds).toBe(120);
    expect(conn.mineru.enableTable).toBe(true);
  });

  it("infers anthropic/gemini protocols from host during v1 migration", () => {
    const anthropic = normalizeConnections({
      model: { baseUrl: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-5", apiKey: "a" },
    });
    expect(anthropic.providers[0].protocol).toBe("anthropic-messages");
    expect(anthropic.providers[0].baseUrl).toBe("https://api.anthropic.com/v1");

    const gemini = normalizeConnections({
      model: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.0-flash", apiKey: "g" },
    });
    expect(gemini.providers[0].protocol).toBe("google-generative-ai");
  });

  it("uses Responses for new and existing official OpenAI connections", () => {
    expect(createProject().providers[0].protocol).toBe("openai-responses");

    const legacy = normalizeConnections({
      model: { baseUrl: "https://api.openai.com/v1/chat/completions", model: "gpt-4.1-mini", apiKey: "k" },
    });
    expect(legacy.providers[0].protocol).toBe("openai-responses");
    expect(legacy.providers[0].baseUrl).toBe("https://api.openai.com/v1");

    const existing = normalizeConnections({
      version: 2,
      providers: [{
        id: "openai",
        name: "OpenAI",
        protocol: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        timeoutMs: 60000,
        headers: {},
        enabled: true,
        activeModels: ["gpt-4.1-mini"],
      }],
      selectedModel: { providerId: "openai", model: "gpt-4.1-mini" },
    });
    expect(existing.providers[0].protocol).toBe("openai-responses");
  });

  it("keeps third-party OpenAI-compatible connections on Completions", () => {
    const conn = normalizeConnections({
      version: 2,
      providers: [{
        id: "gateway",
        name: "Gateway",
        protocol: "openai-completions",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "k",
        timeoutMs: 60000,
        headers: {},
        enabled: true,
        activeModels: ["model"],
      }],
      selectedModel: { providerId: "gateway", model: "model" },
    });
    expect(conn.providers[0].protocol).toBe("openai-completions");
  });

  it("repairs invalid selectedModel against activeModels", () => {
    const conn = normalizeConnections({
      version: 2,
      providers: [{
        id: "p1",
        name: "Local",
        protocol: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "",
        timeoutMs: 60000,
        headers: {},
        enabled: true,
        activeModels: ["a", "b"],
      }],
      selectedModel: { providerId: "p1", model: "gone" },
    });
    expect(conn.selectedModel).toEqual({ providerId: "p1", model: "a" });
  });

  it("applies connections onto a project", () => {
    const project = createProject();
    const conn = connectionsFromProject(project);
    conn.providers = [{
      ...conn.providers[0],
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "mk",
      activeModels: ["local"],
    }];
    conn.selectedModel = { providerId: conn.providers[0].id, model: "local" };
    conn.search = { provider: "searxng", endpoint: "http://searx.local", apiKey: "", engines: project.search.engines };
    conn.mineru = { ...project.mineru, apiKey: "mu" };
    const next = applyConnections(project, conn);
    expect(next.providers[0].baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(next.providers[0].apiKey).toBe("mk");
    expect(next.search.endpoint).toBe("http://searx.local");
    expect(next.search.engines).toEqual(["baidu", "360search", "bing"]);
    expect(next.mineru.apiKey).toBe("mu");
  });

  it("round-trips browser connections without persisting the wiki-cloud key", async () => {
    const project = createProject();
    const conn = connectionsFromProject(project);
    conn.providers[0].apiKey = "browser-model-key";
    conn.search.apiKey = "browser-search-key";
    conn.mineru.apiKey = "browser-mineru-key";
    conn.wikiCloud = { ...conn.wikiCloud, enabled: true, workspaceId: "workspace-1", apiKey: "browser-wiki-cloud-key" };
    conn.search.endpoint = "http://searx";
    await saveWorkspaceConnections(undefined, conn);
    const loaded = await loadWorkspaceConnections();
    expect(loaded?.providers[0].apiKey).toBe("browser-model-key");
    expect(loaded?.search.apiKey).toBe("browser-search-key");
    expect(loaded?.mineru.apiKey).toBe("browser-mineru-key");
    expect(loaded?.wikiCloud.workspaceId).toBe("workspace-1");
    expect(loaded?.wikiCloud.apiKey).toBe("");
    expect(localStorage.getItem("tech-proposal-studio.connections.v1")).not.toContain("browser-wiki-cloud-key");
    expect(loaded?.search.endpoint).toBe("http://searx");
    expect(loaded?.search.engines).toEqual(["baidu", "360search", "bing"]);
  });

  it("normalizes and persists the thinking level (reasoningEffort)", async () => {
    const conn = normalizeConnections({
      version: 2,
      providers: [{
        id: "p1",
        name: "Deep",
        protocol: "openai-completions",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "k",
        timeoutMs: 60000,
        headers: {},
        enabled: true,
        reasoningEffort: "high",
        activeModels: ["deep-model"],
      }],
      selectedModel: { providerId: "p1", model: "deep-model" },
    });
    expect(conn.providers[0].reasoningEffort).toBe("high");
    expect(conn.model.reasoningEffort).toBe("high");

    const invalid = normalizeConnections({ ...conn, providers: [{ ...conn.providers[0], reasoningEffort: "extreme" }] });
    expect(invalid.providers[0].reasoningEffort).toBe("off");

    conn.providers[0].reasoningEffort = "medium";
    await saveWorkspaceConnections(undefined, conn);
    const loaded = await loadWorkspaceConnections();
    expect(loaded?.providers[0].reasoningEffort).toBe("medium");
  });
});
