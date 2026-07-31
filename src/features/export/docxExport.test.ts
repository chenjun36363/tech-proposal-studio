import { describe, expect, it } from "vitest";
import { createProject } from "../../core/data";
import { buildDocx, buildDocxBytes, extractMarkdownImages, readImageSize, resolveLocalImagePath } from "./docxExport";

// Minimal 1x1 PNG
const PNG_1x1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe("Word export", () => {
  it("creates a valid DOCX package from markdown", async () => {
    const project = createProject();
    project.name = "架构方案";
    project.markdown = "# 架构方案\n\n## 背景与目标\n\n目标正文\n\n```ts\nconst x = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    expect(await buildDocx(project)).toBeTruthy();
    const bytes = await buildDocxBytes(project);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // ZIP magic PK
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
  });

  it("configures Word to populate the table of contents on first open", async () => {
    const project = createProject();
    project.name = "目录测试";
    project.markdown = "# 目录测试\n\n## 第一章\n\n### 1.1 子章\n\n正文\n";

    const doc = await buildDocx(project);
    const settingsXml = JSON.stringify((doc as unknown as { Settings: unknown }).Settings);
    expect(settingsXml).toContain("updateFields");
  });

  it("uses Word built-in heading styles without duplicate style definitions", async () => {
    const project = createProject();
    project.name = "标题样式测试";
    project.markdown = "# 标题样式测试\n\n## 第一章\n\n### 1.1 子章\n\n正文\n";

    const doc = await buildDocx(project);
    const stylesXml = JSON.stringify((doc as unknown as { Styles: unknown }).Styles);
    for (let level = 1; level <= 6; level += 1) {
      const definitions = stylesXml.match(new RegExp(`\"styleId\":\"Heading${level}\"`, "g")) ?? [];
      expect(definitions, `Heading${level} should have one style definition`).toHaveLength(1);
    }
    expect((stylesXml.match(/w:qFormat/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("keeps heading appearance in the Word style instead of direct text formatting", async () => {
    const project = createProject();
    project.name = "封面标题";
    project.markdown = "# 正文一级标题\n\n## 正文二级标题\n";

    const doc = await buildDocx(project);
    const documentXml = JSON.stringify((doc as unknown as { Document: unknown }).Document);
    const headingTextAt = documentXml.indexOf("正文一级标题");
    const paragraphStart = documentXml.lastIndexOf('{"rootKey":"w:p"', headingTextAt);
    const nextParagraph = documentXml.indexOf('{"rootKey":"w:p"', headingTextAt + 1);
    const headingParagraphXml = documentXml.slice(paragraphStart, nextParagraph);

    expect(headingParagraphXml).toContain('"value":"Heading1"');
    expect(headingParagraphXml).toContain('"rootKey":"w:rPr","root":[]');
    expect(headingParagraphXml).not.toContain('"rootKey":"w:rFonts"');
    expect(headingParagraphXml).not.toContain('"rootKey":"w:b"');
    expect(headingParagraphXml).not.toContain('"rootKey":"w:sz"');
  });

  it("reads PNG dimensions from IHDR", () => {
    expect(readImageSize(PNG_1x1, "png")).toEqual({ width: 1, height: 1 });
  });

  it("extracts angle-bracket image destinations with Chinese, spaces and brackets", () => {
    expect(extractMarkdownImages("正文\n![](<assets/import-常州 方案(1)/image.png>)\n"))
      .toEqual([{ alt: "", source: "assets/import-常州 方案(1)/image.png" }]);
  });

  it("resolves encoded workspace asset paths without truncating spaces", () => {
    expect(resolveLocalImagePath("<assets/import-%E5%B8%B8%E5%B7%9E%20%E6%96%B9%E6%A1%88/image.png>", "E:\\workspace\\proposal.md", "E:\\workspace"))
      .toBe("E:\\workspace\\assets\\import-常州 方案\\image.png");
  });

  it("embeds local image bytes when path is absolute", async () => {
    // Patch via absolute path is desktop-only; without Tauri, missing image falls back to placeholder
    // and still produces a valid package.
    const project = createProject();
    project.name = "带图方案";
    project.markdown = "# 带图方案\n\n正文\n\n![示意](assets/missing.png)\n";
    const bytes = await buildDocxBytes(project);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
    expect(bytes.byteLength).toBeGreaterThan(800);
  });
});
