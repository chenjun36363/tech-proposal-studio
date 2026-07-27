// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createProject } from "./data";
import { exportMarkdown, loadProject, saveProject } from "./storage";
describe("project persistence", () => {
  beforeEach(() => localStorage.clear());
  it("creates the complete proposal template", () => {
    const project = createProject();
    expect(project.markdown.match(/^## /gm)).toHaveLength(9);
    expect(project.contextSourceRefs).toEqual([]);
  });
  it("migrates legacy block source references into the project context", () => {
    const project = createProject();
    const legacy = {
      ...project,
      contextSourceRefs: undefined,
      sections: [{ title: "背景与目标", blocks: [{ id: "b", sectionId: "s", type: "text", content: "", order: 0, status: "draft", sourceRefs: ["source-1"] }] }],
    };
    localStorage.setItem("tech-proposal-studio.project.v1", JSON.stringify(legacy));
    const loaded = loadProject();
    expect(loaded.contextSourceRefs).toEqual(["source-1"]);
    expect("sections" in loaded).toBe(false);
  });
  it("never persists API secrets", () => {
    const project = createProject();
    project.model.apiKey = "secret-model-key";
    project.search.apiKey = "secret-search-key";
    project.mineru.apiKey = "secret-mineru-key";
    saveProject(project);
    const raw = localStorage.getItem("tech-proposal-studio.project.v1")!;
    expect(raw).not.toContain("secret-model-key");
    expect(raw).not.toContain("secret-search-key");
    expect(raw).not.toContain("secret-mineru-key");
    expect(loadProject().model.apiKey).toBe("");
    expect(loadProject().mineru.apiKey).toBe("");
  });
  it("migrates the legacy browser storage key", () => { const project = createProject(); project.name = "旧项目"; localStorage.setItem("schematic-writer.project.v1", JSON.stringify(project)); expect(loadProject().name).toBe("旧项目"); expect(localStorage.getItem("tech-proposal-studio.project.v1")).not.toBeNull(); expect(localStorage.getItem("schematic-writer.project.v1")).not.toBeNull(); });
  it("adds defaults when loading a project without agent settings", () => {
    const project = createProject() as Partial<ReturnType<typeof createProject>>;
    delete project.agent;
    localStorage.setItem("tech-proposal-studio.project.v1", JSON.stringify(project));
    expect(loadProject().agent.contextCompressionTokens).toBe(48000);
    expect(loadProject().agent.memoryEnabled).toBe(true);
  });
  it("persists the configured web search call limit", () => {
    const project = createProject();
    project.agent.webSearchMaxCalls = 6;
    saveProject(project);
    expect(loadProject().agent.webSearchMaxCalls).toBe(6);
  });
  it("exports editable markdown", () => {
    const project = createProject();
    project.name = "支付平台方案";
    project.markdown = "# 支付平台方案\n\n## 背景与目标\n\n建设统一支付入口。\n";
    expect(exportMarkdown(project)).toContain("# 支付平台方案");
    expect(exportMarkdown(project)).toContain("## 背景与目标");
    expect(exportMarkdown(project)).toContain("建设统一支付入口。");
  });
});
