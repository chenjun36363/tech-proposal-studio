import { describe, expect, it } from "vitest";
import type { Project } from "./types";
import { defaultWorkspaceFromRoot, normalizeWorkspacePaths } from "./data";
import { mergeLibrarySources, uniqueImportedMarkdownName } from "./workspace";

describe("workspace Markdown import", () => {
  it("keeps an unused Markdown filename", () => {
    expect(uniqueImportedMarkdownName("方案.md", ["其他.md"])).toBe("方案.md");
  });

  it("adds a numeric suffix for case-insensitive conflicts", () => {
    expect(uniqueImportedMarkdownName("方案.md", ["方案.MD", "方案 (1).md"])).toBe("方案 (2).md");
  });

  it("normalizes markdown extensions and unsafe filename characters", () => {
    expect(uniqueImportedMarkdownName("外部:方案.markdown", [])).toBe("外部_方案.md");
  });
});

describe("workspace knowledge directory migration", () => {
  it("uses knowledge as the default directory", () => {
    expect(defaultWorkspaceFromRoot("D:\\workspace").historyDir).toBe("D:\\workspace\\knowledge");
  });

  it("migrates only the legacy default history directory", () => {
    expect(normalizeWorkspacePaths({ root: "D:\\workspace", historyDir: "D:\\workspace\\history" })?.historyDir)
      .toBe("D:\\workspace\\knowledge");
    expect(normalizeWorkspacePaths({ root: "D:\\workspace", historyDir: "E:\\shared\\history" })?.historyDir)
      .toBe("E:\\shared\\history");
  });
});

describe("workspace source refresh", () => {
  it("retains manually added context sources", () => {
    const manual = {
      id: "manual-1",
      kind: "manual" as const,
      title: "访谈补充",
      location: "手动添加",
      excerpt: "完整内容",
      content: "完整内容",
      fingerprint: "manual-1",
      accessedAt: "2026-07-22T00:00:00.000Z",
    };
    const project = { sources: [manual] } as Project;

    expect(mergeLibrarySources(project, []).sources).toEqual([manual]);
  });
});
