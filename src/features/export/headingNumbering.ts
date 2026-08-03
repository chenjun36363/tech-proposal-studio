import { AlignmentType, LevelFormat, LevelSuffix, type ILevelsOptions } from "docx";

/**
 * 标题多级编号方案（"自定义标题样式"）。
 *
 * 这是一套**可扩展的注册表**：新增一种标题编号风格，只需在
 * `HEADING_NUMBERING_SCHEMES` 中追加一项即可，导出逻辑无需改动。
 *
 * 两种定义方式：
 *  - `levels`：逐级别（对应 H1..H6）显式给出编号格式与文本模板，适合中文层级
 *    这类每一级都不一样的方案；文本里可用 `%1`..`%6` 引用各级计数器。
 *  - `top` + `sub`：首级（文档最顶层标题）用 `top`，其余层级用 `sub` 自动拼接
 *    `%1.%2...`，适合"第一章 / 1.1 / 1.1.1"这类规律方案，并天然支持"从第 N 级
 *    开始编号"。
 */

export const HEADING_NUMBERING_REF = "heading-outline";

export type HeadingNumberFormat = (typeof LevelFormat)[keyof typeof LevelFormat];

export interface HeadingNumberingLevelSpec {
  format: HeadingNumberFormat;
  /** 文本模板，可含 `%1`..`%6` 计数器占位，例如 `第%1章`、`%1.%2`。 */
  text: string;
}

export interface HeadingNumberingScheme {
  /** 方案 id，持久化在 WordExportPreferences.headingNumbering。 */
  id: string;
  /** 设置面板中显示的中文名。 */
  label: string;
  /** 示例，例如"第一章 / 1.1 / 1.1.1"。 */
  description: string;
  /** 逐级别定义（H1..H6），优先级高于 top/sub。 */
  levels?: HeadingNumberingLevelSpec[];
  /** 首级（仅当作为文档最顶层标题且从第 1 级开始时使用）。 */
  top?: { format: HeadingNumberFormat; prefix: string; suffix: string };
  /** 其余层级：按 `%1.%2...` 拼接。 */
  sub?: { format: HeadingNumberFormat; separator: string };
}

const DEC = LevelFormat.DECIMAL;
const CN = LevelFormat.CHINESE_COUNTING;

/**
 * 预置方案。"none"（不加任何编号）通过 id 缺席表示，不在此列表内。
 * 需要预留更多风格时，直接在此数组追加即可。
 */
export const HEADING_NUMBERING_SCHEMES: HeadingNumberingScheme[] = [
  {
    id: "decimal",
    label: "数字编号",
    description: "1 / 1.1 / 1.1.1 / 1.1.1.1 …",
    top: { format: DEC, prefix: "", suffix: "" },
    sub: { format: DEC, separator: "." },
  },
  {
    id: "chapter",
    label: "中文章节（第一章）",
    description: "第一章 / 1.1 / 1.1.1 …",
    top: { format: CN, prefix: "第", suffix: "章" },
    sub: { format: DEC, separator: "." },
  },
  {
    id: "chapter-decimal",
    label: "第 N 章（阿拉伯数字）",
    description: "第1章 / 1.1 / 1.1.1 …",
    top: { format: DEC, prefix: "第", suffix: "章" },
    sub: { format: DEC, separator: "." },
  },
  {
    id: "section",
    label: "第 N 节",
    description: "第1节 / 1.1 / 1.1.1 …",
    top: { format: DEC, prefix: "第", suffix: "节" },
    sub: { format: DEC, separator: "." },
  },
  {
    id: "paren",
    label: "括号编号",
    description: "(1) / 1.1 / 1.1.1 …",
    top: { format: DEC, prefix: "(", suffix: ")" },
    sub: { format: DEC, separator: "." },
  },
  {
    id: "chinese-hier",
    label: "中文层级（一、 / （一） / 1. / (1)）",
    description: "一、 / （一） / 1. / (1) / 1.1 …",
    levels: [
      { format: CN, text: "%1、" }, // H1 一、
      { format: CN, text: "（%1）" }, // H2 （一）
      { format: DEC, text: "%1." }, // H3 1.
      { format: DEC, text: "(%1)" }, // H4 (1)
      { format: DEC, text: "%1." }, // H5 1.
      { format: DEC, text: "(%1)" }, // H6 (1)
    ],
  },
];

export function getHeadingNumberingScheme(id: string): HeadingNumberingScheme | null {
  if (!id || id === "none") return null;
  return HEADING_NUMBERING_SCHEMES.find((scheme) => scheme.id === id) ?? null;
}

export interface HeadingNumberingOpts {
  headingFont: string;
  headingSizes: number[];
  lineSpacing: number;
  headingBefore: number[];
  headingAfter: number[];
}

const halfPoints = (points: number) => Math.max(1, Math.round(points * 2));

/**
 * 生成多级编号的 level 定义（对应 docx 的 ILevelsOptions[]）。
 * 返回 null 表示不编号（"none"）。
 *
 * @param schemeId   方案 id
 * @param startLevel 从第几级标题开始编号（1..6，默认 1）
 * @param opts       标题字体/字号等，用于让编号数字与标题外观一致
 */
export function buildHeadingNumberingLevels(
  schemeId: string,
  startLevel: number,
  opts: HeadingNumberingOpts,
): ILevelsOptions[] | null {
  const scheme = getHeadingNumberingScheme(schemeId);
  if (!scheme) return null;

  const start = Math.min(Math.max(startLevel, 1), 6);
  const levels: ILevelsOptions[] = [];

  for (let k = 0; start + k <= 6; k += 1) {
    const headingLevel = start + k; // 1-based 绝对标题级别（H1..H6）
    const idx = headingLevel - 1; // 0-based，用于读取字号数组

    let format: HeadingNumberFormat;
    let text: string;

    if (scheme.levels) {
      const spec = scheme.levels[idx] ?? { format: DEC, text: "%1" };
      format = spec.format;
      text = spec.text;
    } else if (k === 0 && start === 1 && scheme.top) {
      format = scheme.top.format;
      text = `${scheme.top.prefix}%1${scheme.top.suffix}`;
    } else {
      const sep = scheme.sub?.separator ?? ".";
      format = scheme.sub?.format ?? DEC;
      // 当前层级在"已编号层级"中的位置为 k+1，拼接 k+1 个计数器。
      text = Array.from({ length: k + 1 }, (_unused, i) => `%${i + 1}`).join(sep);
    }

    levels.push({
      level: k,
      format,
      text,
      alignment: AlignmentType.START,
      style: {
        style: `Heading${headingLevel}`,
        run: {
          font: { eastAsia: opts.headingFont, ascii: opts.headingFont, hAnsi: opts.headingFont },
          size: halfPoints(opts.headingSizes[idx] ?? opts.headingSizes[0]),
          bold: true,
          color: "000000",
        },
      },
      suffix: LevelSuffix.SPACE,
    });
  }

  return levels;
}
