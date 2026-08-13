// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createProject } from "../../core/data";
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
    project.wikiCloud.apiKey = "secret-wiki-cloud-key";
    if (project.providers[0]) project.providers[0].apiKey = "secret-provider-key";
    saveProject(project);
    const raw = localStorage.getItem("tech-proposal-studio.project.v1")!;
    expect(raw).not.toContain("secret-model-key");
    expect(raw).not.toContain("secret-search-key");
    expect(raw).not.toContain("secret-mineru-key");
    expect(raw).not.toContain("secret-wiki-cloud-key");
    expect(raw).not.toContain("secret-provider-key");
    expect(loadProject().model.apiKey).toBe("");
    expect(loadProject().mineru.apiKey).toBe("");
    expect(loadProject().wikiCloud.apiKey).toBe("");
    expect(loadProject().providers.every(p => !p.apiKey)).toBe(true);
  });
  it("migrates the legacy browser storage key", () => { const project = createProject(); project.name = "旧项目"; localStorage.setItem("schematic-writer.project.v1", JSON.stringify(project)); expect(loadProject().name).toBe("旧项目"); expect(localStorage.getItem("tech-proposal-studio.project.v1")).not.toBeNull(); expect(localStorage.getItem("schematic-writer.project.v1")).not.toBeNull(); });
  it("adds defaults when loading a project without agent settings", () => {
    const project = createProject() as Partial<ReturnType<typeof createProject>>;
    delete project.agent;
    localStorage.setItem("tech-proposal-studio.project.v1", JSON.stringify(project));
    expect(loadProject().agent.contextCompressionTokens).toBe(98000);
    expect(loadProject().agent.memoryEnabled).toBe(false);
    expect(loadProject().agent.knowledgeToolsEnabled).toBe(false);
    expect(loadProject().agent.webSearchEnabled).toBe(false);
    expect(loadProject().agent.longWritingContextWindowTokens).toBe(32768);
  });
  it("adds default Word export settings to legacy projects and persists custom values", () => {
    const legacy = createProject() as Partial<ReturnType<typeof createProject>>;
    delete legacy.wordExport;
    localStorage.setItem("tech-proposal-studio.project.v1", JSON.stringify(legacy));
    expect(loadProject().wordExport.companyNameZh).toBe("江苏远大信息股份有限公司");
    expect(loadProject().wordExport.showFooterPageNumbers).toBe(true);

    const project = createProject();
    project.wordExport.headerTitle = "项目技术方案";
    project.wordExport.coverLogoDataUrl = "data:image/png;base64,abc";
    project.wordExport.showFooterPageNumbers = false;
    saveProject(project);
    expect(loadProject().wordExport).toMatchObject({
      headerTitle: "项目技术方案",
      coverLogoDataUrl: "data:image/png;base64,abc",
      showFooterPageNumbers: false,
    });
  });
  it("uses the shared heading numbering default for new projects", () => {
    expect(createProject().headingNumbering).toEqual({ schemeId: "chapter-decimal", startLevel: 2 });
  });
  it("migrates a legacy non-none Word numbering preference", () => {
    const legacy = createProject() as unknown as Omit<ReturnType<typeof createProject>, "headingNumbering" | "wordExport"> & {
      headingNumbering?: undefined;
      wordExport: ReturnType<typeof createProject>["wordExport"] & {
        headingNumbering?: string;
        headingNumberingStart?: number;
      };
    };
    delete legacy.headingNumbering;
    legacy.wordExport.headingNumbering = "section";
    legacy.wordExport.headingNumberingStart = 3;
    localStorage.setItem("tech-proposal-studio.project.v1", JSON.stringify(legacy));

    expect(loadProject().headingNumbering).toEqual({ schemeId: "section", startLevel: 3 });
  });
  it.each([undefined, "none"])("defaults legacy Word numbering %s to chapter-decimal from H2", (legacyScheme) => {
    const legacy = createProject() as unknown as Omit<ReturnType<typeof createProject>, "headingNumbering" | "wordExport"> & {
      headingNumbering?: undefined;
      wordExport: ReturnType<typeof createProject>["wordExport"] & {
        headingNumbering?: string;
        headingNumberingStart?: number;
      };
    };
    delete legacy.headingNumbering;
    if (legacyScheme !== undefined) legacy.wordExport.headingNumbering = legacyScheme;
    legacy.wordExport.headingNumberingStart = 5;
    localStorage.setItem("tech-proposal-studio.project.v1", JSON.stringify(legacy));

    expect(loadProject().headingNumbering).toEqual({ schemeId: "chapter-decimal", startLevel: 2 });
  });
  it("persists only the shared heading numbering configuration", () => {
    const project = createProject() as ReturnType<typeof createProject> & {
      wordExport: ReturnType<typeof createProject>["wordExport"] & {
        headingNumbering?: string;
        headingNumberingStart?: number;
      };
    };
    project.headingNumbering = { schemeId: "paren", startLevel: 4 };
    project.wordExport.headingNumbering = "chapter";
    project.wordExport.headingNumberingStart = 1;
    saveProject(project);

    const stored = JSON.parse(localStorage.getItem("tech-proposal-studio.project.v1")!);
    expect(stored.headingNumbering).toEqual({ schemeId: "paren", startLevel: 4 });
    expect(stored.wordExport).not.toHaveProperty("headingNumbering");
    expect(stored.wordExport).not.toHaveProperty("headingNumberingStart");
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
