// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createProject } from "./data";
import { exportMarkdown, loadProject, saveProject } from "./storage";
describe("project persistence", () => {
  beforeEach(() => localStorage.clear());
  it("creates the complete proposal template", () => { const project = createProject(); expect(project.sections).toHaveLength(9); expect(project.sections[0].title).toBe("背景与目标"); });
  it("never persists API secrets", () => { const project = createProject(); project.model.apiKey = "secret-model-key"; project.search.apiKey = "secret-search-key"; saveProject(project); const raw = localStorage.getItem("tech-proposal-studio.project.v1")!; expect(raw).not.toContain("secret-model-key"); expect(raw).not.toContain("secret-search-key"); expect(loadProject().model.apiKey).toBe(""); });
  it("migrates the legacy browser storage key", () => { const project = createProject(); project.name = "旧项目"; localStorage.setItem("schematic-writer.project.v1", JSON.stringify(project)); expect(loadProject().name).toBe("旧项目"); expect(localStorage.getItem("tech-proposal-studio.project.v1")).not.toBeNull(); expect(localStorage.getItem("schematic-writer.project.v1")).not.toBeNull(); });
  it("exports editable markdown", () => { const project = createProject(); project.name = "支付平台方案"; project.sections[0].blocks[0].content = "建设统一支付入口。"; expect(exportMarkdown(project)).toContain("# 支付平台方案"); expect(exportMarkdown(project)).toContain("## 背景与目标"); expect(exportMarkdown(project)).toContain("建设统一支付入口。"); });
});
