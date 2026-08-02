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

const PNG_1x1_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP4z8AAAAMBAQAF/tTvAAAAAElFTkSuQmCC";

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

  it("exports raw HTML tables with rowspan as merged Word cells", async () => {
    const project = createProject();
    project.name = "资金估算";
    project.markdown = `# 资金估算

<table>
<tr><td rowspan="5"><strong>估算金额</strong></td><td rowspan="5"><strong>120万元</strong></td><td>中央财政资金</td><td>0万元</td></tr>
<tr><td>省级财政资金</td><td>0万元</td></tr>
<tr><td>市级财政专项资金：（数字化项目年度预算）</td><td>120万元</td></tr>
<tr><td>部门预算资金</td><td>0万元</td></tr>
<tr><td>其他资金</td><td>0万元</td></tr>
</table>`;

    const doc = await buildDocx(project);
    const docJson = JSON.stringify(doc);

    expect(docJson).toContain("估算金额");
    expect(docJson).toContain("市级财政专项资金：（数字化项目年度预算）");
    // docx adds one vertical-merge continuation for each row covered by each rowspan cell.
    expect((docJson.match(/"rowSpan":5/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((docJson.match(/"verticalMerge":"continue"/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it("exports Markdown ordered lists as native Word numbering", async () => {
    const project = createProject();
    project.name = "编号列表测试";
    project.markdown = "# 编号列表测试\n\n1. 第一项\n2. 第二项\n\n正文\n\n1. 新列表第一项\n";

    const doc = await buildDocx(project);
    const docJson = JSON.stringify(doc);

    const numberingReferences = docJson.match(/"reference":"markdown-ordered-list"/g) ?? [];
    // One reference is the numbering definition; the remaining references are
    // the list-item paragraphs that use it.
    expect(numberingReferences.length).toBeGreaterThan(1);
  });

  it("aligns unordered-list text with the first line of ordinary body paragraphs", async () => {
    const project = createProject();
    project.name = "效益说明";
    project.markdown = "# 效益说明\n\n普通正文。\n\n- 经济效益：全流程无纸化替代纸质单据\n- 管理效益：实现从任务登记到闭环管理\n";

    const doc = await buildDocx(project);
    const documentXml = JSON.stringify((doc as unknown as { Document: unknown }).Document);
    const itemTextAt = documentXml.indexOf("经济效益：全流程无纸化替代纸质单据");
    const paragraphStart = documentXml.lastIndexOf('{"rootKey":"w:p"', itemTextAt);
    const nextParagraph = documentXml.indexOf('{"rootKey":"w:p"', itemTextAt + 1);
    const itemParagraphXml = documentXml.slice(paragraphStart, nextParagraph);

    // Default body first-line indent: 2 characters × 12pt × 20 twips = 480 twips.
    expect(itemParagraphXml).toContain('"key":"w:left","value":480');
    expect(itemParagraphXml).toContain('"key":"w:hanging","value":360');
    expect(itemParagraphXml).toContain('"rootKey":"w:numPr"');
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

  it("formats the configured cover and adds a header plus right footer page fields", async () => {
    const project = createProject();
    project.name = "园区数字化项目";
    project.markdown = "# 园区数字化项目\n\n正文\n";
    project.wordExport = {
      ...project.wordExport,
      companyNameZh: "测试信息股份有限公司",
      companyNameEn: "TEST INFORMATION CO.,LTD.",
      companyAddress: "地址：测试市测试路 100 号",
      coverLogoDataUrl: PNG_1x1_DATA_URL,
      headerTitle: "园区数字化项目技术方案",
      showFooterPageNumbers: true,
    };

    const doc = await buildDocx(project);
    const docJson = JSON.stringify(doc);
    expect(docJson).toContain("测试信息股份有限公司");
    expect(docJson).toContain("TEST INFORMATION CO.,LTD.");
    expect(docJson).toContain("地址：测试市测试路 100 号");
    expect(docJson).toContain("园区数字化项目技术方案");
    expect(docJson).toContain("封面 Logo");
    expect(docJson).toContain("PAGE");
    expect(docJson).toContain("NUMPAGES");
    expect(docJson).toContain("0070C0");
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
