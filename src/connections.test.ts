// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createProject } from "./data";
import {
  applyConnections,
  connectionsFilePath,
  connectionsFromProject,
  loadWorkspaceConnections,
  normalizeConnections,
  saveWorkspaceConnections,
} from "./connections";

describe("workspace connections", () => {
  beforeEach(() => localStorage.clear());

  it("builds .gouan/connections.json under workspace root", () => {
    expect(connectionsFilePath("D:\\work\\demo")).toBe("D:\\work\\demo\\.gouan\\connections.json");
    expect(connectionsFilePath("/tmp/ws/")).toBe("/tmp/ws/.gouan/connections.json");
  });

  it("normalizes partial connection payloads", () => {
    const conn = normalizeConnections({
      model: { baseUrl: "http://localhost:11434/v1", model: "qwen", apiKey: "k1" },
      search: { provider: "brave", endpoint: "https://api.search.brave.com", apiKey: "k2" },
    });
    expect(conn.model.baseUrl).toBe("http://localhost:11434/v1");
    expect(conn.model.model).toBe("qwen");
    expect(conn.model.apiKey).toBe("k1");
    expect(conn.model.enabled).toBe(true);
    expect(conn.search.provider).toBe("brave");
    expect(conn.search.apiKey).toBe("k2");
    expect(conn.search.engines).toEqual(["baidu", "360search", "bing"]);
  });

  it("applies connections onto a project", () => {
    const project = createProject();
    const next = applyConnections(project, {
      model: { ...project.model, baseUrl: "http://127.0.0.1:8080/v1", apiKey: "mk", model: "local" },
      search: { provider: "searxng", endpoint: "http://searx.local", apiKey: "" },
    });
    expect(next.model.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(next.model.apiKey).toBe("mk");
    expect(next.search.endpoint).toBe("http://searx.local");
    expect(next.search.engines).toEqual(["baidu", "360search", "bing"]);
  });

  it("round-trips browser connections including keys", async () => {
    const project = createProject();
    project.model.apiKey = "browser-model-key";
    project.search.apiKey = "browser-search-key";
    project.search.endpoint = "http://searx";
    await saveWorkspaceConnections(undefined, connectionsFromProject(project));
    const loaded = await loadWorkspaceConnections();
    expect(loaded?.model.apiKey).toBe("browser-model-key");
    expect(loaded?.search.apiKey).toBe("browser-search-key");
    expect(loaded?.search.endpoint).toBe("http://searx");
    expect(loaded?.search.engines).toEqual(["baidu", "360search", "bing"]);
  });
});
