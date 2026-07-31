// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  isSupportedImportDocument,
  markdownNameFromSource,
  prepareImportedMarkdown,
  resolveMineruConfig,
} from "./documentImport";
import { connectionsFromProject, saveWorkspaceConnections } from "./connections";
import { createProject } from "./data";

describe("documentImport helpers", () => {
  it("accepts pdf/doc/docx only", () => {
    expect(isSupportedImportDocument("a.pdf")).toBe(true);
    expect(isSupportedImportDocument("a.PDF")).toBe(true);
    expect(isSupportedImportDocument("a.docx")).toBe(true);
    expect(isSupportedImportDocument("a.doc")).toBe(true);
    expect(isSupportedImportDocument("a.md")).toBe(false);
    expect(isSupportedImportDocument("a.txt")).toBe(false);
  });

  it("derives markdown file name from source", () => {
    expect(markdownNameFromSource("方案V1.pdf")).toBe("方案V1.md");
    expect(markdownNameFromSource("设计.docx")).toBe("设计.md");
  });

  it("renumbers MinerU-style headings to studio format", () => {
    const raw = [
      "# 技术方案",
      "",
      "## 背景与目标",
      "",
      "### 业务范围",
      "",
      "## 总体架构",
      "",
      "正文",
    ].join("\n");
    const next = prepareImportedMarkdown(raw);
    expect(next).toContain("# 技术方案");
    expect(next).toContain("## 第1章 背景与目标");
    expect(next).toContain("### 1.1 业务范围");
    expect(next).toContain("## 第2章 总体架构");
  });

  it("strips existing numbering before re-applying", () => {
    const raw = "# 方案\n\n## 第3章 旧编号\n\n### 2.5 小节";
    const next = prepareImportedMarkdown(raw);
    expect(next).toContain("## 第1章 旧编号");
    expect(next).toContain("### 1.1 小节");
  });
});

describe("resolveMineruConfig", () => {
  beforeEach(() => localStorage.clear());

  it("loads mineru from browser connections when no workspace root", async () => {
    const project = createProject();
    project.mineru.apiKey = "from-disk-key";
    project.mineru.modelVersion = "pipeline";
    const conn = connectionsFromProject(project);
    conn.mineru = project.mineru;
    await saveWorkspaceConnections(undefined, conn);
    const cfg = await resolveMineruConfig("", null);
    expect(cfg.apiKey).toBe("from-disk-key");
    expect(cfg.modelVersion).toBe("pipeline");
  });

  it("falls back to in-memory config", async () => {
    const fallback = { ...createProject().mineru, apiKey: "mem-key" };
    const cfg = await resolveMineruConfig("", fallback);
    expect(cfg.apiKey).toBe("mem-key");
  });
});
