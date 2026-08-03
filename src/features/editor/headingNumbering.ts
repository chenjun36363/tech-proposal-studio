import type { HeadingNumberingPreferences } from "../../core/types";

export type HeadingNumberFormat = "decimal" | "chinese-counting";

export interface HeadingNumberingLevelSpec {
  format: HeadingNumberFormat;
  /** 文本模板，可含 `%1`..`%6` 计数器占位。 */
  text: string;
}

export interface HeadingNumberingScheme {
  id: string;
  label: string;
  description: string;
  /** 按绝对 Markdown 标题级别（H1..H6）定义。 */
  levels?: HeadingNumberingLevelSpec[];
  /** 当前编号范围的首级样式。 */
  top?: { format: HeadingNumberFormat; prefix: string; suffix: string };
  /** 当前编号范围的后续级别样式。 */
  sub?: { format: HeadingNumberFormat; separator: string };
}

const DEC: HeadingNumberFormat = "decimal";
const CN: HeadingNumberFormat = "chinese-counting";

export const DEFAULT_HEADING_NUMBERING_PREFERENCES: HeadingNumberingPreferences = {
  schemeId: "chapter-decimal",
  startLevel: 2,
};

/** Markdown 与 Word 共用的标题编号方案注册表。 */
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
    label: "第一章",
    description: "第一章 / 1.1 / 1.1.1 …",
    top: { format: CN, prefix: "第", suffix: "章" },
    sub: { format: DEC, separator: "." },
  },
  {
    id: "chapter-decimal",
    label: "第 N 章",
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
    label: "中文层级",
    description: "一、 / （一） / 1. / (1) / 1.1 …",
    levels: [
      { format: CN, text: "%1、" },
      { format: CN, text: "（%1）" },
      { format: DEC, text: "%1." },
      { format: DEC, text: "(%1)" },
      { format: DEC, text: "%1." },
      { format: DEC, text: "(%1)" },
    ],
  },
];

export function getHeadingNumberingScheme(id: string): HeadingNumberingScheme | null {
  if (!id || id === "none") return null;
  return HEADING_NUMBERING_SCHEMES.find((scheme) => scheme.id === id) ?? null;
}

export function normalizeHeadingNumberingPreferences(
  value?: Partial<HeadingNumberingPreferences> | null,
): HeadingNumberingPreferences {
  const schemeId = value?.schemeId === "none" || getHeadingNumberingScheme(value?.schemeId ?? "")
    ? value!.schemeId!
    : DEFAULT_HEADING_NUMBERING_PREFERENCES.schemeId;
  const rawStart = typeof value?.startLevel === "number" ? Math.trunc(value.startLevel) : DEFAULT_HEADING_NUMBERING_PREFERENCES.startLevel;
  return {
    schemeId,
    startLevel: Math.min(Math.max(rawStart, 1), 6),
  };
}

/** 返回某个绝对标题级别在当前编号范围内使用的共享模板。 */
export function resolveHeadingNumberingLevel(
  schemeId: string,
  headingLevel: number,
  startLevel: number,
): HeadingNumberingLevelSpec | null {
  const scheme = getHeadingNumberingScheme(schemeId);
  const start = Math.min(Math.max(Math.trunc(startLevel), 1), 6);
  const level = Math.min(Math.max(Math.trunc(headingLevel), 1), 6);
  if (!scheme || level < start) return null;

  if (scheme.levels) {
    return scheme.levels[level - 1] ?? { format: DEC, text: "%1" };
  }

  const relativeLevel = level - start;
  if (relativeLevel === 0 && scheme.top) {
    return {
      format: scheme.top.format,
      text: `${scheme.top.prefix}%1${scheme.top.suffix}`,
    };
  }

  const separator = scheme.sub?.separator ?? ".";
  return {
    format: scheme.sub?.format ?? DEC,
    text: Array.from({ length: relativeLevel + 1 }, (_, index) => `%${index + 1}`).join(separator),
  };
}

function chineseNumber(value: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (value < 10) return digits[value];
  if (value < 20) return `十${value % 10 ? digits[value % 10] : ""}`;
  if (value < 100) return `${digits[Math.floor(value / 10)]}十${value % 10 ? digits[value % 10] : ""}`;
  return String(value);
}

function formatCounter(value: number, format: HeadingNumberFormat): string {
  return format === CN ? chineseNumber(value) : String(value);
}

/** 使用与 DOCX 多级列表相同的方案，为 Markdown 标题生成固定编号文本。 */
export function formatMarkdownHeadingPrefix(
  schemeId: string,
  headingLevel: number,
  startLevel: number,
  counters: number[],
): string {
  const scheme = getHeadingNumberingScheme(schemeId);
  const spec = resolveHeadingNumberingLevel(schemeId, headingLevel, startLevel);
  if (!scheme || !spec) return "";

  if (scheme.levels) {
    // 固定中文层级方案的 `%1` 表示“当前绝对标题级别”的计数器，
    // 而不是 H1 的计数器；这样从 H2/H3 起始时仍能独立编号。
    const currentValue = counters[headingLevel - 1] || 1;
    return spec.text.replace(/%\d+/g, () => formatCounter(currentValue, spec.format));
  }

  const start = Math.min(Math.max(Math.trunc(startLevel), 1), 6);
  const relativeCounters = counters.slice(start - 1, headingLevel);
  const isTopLevel = headingLevel === start;
  return spec.text.replace(/%(\d+)/g, (_placeholder, indexText: string) => {
    const index = Number(indexText) - 1;
    // “第一章”只在首级标题自身使用中文数字；其子级按方案描述输出 1.1、1.1.1。
    const format = isTopLevel ? (scheme.top?.format ?? DEC) : (scheme.sub?.format ?? DEC);
    return formatCounter(relativeCounters[index] || 1, format);
  });
}
