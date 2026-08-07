import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LineRuleType,
  LevelFormat,
  PageBreak,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
  type FileChild,
  type ILevelsOptions,
  type IImageOptions,
} from "docx";
import type { Project, WordExportPreferences } from "../../core/types";
import {
  HEADING_NUMBERING_REF,
  buildHeadingNumberingLevels,
} from "./headingNumbering";
import { exportMarkdown } from "../workspace/storage";
import { isDesktop } from "../../services/runtime";
import { DEFAULT_WORD_EXPORT_PREFERENCES } from "../../core/data";
import { invoke } from "@tauri-apps/api/core";
import { readBinaryFile } from "../workspace/workspace";
import { stripHeadingPrefix } from "../editor/markdownDoc";
import { normalizeHeadingNumberingPreferences } from "../editor/headingNumbering";

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

const ORDERED_LIST_REFERENCE = "markdown-ordered-list";
const MAX_LIST_LEVEL = 8;

/** Convert Markdown indentation to a supported Word list level. */
function markdownListLevel(leadingWhitespace: string): number {
  const spaces = leadingWhitespace.replace(/\t/g, "    ").length;
  return Math.min(MAX_LIST_LEVEL, Math.floor(spaces / 2));
}

function orderedListLevels(settings: DocxExportSettings) {
  return Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.START,
    style: {
      run: { font: exportFont(settings.bodyFont), size: halfPoints(settings.bodySize) },
      paragraph: { indent: { left: 720 + level * 360, hanging: 360 } },
    },
  }));
}

export interface DocxExportSettings extends WordExportPreferences {
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
  ...DEFAULT_WORD_EXPORT_PREFERENCES,
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
    .replace(new RegExp(`!\\[([^\\]]*)\\]\\(\\s*(?:<([^>]+)>|${IMAGE_DEST_SEGMENT}(?:\\s+["'][^"']*["'])?)\\s*\\)`, "g"), "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

function runsFromInline(
  line: string,
  base?: { bold?: boolean; italics?: boolean; color?: string; font?: typeof BODY_FONT | string; size?: number },
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
          bold: base?.bold,
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
      pieces.push(new TextRun({ text: token.slice(1, -1), font: CODE_FONT, size: SIZE_CODE, bold: base?.bold }));
    } else if (token.startsWith("*") && token.endsWith("*")) {
      pieces.push(
        new TextRun({
          text: token.slice(1, -1),
          font,
          size,
          bold: base?.bold,
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
        bold: base?.bold,
        italics: base?.italics,
        color: base?.color,
      }),
    );
  }
  if (!pieces.length) pieces.push(new TextRun({ text: " ", font, size }));
  return pieces;
}

/** Returns the same first-line offset used by regular body paragraphs. */
function bodyFirstLineIndent(settings: DocxExportSettings): number {
  return Math.round(settings.firstLineIndent * settings.bodySize * 20);
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
    indent: { firstLine: bodyFirstLineIndent(settings) },
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

interface DocxTableCellSource {
  text: string;
  columnSpan?: number;
  rowSpan?: number;
  bold?: boolean;
}

/** Parse a positive HTML span attribute, falling back to one cell. */
function htmlSpan(attributes: string, name: "colspan" | "rowspan"): number {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  const value = Number.parseInt(match?.[1] ?? match?.[2] ?? match?.[3] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Convert the small inline-HTML subset used inside imported table cells to Markdown runs. */
function htmlCellToMarkdown(html: string): string {
  const withoutTags = html
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<(?:strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/(?:strong|b)\s*>/gi, "**")
    .replace(/<(?:em|i)\b[^>]*>/gi, "*")
    .replace(/<\/(?:em|i)\s*>/gi, "*")
    .replace(/<[^>]+>/g, " ");

  return withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_all, encoded: string) => {
      const codePoint = encoded.startsWith("x")
        ? Number.parseInt(encoded.slice(1), 16)
        : Number.parseInt(encoded, 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read a raw HTML table from Markdown. It deliberately only accepts td/th cells so
 * arbitrary HTML remains ordinary paragraph content instead of becoming a table.
 */
function parseHtmlTableRows(html: string): DocxTableCellSource[][] {
  const rows: DocxTableCellSource[][] = [];
  const rowMatcher = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowMatcher.exec(html))) {
    const cells: DocxTableCellSource[] = [];
    const cellMatcher = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellMatcher.exec(rowMatch[1]))) {
      cells.push({
        text: htmlCellToMarkdown(cellMatch[3]),
        columnSpan: htmlSpan(cellMatch[2], "colspan"),
        rowSpan: htmlSpan(cellMatch[2], "rowspan"),
        bold: cellMatch[1].toLowerCase() === "th",
      });
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function tableFromCells(rows: DocxTableCellSource[][], settings: DocxExportSettings = DEFAULT_DOCX_EXPORT_SETTINGS): Table {
  const colCount = Math.max(...rows.map((row) => row.reduce((count, cell) => count + (cell.columnSpan ?? 1), 0)), 1);
  const columnWidth = Math.floor(9000 / colCount);
  // 表格边框：1pt(=size 8) 实线，深灰，确保网格线清晰可见
  const cellBorder = {
    style: BorderStyle.SINGLE,
    size: 8,
    color: "808080",
  } as const;
  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    columnWidths: Array.from({ length: colCount }, () => columnWidth),
    borders: {
      top: cellBorder,
      bottom: cellBorder,
      left: cellBorder,
      right: cellBorder,
      insideHorizontal: cellBorder,
      insideVertical: cellBorder,
    },
    rows: rows.map(
      (row) =>
        new TableRow({
          children: row.map((cell) => {
            const columnSpan = cell.columnSpan ?? 1;
            return new TableCell({
              width: { size: columnWidth * columnSpan, type: WidthType.DXA },
              columnSpan: columnSpan > 1 ? columnSpan : undefined,
              rowSpan: cell.rowSpan && cell.rowSpan > 1 ? cell.rowSpan : undefined,
              borders: {
                top: cellBorder,
                bottom: cellBorder,
                left: cellBorder,
                right: cellBorder,
              },
              children: [
                new Paragraph({
                  children: runsFromInline(cell.text || " ", {
                    bold: cell.bold,
                    font: exportFont(settings.bodyFont),
                    size: halfPoints(Math.max(9, settings.bodySize - 2)),
                  }, settings),
                }),
              ],
            });
          }),
        }),
    ),
  });
}

function tableFromMarkdown(rows: string[][], settings: DocxExportSettings = DEFAULT_DOCX_EXPORT_SETTINGS): Table {
  return tableFromCells(
    rows.map((row, rowIndex) => row.map((text) => ({ text, bold: rowIndex === 0 }))),
    settings,
  );
}

function tableFromHtml(html: string, settings: DocxExportSettings = DEFAULT_DOCX_EXPORT_SETTINGS): Table | null {
  const rows = parseHtmlTableRows(html);
  return rows.length ? tableFromCells(rows, settings) : null;
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

/**
 * Markdown 图片目标片段：允许括号成对出现（如 `assets/…YD20260804(1)/a.png`），
 * 单个正则无法做括号配平，这里用一个可复用的片段组合。
 */
const IMAGE_DEST_SEGMENT = "(?:[^\\s()]|\\([^)]*\\))+";

const IMAGE_LINK_PATTERN = new RegExp(
  `!\\[([^\\]]*)\\]\\(\\s*(?:<([^>]+)>|(${IMAGE_DEST_SEGMENT})(?:\\s+["'][^"']*["'])?)\\s*\\)`,
  "g",
);

export function extractMarkdownImages(markdown: string): Array<{ alt: string; source: string }> {
  const images: Array<{ alt: string; source: string }> = [];
  const pattern = new RegExp(IMAGE_LINK_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown))) {
    images.push({ alt: match[1], source: match[2] ?? match[3] });
  }
  return images;
}

function matchImageOnly(line: string): { alt: string; source: string } | null {
  const match = line.match(
    new RegExp(`^\\s*!\\[([^\\]]*)\\]\\(\\s*(?:<([^>]+)>|(${IMAGE_DEST_SEGMENT})(?:\\s+["'][^"']*["'])?)\\s*\\)\\s*$`),
  );
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
    if (isDesktop() && !/^(https?:|data:|blob:|file:)/i.test(path)) {
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
    alignment: AlignmentType.CENTER,
    children: [new ImageRun(options)],
    spacing: { before: 120, after: 120 },
  });
}

async function coverLogoParagraph(project: Project, settings: DocxExportSettings): Promise<Paragraph | null> {
  const source = settings.coverLogoDataUrl.trim();
  if (!source) return null;

  const resolved = resolveLocalImagePath(source, project.filePath, project.workspace?.root) ?? source;
  const bytes = await loadImageBytes(resolved);
  if (!bytes?.length) return null;

  const type = imageTypeFromPath(resolved) ?? sniffImageType(bytes);
  if (!type) return null;

  const natural = readImageSize(bytes, type);
  const sized = scaleImage(natural.width, natural.height, 180);
  return new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { before: 280, after: 0 },
    children: [new ImageRun({
      type,
      data: bytes,
      transformation: { width: sized.width, height: sized.height },
      altText: { name: "封面 Logo", description: "封面右上角 Logo", title: "封面 Logo" },
    })],
  });
}

function coverContactParagraph(text: string, before = 0, options: { font?: string | Record<string, string>; size?: number; color?: string; bold?: boolean } = {}): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { before, after: 0 },
    children: [new TextRun({
      text,
      font: options.font ?? exportFont("宋体"),
      size: options.size ?? halfPoints(12),
      color: options.color ?? "000000",
      bold: options.bold,
    })],
  });
}

interface HeadingNumberingRef {
  reference: string;
  startLevel: number;
}

function headingParagraph(level: number, title: string, numbering: HeadingNumberingRef | null): Paragraph {
  const clamped = Math.min(Math.max(level, 1), 6);
  // Keep heading formatting in the built-in Word style instead of applying
  // direct run/paragraph formatting. This lets users insert another heading
  // from Word's style gallery and get exactly the same appearance.
  const base = {
    children: [new TextRun({ text: title })],
    heading: HEADING_LEVELS[clamped - 1],
  } as const;
  if (numbering && level >= numbering.startLevel) {
    // 挂上多级项目编号：编号数字由文档 numbering 定义生成（含第一章/1.1 等），
    // 标题文字与样式仍由内置 Heading 样式提供，目录也会带上编号。
    return new Paragraph({
      ...base,
      numbering: { reference: numbering.reference, level: level - numbering.startLevel },
    });
  }
  return new Paragraph(base);
}

function builtInHeadingStyle(index: number, settings: DocxExportSettings) {
  return {
    basedOn: "Normal",
    next: "Normal",
    uiPriority: 9,
    quickFormat: true,
    unhideWhenUsed: true,
    run: {
      font: exportFont(settings.headingFont),
      size: halfPoints(settings.headingSizes[index]),
      bold: true,
      color: "000000",
    },
    paragraph: {
      spacing: {
        before: twips(settings.headingBefore[index]),
        after: twips(settings.headingAfter[index]),
        line: lineTwips(settings.lineSpacing),
        lineRule: LineRuleType.AUTO,
      },
      outlineLevel: index,
      keepNext: true,
      keepLines: true,
    },
  };
}

/** Build DOCX from project markdown body (fallback to legacy sections). */
export async function buildDocx(project: Project, configuredSettings?: DocxExportSettings): Promise<Document> {
  // Project-level Word preferences are the persistent baseline. The export dialog
  // may provide temporary typography overrides without losing those settings.
  const settings: DocxExportSettings = {
    ...DEFAULT_DOCX_EXPORT_SETTINGS,
    ...project.wordExport,
    ...configuredSettings,
    headingSizes: [...(configuredSettings?.headingSizes ?? DEFAULT_DOCX_EXPORT_SETTINGS.headingSizes)] as DocxExportSettings["headingSizes"],
    headingBefore: [...(configuredSettings?.headingBefore ?? DEFAULT_DOCX_EXPORT_SETTINGS.headingBefore)] as DocxExportSettings["headingBefore"],
    headingAfter: [...(configuredSettings?.headingAfter ?? DEFAULT_DOCX_EXPORT_SETTINGS.headingAfter)] as DocxExportSettings["headingAfter"],
  };
  const headingNumbering = normalizeHeadingNumberingPreferences(project.headingNumbering);
  const headingNumberingStart = headingNumbering.startLevel;
  const headingNumberingLevels: ILevelsOptions[] | null =
    headingNumbering.schemeId !== "none"
      ? buildHeadingNumberingLevels(headingNumbering.schemeId, headingNumberingStart, {
          headingFont: settings.headingFont,
          headingSizes: settings.headingSizes,
          lineSpacing: settings.lineSpacing,
          headingBefore: settings.headingBefore,
          headingAfter: settings.headingAfter,
        })
      : null;
  const headingNumberingRef = headingNumberingLevels
    ? { reference: HEADING_NUMBERING_REF, startLevel: headingNumberingStart }
    : null;

  const markdown = exportMarkdown(project);
  const children: FileChild[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let sawTitle = false;
  let orderedListInstance = 0;
  let inOrderedList = false;
  let i = 0;
  const filePath = project.filePath;
  const workspaceRoot = project.workspace?.root;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      inOrderedList = false;
      i += 1;
      continue;
    }
    if (inCode) {
      inOrderedList = false;
      children.push(paragraphFromLine(line, { code: true }, settings));
      i += 1;
      continue;
    }

    const orderedItem = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (orderedItem) {
      if (!inOrderedList) orderedListInstance += 1;
      inOrderedList = true;
      children.push(
        new Paragraph({
          children: runsFromInline(orderedItem[2], {
            font: exportFont(settings.bodyFont),
            size: halfPoints(settings.bodySize),
          }, settings),
          numbering: {
            reference: ORDERED_LIST_REFERENCE,
            level: markdownListLevel(orderedItem[1]),
            instance: orderedListInstance,
          },
        }),
      );
      i += 1;
      continue;
    }
    inOrderedList = false;

    // Raw HTML table block (including imported tables with rowspan / colspan).
    if (/^\s*<table\b[^>]*>/i.test(line)) {
      let end = i;
      while (end < lines.length && !/<\/table\s*>/i.test(lines[end])) end += 1;
      if (end < lines.length) {
        const table = tableFromHtml(lines.slice(i, end + 1).join("\n"), settings);
        if (table) {
          children.push(table);
          i = end + 1;
          continue;
        }
      }
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
      const markdownTitle = plainText(heading[2].trim());
      const isDocumentTitle = level === 1 && !sawTitle;
      if (isDocumentTitle) {
        sawTitle = true;
        // 文档标题已放在封面页，正文中不再重复渲染（仅当与项目名一致时）
        if (markdownTitle && markdownTitle === (project.name || "").trim()) {
          i += 1;
          continue;
        }
      }
      // Word 多级列表是导出文档中的编号真值。启用自动编号后，先移除
      // Markdown 标题里已有的固定编号，避免出现“第一章 第1章 标题”或
      // “1.1 1.1 标题”；Markdown 源文件本身保持不变。
      const activeNumbering = isDocumentTitle ? null : headingNumberingRef;
      const title = activeNumbering && level >= activeNumbering.startLevel
        ? stripHeadingPrefix(markdownTitle)
        : markdownTitle;
      children.push(headingParagraph(level, title, activeNumbering));
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
    const inlineImageRe = new RegExp(IMAGE_LINK_PATTERN.source, "g");
    if (inlineImageRe.test(line)) {
      inlineImageRe.lastIndex = 0;
      let textBuf = "";
      let lastEnd = 0;
      let imgMatch: RegExpExecArray | null;
      while ((imgMatch = inlineImageRe.exec(line))) {
        const alt = imgMatch[1];
        const source = imgMatch[2] ?? imgMatch[3];
        if (imgMatch.index > lastEnd) textBuf += line.slice(lastEnd, imgMatch.index);
        if (textBuf.trim()) {
          children.push(paragraphFromLine(textBuf.trim(), undefined, settings));
          textBuf = "";
        }
        children.push(await paragraphFromImage(alt, source, filePath, workspaceRoot, settings));
        lastEnd = inlineImageRe.lastIndex;
      }
      if (lastEnd < line.length) textBuf += line.slice(lastEnd);
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
          // Keep the item text aligned with the first character of ordinary body text.
          // The bullet itself hangs in the margin immediately to its left.
          indent: { left: bodyFirstLineIndent(settings), hanging: Math.min(360, bodyFirstLineIndent(settings)) },
          bullet: { level: 0 },
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

  // 封面页：右上角 Logo、居中标题和右下角公司联系信息，整页结束后分页。
  const logo = await coverLogoParagraph(project, settings);
  const coverChildren: FileChild[] = [
    ...(logo ? [logo] : []),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: logo ? 1700 : 3200 },
      children: [
        new TextRun({ text: projectName, font: exportFont(settings.headingFont), bold: true, size: 56, color: "000000" }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 900 },
      children: [new TextRun({ text: today, font: exportFont(settings.bodyFont), size: halfPoints(settings.bodySize), color: "666666" })],
    }),
    coverContactParagraph(settings.companyNameZh, 1300, { font: exportFont("黑体"), size: halfPoints(22), color: "0070C0", bold: true }),
    coverContactParagraph(settings.companyNameEn, 80, { font: "Arial", size: halfPoints(9), color: "0070C0" }),
    coverContactParagraph(settings.companyAddress, 360),
    coverContactParagraph(settings.companyPhone, 40),
    coverContactParagraph(settings.companyFax, 40),
    coverContactParagraph(settings.companyWebsite, 40),
    coverContactParagraph(settings.companyEmail, 40),
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
    numbering: {
      config: [
        {
          reference: ORDERED_LIST_REFERENCE,
          levels: orderedListLevels(settings),
        },
        ...(headingNumberingLevels
          ? [{ reference: HEADING_NUMBERING_REF, levels: headingNumberingLevels }]
          : []),
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: exportFont(settings.bodyFont), size: halfPoints(settings.bodySize), color: "000000" },
          paragraph: { spacing: { before: twips(settings.bodyBefore), after: twips(settings.bodyAfter), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO } },
        },
        title: {
          basedOn: "Normal",
          next: "Normal",
          uiPriority: 10,
          quickFormat: true,
          run: { font: exportFont(settings.headingFont), size: halfPoints(settings.headingSizes[0]), bold: true, color: "000000" },
          paragraph: { spacing: { before: 0, after: twips(settings.headingAfter[0]), line: lineTwips(settings.lineSpacing), lineRule: LineRuleType.AUTO }, alignment: AlignmentType.CENTER },
        },
        // Configure docx's built-in Heading1~Heading6 definitions directly.
        // Do not redeclare those IDs in paragraphStyles: duplicate style IDs make
        // Word treat the visible formatting and its built-in heading gallery inconsistently.
        heading1: builtInHeadingStyle(0, settings),
        heading2: builtInHeadingStyle(1, settings),
        heading3: builtInHeadingStyle(2, settings),
        heading4: builtInHeadingStyle(3, settings),
        heading5: builtInHeadingStyle(4, settings),
        heading6: builtInHeadingStyle(5, settings),
      },
      paragraphStyles: [
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
        headers: settings.headerTitle.trim() ? {
          default: new Header({
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: settings.headerTitle.trim(), font: exportFont(settings.bodyFont), size: halfPoints(10.5), color: "666666" })],
            })],
          }),
        } : undefined,
        footers: settings.showFooterPageNumbers ? {
          default: new Footer({
            children: [new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                new TextRun({ text: "第 ", font: exportFont(settings.bodyFont), size: halfPoints(10.5), color: "666666" }),
                new TextRun({ children: [PageNumber.CURRENT], font: exportFont(settings.bodyFont), size: halfPoints(10.5), color: "666666" }),
                new TextRun({ text: " 页 / 共 ", font: exportFont(settings.bodyFont), size: halfPoints(10.5), color: "666666" }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES], font: exportFont(settings.bodyFont), size: halfPoints(10.5), color: "666666" }),
                new TextRun({ text: " 页", font: exportFont(settings.bodyFont), size: halfPoints(10.5), color: "666666" }),
              ],
            })],
          }),
        } : undefined,
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
export async function buildDocxBytes(project: Project, settings?: DocxExportSettings): Promise<Uint8Array> {
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

export async function downloadDocx(project: Project, settings?: DocxExportSettings): Promise<string | null | void> {
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
      return path;
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
