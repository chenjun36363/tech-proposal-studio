import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  LineRuleType,
  PageBreak,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
  type FileChild,
  type IImageOptions,
} from "docx";
import type { Project } from "../../core/types";
import { exportMarkdown } from "../workspace/storage";
import { isDesktop } from "../../services/runtime";
import { invoke } from "@tauri-apps/api/core";
import { readBinaryFile } from "../workspace/workspace";

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/** 宋体 — body */
const BODY_FONT = { eastAsia: "宋体", ascii: "SimSun", hAnsi: "SimSun" };
const CODE_FONT = "Consolas";

const SIZE_CODE = 18;

const MAX_IMAGE_WIDTH_PX = 520;

export interface DocxExportSettings {
  headingFont: string;
  bodyFont: string;
  headingSizes: [number, number, number, number, number, number];
  bodySize: number;
  lineSpacing: number;
  firstLineIndent: number;
  bodyBefore: number;
  bodyAfter: number;
  headingBefore: [number, number, number, number, number, number];
  headingAfter: [number, number, number, number, number, number];
  maxImageWidth: number;
}

export const DEFAULT_DOCX_EXPORT_SETTINGS: DocxExportSettings = {
  headingFont: "黑体",
  bodyFont: "宋体",
  headingSizes: [22, 16, 14, 12, 12, 10.5],
  bodySize: 12,
  lineSpacing: 1.5,
  firstLineIndent: 2,
  bodyBefore: 0,
  bodyAfter: 0,
  headingBefore: [14, 12, 10, 9, 8, 7],
  headingAfter: [7, 6, 5, 5, 4, 4],
  maxImageWidth: MAX_IMAGE_WIDTH_PX,
};

export interface DocxImageCheckItem {
  alt: string;
  source: string;
  path: string | null;
  status: "ready" | "missing" | "unsupported" | "external";
  message: string;
}

export interface DocxImageCheckResult {
  total: number;
  ready: number;
  issues: DocxImageCheckItem[];
  items: DocxImageCheckItem[];
}

const halfPoints = (points: number) => Math.max(1, Math.round(points * 2));
const twips = (points: number) => Math.max(0, Math.round(points * 20));
const lineTwips = (multiple: number) => Math.max(240, Math.round(multiple * 240));
const exportFont = (name: string) => ({ eastAsia: name, ascii: name, hAnsi: name });

function plainText(line: string): string {
  return line
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

function runsFromInline(
  line: string,
  base?: { italics?: boolean; color?: string; font?: typeof BODY_FONT | string; size?: number },
  settings: DocxExportSettings = DEFAULT_DOCX_EXPORT_SETTINGS,
): TextRun[] {
  const font = base?.font ?? exportFont(settings.bodyFont);
  const size = base?.size ?? halfPoints(settings.bodySize);
  const pieces: TextRun[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) {
      pieces.push(
        new TextRun({
          text: line.slice(last, m.index),
          font,
          size,
          italics: base?.italics,
          color: base?.color,
        }),
      );
    }
    const token = m[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      pieces.push(
        new TextRun({
          text: token.slice(2, -2),
          font,
          size,
          bold: true,
          italics: base?.italics,
          color: base?.color,
        }),
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      pieces.push(new TextRun({ text: token.slice(1, -1), font: CODE_FONT, size: SIZE_CODE }));
    } else if (token.startsWith("*") && token.endsWith("*")) {
      pieces.push(
        new TextRun({
          text: token.slice(1, -1),
          font,
          size,
          italics: true,
          color: base?.color,
        }),
      );
    }
    last = m.index + token.length;
  }
  if (last < line.length) {
    pieces.push(
      new TextRun({
        text: line.slice(last),
        font,
        size,
        italics: base?.italics,
        color: base?.color,
      }),
    );
  }
  if (!pieces.length) pieces.push(new TextRun({ text: " ", font, size }));
  return pieces;
}

function paragraphFromLine(line: string, opts?: { code?: boolean; quote?: boolean }, settings: DocxExportSettings = DEFAULT_DOCX_EXPORT_SETTINGS): Paragraph {
  if (opts?.code) {
    return new Paragraph({
      children: [new TextRun({ text: line.length ? line : " ", font: CODE_FONT, size: SIZE_CODE })],
      style: "Code",
    });
  }
  if (opts?.quote) {
    return new Paragraph({
      children: runsFromInline(line, {
        italics: true,
        color: "555555",
        font: exportFont(settings.bodyFont),
        size: halfPoints(settings.bodySize),
      }, settings),
      indent: { left: 420 },
    });
  }
  return new Paragraph({
    children: runsFromInline(line, { font: exportFont(settings.bodyFont), size: halfPoints(settings.bodySize) }, settings),
    indent: { firstLine: Math.round(settings.firstLineIndent * settings.bodySize * 20) },
    spacing: { before: twips(settings.bodyBefore), after: twips(settings.bodyAfter), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO },
  });
}

function parseTableRows(block: string[]): string[][] {
  return block
    .filter((l) => !/^\s*\|?\s*:?-{3,}/.test(l.replace(/\|/g, "")))
    .map((l) =>
      l
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => plainText(c.trim())),
    )
    .filter((r) => r.some((c) => c.length));
}

function tableFromMarkdown(rows: string[][], settings: DocxExportSettings = DEFAULT_DOCX_EXPORT_SETTINGS): Table {
  const colCount = Math.max(...rows.map((r) => r.length), 1);
  const width = Math.floor(9000 / colCount);
  // 表格边框：1pt(=size 8) 实线，深灰，确保网格线清晰可见
  const cellBorder = {
    style: BorderStyle.SINGLE,
    size: 8,
    color: "808080",
  } as const;
  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    borders: {
      top: cellBorder,
      bottom: cellBorder,
      left: cellBorder,
      right: cellBorder,
      insideHorizontal: cellBorder,
      insideVertical: cellBorder,
    },
    rows: rows.map(
      (row, ri) =>
        new TableRow({
          children: Array.from({ length: colCount }, (_, ci) => {
            const text = row[ci] ?? "";
            return new TableCell({
              width: { size: width, type: WidthType.DXA },
              borders: {
                top: cellBorder,
                bottom: cellBorder,
                left: cellBorder,
                right: cellBorder,
              },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: text || " ",
                      font: exportFont(settings.bodyFont),
                      size: halfPoints(Math.max(9, settings.bodySize - 2)),
                      bold: ri === 0,
                    }),
                  ],
                }),
              ],
            });
          }),
        }),
    ),
  });
}

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(0, i) : "";
}

function joinPath(base: string, rel: string): string {
  const clean = rel.replace(/^\.\//, "").replace(/\\/g, "/");
  if (!base) return clean;
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${clean.replace(/\//g, sep)}`;
}

function isAbsolutePath(src: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(src);
}

function imageTypeFromPath(path: string): "jpg" | "png" | "gif" | "bmp" | null {
  const ext = path.split(".").pop()?.toLowerCase().split("?")[0] ?? "";
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  if (ext === "png") return "png";
  if (ext === "gif") return "gif";
  if (ext === "bmp") return "bmp";
  return null;
}

function sniffImageType(bytes: Uint8Array): "jpg" | "png" | "gif" | "bmp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  return null;
}

/** Read PNG/JPEG/GIF/BMP dimensions from headers (no full decode). */
export function readImageSize(bytes: Uint8Array, type: "jpg" | "png" | "gif" | "bmp"): { width: number; height: number } {
  try {
    if (type === "png" && bytes.length >= 24) {
      const w =
        (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const h =
        (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      if (w > 0 && h > 0) return { width: w, height: h };
    }
    if (type === "gif" && bytes.length >= 10) {
      const w = bytes[6] | (bytes[7] << 8);
      const h = bytes[8] | (bytes[9] << 8);
      if (w > 0 && h > 0) return { width: w, height: h };
    }
    if (type === "bmp" && bytes.length >= 26) {
      const w = bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24);
      const h = Math.abs(bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24));
      if (w > 0 && h > 0) return { width: w, height: h };
    }
    if (type === "jpg") {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = bytes[i + 1];
        if (marker === 0xd8 || marker === 0xd9) {
          i += 2;
          continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        // SOF0 / SOF2
        if (marker === 0xc0 || marker === 0xc2) {
          const h = (bytes[i + 5] << 8) | bytes[i + 6];
          const w = (bytes[i + 7] << 8) | bytes[i + 8];
          if (w > 0 && h > 0) return { width: w, height: h };
        }
        if (len < 2) break;
        i += 2 + len;
      }
    }
  } catch {
    /* fall through */
  }
  return { width: 480, height: 320 };
}

function scaleImage(width: number, height: number, maxWidth: number): { width: number; height: number } {
  if (width <= maxWidth) return { width, height };
  const ratio = maxWidth / width;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

export function resolveLocalImagePath(src: string, filePath?: string, workspaceRoot?: string): string | null {
  const cleaned = decodeLocalImageSource(src);
  if (!cleaned || /^(https?:|data:|asset:|blob:|tauri:)/i.test(cleaned)) return null;
  const normalized = cleaned.replace(/\\/g, "/");
  if (isAbsolutePath(cleaned) || isAbsolutePath(normalized)) return cleaned;
  if (/^assets\//i.test(normalized) && workspaceRoot) {
    return joinPath(workspaceRoot, normalized);
  }
  if (filePath) return joinPath(dirname(filePath), normalized);
  if (workspaceRoot) return joinPath(workspaceRoot, normalized);
  return null;
}

function decodeLocalImageSource(src: string): string {
  const unwrapped = src.trim().replace(/^<|>$/g, "");
  try {
    return decodeURIComponent(unwrapped);
  } catch {
    return unwrapped;
  }
}

export function extractMarkdownImages(markdown: string): Array<{ alt: string; source: string }> {
  const images: Array<{ alt: string; source: string }> = [];
  const pattern = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+)(?:\s+["'][^"']*["'])?)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown))) {
    images.push({ alt: match[1], source: match[2] ?? match[3] });
  }
  return images;
}

function matchImageOnly(line: string): { alt: string; source: string } | null {
  const match = line.match(/^\s*!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+)(?:\s+["'][^"']*["'])?)\s*\)\s*$/);
  return match ? { alt: match[1], source: match[2] ?? match[3] } : null;
}

export async function checkDocxImages(project: Project): Promise<DocxImageCheckResult> {
  const references = extractMarkdownImages(exportMarkdown(project));
  const items = await Promise.all(references.map(async ({ alt, source }): Promise<DocxImageCheckItem> => {
    if (/^https?:/i.test(source)) {
      return { alt, source, path: null, status: "external", message: "外部图片不会在本地导出中下载" };
    }
    const path = resolveLocalImagePath(source, project.filePath, project.workspace?.root);
    if (!path) return { alt, source, path, status: "missing", message: "无法解析图片路径" };
    const bytes = await loadImageBytes(path);
    if (!bytes?.length) return { alt, source, path, status: "missing", message: "图片文件不存在或无法读取" };
    const type = imageTypeFromPath(path) ?? sniffImageType(bytes);
    if (!type) return { alt, source, path, status: "unsupported", message: "仅支持 PNG、JPEG、GIF、BMP" };
    return { alt, source, path, status: "ready", message: "可嵌入" };
  }));
  return { total: items.length, ready: items.filter(item => item.status === "ready").length, issues: items.filter(item => item.status !== "ready"), items };
}

async function loadImageBytes(path: string): Promise<Uint8Array | null> {
  try {
    if (isDesktop()) {
      return await readBinaryFile(path);
    }
  } catch {
    /* try fetch for browser/dev */
  }
  try {
    if (typeof fetch === "function" && /^(https?:|data:|blob:|file:)/i.test(path)) {
      const res = await fetch(path);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function paragraphFromImage(
  alt: string,
  src: string,
  filePath?: string,
  workspaceRoot?: string,
  settings: DocxExportSettings = DEFAULT_DOCX_EXPORT_SETTINGS,
): Promise<Paragraph> {
  const abs = resolveLocalImagePath(src, filePath, workspaceRoot);
  if (!abs) {
    return new Paragraph({
      children: [
        new TextRun({
          text: alt ? `[图片: ${alt}]` : `[图片: ${src}]`,
          font: exportFont(settings.bodyFont),
          size: halfPoints(settings.bodySize),
          italics: true,
          color: "666666",
        }),
      ],
    });
  }

  const bytes = await loadImageBytes(abs);
  if (!bytes || !bytes.length) {
    return new Paragraph({
      children: [
        new TextRun({
          text: alt ? `[图片无法加载: ${alt}]` : `[图片无法加载: ${src}]`,
          font: exportFont(settings.bodyFont),
          size: halfPoints(settings.bodySize),
          italics: true,
          color: "666666",
        }),
      ],
    });
  }

  const type = imageTypeFromPath(abs) ?? sniffImageType(bytes);
  if (!type) {
    return new Paragraph({
      children: [
        new TextRun({
          text: `[不支持的图片格式: ${src}]`,
          font: exportFont(settings.bodyFont),
          size: halfPoints(settings.bodySize),
          italics: true,
          color: "666666",
        }),
      ],
    });
  }

  const natural = readImageSize(bytes, type);
  const sized = scaleImage(natural.width, natural.height, settings.maxImageWidth);
  const options: IImageOptions = {
    type,
    data: bytes,
    transformation: { width: sized.width, height: sized.height },
    altText: {
      name: alt || "image",
      description: alt || src,
      title: alt || "image",
    },
  };

  return new Paragraph({
    children: [new ImageRun(options)],
    spacing: { before: 120, after: 120 },
  });
}

function headingParagraph(level: number, title: string, centeredTitle: boolean, settings: DocxExportSettings = DEFAULT_DOCX_EXPORT_SETTINGS): Paragraph {
  const index = Math.min(Math.max(level, 1), 6) - 1;
  const size = halfPoints(settings.headingSizes[index]);
  if (level === 1 && centeredTitle) {
    return new Paragraph({
      children: [
        new TextRun({
          text: title,
          font: exportFont(settings.headingFont),
          bold: true,
          size: halfPoints(settings.headingSizes[0]),
          color: "000000",
        }),
      ],
      heading: HeadingLevel.TITLE,
      spacing: { after: twips(settings.headingAfter[0]), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO },
      alignment: AlignmentType.CENTER,
    });
  }
  return new Paragraph({
    children: [
      new TextRun({
        text: title,
        font: exportFont(settings.headingFont),
        bold: true,
        size,
        color: "000000",
      }),
    ],
    heading: HEADING_LEVELS[Math.min(level, 6) - 1],
    spacing: { before: twips(settings.headingBefore[index]), after: twips(settings.headingAfter[index]), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO },
  });
}

/** Build DOCX from project markdown body (fallback to legacy sections). */
export async function buildDocx(project: Project, settings: DocxExportSettings = DEFAULT_DOCX_EXPORT_SETTINGS): Promise<Document> {
  const markdown = exportMarkdown(project);
  const children: FileChild[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let sawTitle = false;
  let i = 0;
  const filePath = project.filePath;
  const workspaceRoot = project.workspace?.root;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      i += 1;
      continue;
    }
    if (inCode) {
      children.push(paragraphFromLine(line, { code: true }, settings));
      i += 1;
      continue;
    }

    // GFM table block
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      const block: string[] = [];
      while (i < lines.length && lines[i].includes("|")) {
        block.push(lines[i]);
        i += 1;
      }
      const rows = parseTableRows(block);
      if (rows.length) children.push(tableFromMarkdown(rows, settings));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const title = plainText(heading[2].trim());
      if (level === 1 && !sawTitle) {
        sawTitle = true;
        // 文档标题已放在封面页，正文中不再重复渲染（仅当与项目名一致时）
        if (title && title === (project.name || "").trim()) {
          i += 1;
          continue;
        }
        children.push(headingParagraph(1, title, true, settings));
      } else {
        children.push(headingParagraph(level, title, false, settings));
      }
      i += 1;
      continue;
    }

    // Image-only line: ![alt](src)
    const imageOnly = matchImageOnly(line);
    if (imageOnly) {
      children.push(await paragraphFromImage(imageOnly.alt, imageOnly.source, filePath, workspaceRoot, settings));
      i += 1;
      continue;
    }

    // Inline image mixed with text — extract images as separate paragraphs after text
    if (/!\[[^\]]*\]\([^)]+\)/.test(line)) {
      const parts = line.split(/(!\[[^\]]*\]\([^)]+\))/g);
      let textBuf = "";
      for (const part of parts) {
        const img = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (img) {
          if (textBuf.trim()) {
            children.push(paragraphFromLine(textBuf.trim(), undefined, settings));
            textBuf = "";
          }
          children.push(await paragraphFromImage(img[1], img[2], filePath, workspaceRoot, settings));
        } else {
          textBuf += part;
        }
      }
      if (textBuf.trim()) children.push(paragraphFromLine(textBuf.trim(), undefined, settings));
      i += 1;
      continue;
    }

    if (line.startsWith("> ")) {
      children.push(paragraphFromLine(line.replace(/^>\s?/, ""), { quote: true }, settings));
      i += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const text = line.replace(/^\s*[-*+]\s+/, "");
      children.push(
        new Paragraph({
          children: runsFromInline(text, { font: exportFont(settings.bodyFont), size: halfPoints(settings.bodySize) }, settings),
          indent: { left: 360 },
          bullet: { level: 0 },
        }),
      );
      i += 1;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      children.push(
        new Paragraph({
          children: runsFromInline(line.replace(/^\s*\d+\.\s+/, ""), {
            font: exportFont(settings.bodyFont),
            size: halfPoints(settings.bodySize),
          }, settings),
          indent: { left: 360 },
        }),
      );
      i += 1;
      continue;
    }

    // 跳过空行：标题/段落间距已由各段 spacing 控制，避免标题与正文间出现多余空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    children.push(paragraphFromLine(line, undefined, settings));
    i += 1;
  }

  if (!children.length) {
    // 空文档：仅保留封面与目录，正文占位标题也放到封面逻辑中处理
    children.push(
      new Paragraph({
        children: [new TextRun({ text: "（正文为空）", font: exportFont(settings.bodyFont), size: halfPoints(settings.bodySize), color: "999999" })],
      }),
    );
  }

  const projectName = project.name || "未命名技术方案";
  const today = formatDocDate(project.updatedAt);

  // 封面页：标题居中、日期与署名靠下，整页结束后分页
  const coverChildren: FileChild[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 3200 },
      children: [
        new TextRun({ text: projectName, font: exportFont(settings.headingFont), bold: true, size: 56, color: "000000" }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 1600 },
      children: [new TextRun({ text: today, font: exportFont(settings.bodyFont), size: halfPoints(settings.bodySize), color: "666666" })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200 },
      children: [new TextRun({ text: "构案 · TechProposal Studio", font: exportFont(settings.bodyFont), size: halfPoints(Math.max(9, settings.bodySize - 2)), color: "999999" })],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  // 目录页：Word 在首次打开时根据标题样式 1-3 级更新目录和页码。
  const tocChildren: FileChild[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: twips(12) },
      children: [new TextRun({ text: "目录", font: exportFont(settings.headingFont), bold: true, size: halfPoints(settings.headingSizes[0]), color: "000000" })],
    }),
    new TableOfContents("目录", { hyperlink: true, headingStyleRange: "1-3", beginDirty: true }),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  const documentChildren: FileChild[] = [...coverChildren, ...tocChildren, ...children];

  return new Document({
    // DOCX 本身不排版、无法在导出时计算页码；由 Word 打开文档时更新 TOC 域。
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: { font: exportFont(settings.bodyFont), size: halfPoints(settings.bodySize), color: "000000" },
          paragraph: { spacing: { before: twips(settings.bodyBefore), after: twips(settings.bodyAfter), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO } },
        },
      },
      paragraphStyles: [
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          next: "Normal",
          run: { font: exportFont(settings.headingFont), size: halfPoints(settings.headingSizes[0]), bold: true, color: "000000" },
          paragraph: { spacing: { before: 0, after: twips(settings.headingAfter[0]), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO }, alignment: AlignmentType.CENTER, outlineLevel: 0 },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          run: { font: exportFont(settings.headingFont), size: halfPoints(settings.headingSizes[0]), bold: true, color: "000000" },
          paragraph: { spacing: { before: twips(settings.headingBefore[0]), after: twips(settings.headingAfter[0]), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO }, outlineLevel: 0 },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          run: { font: exportFont(settings.headingFont), size: halfPoints(settings.headingSizes[1]), bold: true, color: "000000" },
          paragraph: { spacing: { before: twips(settings.headingBefore[1]), after: twips(settings.headingAfter[1]), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO }, outlineLevel: 1 },
        },
        {
          id: "Heading3",
          name: "Heading 3",
          basedOn: "Normal",
          next: "Normal",
          run: { font: exportFont(settings.headingFont), size: halfPoints(settings.headingSizes[2]), bold: true, color: "000000" },
          paragraph: { spacing: { before: twips(settings.headingBefore[2]), after: twips(settings.headingAfter[2]), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO }, outlineLevel: 2 },
        },
        {
          id: "Heading4",
          name: "Heading 4",
          basedOn: "Normal",
          next: "Normal",
          run: { font: exportFont(settings.headingFont), size: halfPoints(settings.headingSizes[3]), bold: true, color: "000000" },
          paragraph: { spacing: { before: twips(settings.headingBefore[3]), after: twips(settings.headingAfter[3]), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO }, outlineLevel: 3 },
        },
        {
          id: "Heading5",
          name: "Heading 5",
          basedOn: "Normal",
          next: "Normal",
          run: { font: exportFont(settings.headingFont), size: halfPoints(settings.headingSizes[4]), bold: true, color: "000000" },
          paragraph: { spacing: { before: twips(settings.headingBefore[4]), after: twips(settings.headingAfter[4]), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO }, outlineLevel: 4 },
        },
        {
          id: "Heading6",
          name: "Heading 6",
          basedOn: "Normal",
          next: "Normal",
          run: { font: exportFont(settings.headingFont), size: halfPoints(settings.headingSizes[5]), bold: true, color: "000000" },
          paragraph: { spacing: { before: twips(settings.headingBefore[5]), after: twips(settings.headingAfter[5]), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO }, outlineLevel: 5 },
        },
        {
          id: "Code",
          name: "Code",
          basedOn: "Normal",
          run: { font: CODE_FONT, size: SIZE_CODE },
          paragraph: { shading: { fill: "F3F5F3" }, spacing: { before: 80, after: 80 } },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } },
        },
        children: documentChildren,
      },
    ],
  });
}

/** 文档日期：优先使用更新时间，回退到本地日期 */
function formatDocDate(ts?: number | string): string {
  let d: Date;
  if (typeof ts === "number") d = new Date(ts);
  else if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) d = new Date(ts);
  else d = new Date();
  if (Number.isNaN(d.getTime())) d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y} 年 ${m} 月 ${day} 日`;
}

function safeFileName(name: string): string {
  return (name || "技术方案").replace(/[<>:"/\\|?*]/g, "_");
}

/**
 * Browser / WebView: Packer.toBuffer uses Node buffers and throws
 * "nodebuffer is not supported by this platform". Prefer Blob/ArrayBuffer.
 */
export async function buildDocxBytes(project: Project, settings: DocxExportSettings = DEFAULT_DOCX_EXPORT_SETTINGS): Promise<Uint8Array> {
  const doc = await buildDocx(project, settings);
  try {
    const ab = await Packer.toArrayBuffer(doc);
    return new Uint8Array(ab);
  } catch {
    /* fall through */
  }
  try {
    const blob = await Packer.toBlob(doc);
    const ab = await blob.arrayBuffer();
    return new Uint8Array(ab);
  } catch {
    /* fall through */
  }
  // Node / vitest only
  const buf = await Packer.toBuffer(doc);
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayBuffer);
}

export async function downloadDocx(project: Project, settings: DocxExportSettings = DEFAULT_DOCX_EXPORT_SETTINGS): Promise<string | void> {
  const fileName = `${safeFileName(project.name)}.docx`;
  const check = await checkDocxImages(project);
  if (check.issues.length) throw new Error(`图片检查未通过：${check.issues.length} 个链接无法嵌入`);
  const bytes = await buildDocxBytes(project, settings);

  if (isDesktop()) {
    try {
      const path = await invoke<string | null>("save_binary_file", {
        defaultName: fileName,
        bytes: Array.from(bytes),
        filters: [["Word 文档", ["docx"]]],
        title: "导出 Word",
      });
      if (path) return path;
      return;
    } catch {
      const path = await invoke<string>("save_docx_export", {
        projectName: project.name,
        bytes: Array.from(bytes),
      });
      return path;
    }
  }

  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(anchor.href);
}
