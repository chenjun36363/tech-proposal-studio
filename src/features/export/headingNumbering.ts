import { AlignmentType, LevelFormat, LevelSuffix, type ILevelsOptions } from "docx";
import {
  HEADING_NUMBERING_SCHEMES,
  getHeadingNumberingScheme,
  resolveHeadingNumberingLevel,
  type HeadingNumberFormat,
  type HeadingNumberingScheme,
} from "../editor/headingNumbering";

export { HEADING_NUMBERING_SCHEMES, getHeadingNumberingScheme };
export type { HeadingNumberFormat, HeadingNumberingScheme };

export const HEADING_NUMBERING_REF = "heading-outline";

export interface HeadingNumberingOpts {
  headingFont: string;
  headingSizes: number[];
  lineSpacing: number;
  headingBefore: number[];
  headingAfter: number[];
}

const halfPoints = (points: number) => Math.max(1, Math.round(points * 2));

function toDocxLevelFormat(format: HeadingNumberFormat) {
  return format === "chinese-counting" ? LevelFormat.CHINESE_COUNTING : LevelFormat.DECIMAL;
}

/** 由共享方案生成 Word 多级列表定义；null 表示不编号。 */
export function buildHeadingNumberingLevels(
  schemeId: string,
  startLevel: number,
  opts: HeadingNumberingOpts,
): ILevelsOptions[] | null {
  if (!getHeadingNumberingScheme(schemeId)) return null;

  const start = Math.min(Math.max(Math.trunc(startLevel), 1), 6);
  const levels: ILevelsOptions[] = [];

  for (let headingLevel = start; headingLevel <= 6; headingLevel += 1) {
    const idx = headingLevel - 1;
    const spec = resolveHeadingNumberingLevel(schemeId, headingLevel, start);
    if (!spec) continue;

    levels.push({
      level: headingLevel - start,
      format: toDocxLevelFormat(spec.format),
      text: spec.text,
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
