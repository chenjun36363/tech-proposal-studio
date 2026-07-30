import type { AgentDraft } from "./agent/protocol";

export interface HeadingNode {
  heading: MdHeading;
  children: HeadingNode[];
}

export type HeadingNumberingStyle = "chapter-h2" | "chapter-h1";

export function buildHeadingTree(headings: MdHeading[]): HeadingNode[] {
  const root: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  for (const h of headings) {
    const node: HeadingNode = { heading: h, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].heading.level >= h.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }
  return root;
}

export interface MdHeading {
  id: string;
  level: number;
  title: string;
  line: number;
  /** start offset in full markdown (heading line start) */
  start: number;
  /** end offset exclusive of this section body (next same-or-higher heading, or EOF) */
  end: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function slugifyHeading(title: string, used: Map<string, number>): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-_]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "section";
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

export function parseMarkdownHeadings(markdown: string): MdHeading[] {
  const lines = markdown.split(/\n/);
  const starts: { level: number; title: string; line: number; start: number }[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(HEADING_RE);
    if (m) {
      starts.push({ level: m[1].length, title: m[2].trim(), line: i, start: offset });
    }
    offset += line.length + (i < lines.length - 1 ? 1 : 0);
  }
  const used = new Map<string, number>();
  return starts.map((h, idx) => {
    let end = markdown.length;
    for (let j = idx + 1; j < starts.length; j++) {
      if (starts[j].level <= h.level) {
        end = starts[j].start;
        break;
      }
    }
    return {
      id: slugifyHeading(h.title, used),
      level: h.level,
      title: h.title,
      line: h.line,
      start: h.start,
      end,
    };
  });
}

export function sectionBody(markdown: string, heading: MdHeading): string {
  return markdown.slice(heading.start, heading.end).replace(/\s+$/, "");
}

export interface ShiftHeadingSectionResult {
  markdown: string;
  headingId: string;
  changedCount: number;
}

/** Shift a heading and every descendant by one level, then refresh document numbering. */
export function shiftHeadingSectionLevels(markdown: string, headingId: string, direction: "promote" | "demote", style: HeadingNumberingStyle = "chapter-h2"): ShiftHeadingSectionResult {
  const headings = parseMarkdownHeadings(markdown);
  const heading = headings.find(item => item.id === headingId);
  if (!heading) throw new Error("目标标题已不存在");
  const sectionHeadings = headings.filter(item => item.start >= heading.start && item.start < heading.end);
  if (direction === "promote" && heading.level === 1) throw new Error("H1 已是最高标题级别，不能继续升级");
  if (direction === "demote") {
    if (sectionHeadings.some(item => item.level >= 6)) throw new Error("子标题中包含 H6，无法整体降级");
  }

  const delta = direction === "promote" ? -1 : 1;
  const affectedLines = new Set(sectionHeadings.map(item => item.line));
  const lines = markdown.split("\n");
  for (const lineIndex of affectedLines) {
    lines[lineIndex] = lines[lineIndex].replace(/^(#{1,6})(\s+)/, (_match, hashes: string, spacing: string) => `${"#".repeat(hashes.length + delta)}${spacing}`);
  }
  const next = renumberHeadings(lines.join("\n"), style);
  const shifted = parseMarkdownHeadings(next).find(item => item.line === heading.line);
  if (!shifted) throw new Error("标题层级调整后无法定位目标章节");
  return { markdown: next, headingId: shifted.id, changedCount: sectionHeadings.length };
}

/** Count visible non-whitespace characters while excluding Markdown syntax. */
export function countMarkdownWords(markdown: string): number {
  return markdown
    .replace(/```[\s\S]*?```/g, block => block.replace(/^```[^\n]*\n?|```$/g, ""))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s/g, "")
    .length;
}

export function replaceSection(markdown: string, heading: MdHeading, nextBody: string): string {
  const body = heading.end < markdown.length && !nextBody.endsWith("\n")
    ? `${nextBody}\n`
    : nextBody;
  return markdown.slice(0, heading.start) + body + markdown.slice(heading.end);
}

export type SectionMovePosition = "before" | "after";

/** Move a heading together with its body and descendants relative to another heading. */
export function moveSection(
  markdown: string,
  source: MdHeading,
  target: MdHeading,
  position: SectionMovePosition,
): string {
  if (source.id === target.id) return markdown;
  if (target.start > source.start && target.start < source.end) return markdown;
  if (position === "before" && source.end === target.start) return markdown;
  if (position === "after" && target.end === source.start) return markdown;

  const section = markdown.slice(source.start, source.end);
  const withoutSource = markdown.slice(0, source.start) + markdown.slice(source.end);
  const originalInsertion = position === "before" ? target.start : target.end;
  const insertion = originalInsertion >= source.end
    ? originalInsertion - (source.end - source.start)
    : originalInsertion;
  const left = withoutSource.slice(0, insertion).replace(/\n*$/, "");
  const right = withoutSource.slice(insertion).replace(/^\n*/, "");
  return [left, section.trim(), right].filter(Boolean).join("\n\n");
}

/** Remove a heading and its entire body/descendants from the document. */
export function deleteSection(markdown: string, heading: MdHeading): string {
  return markdown.slice(0, heading.start) + markdown.slice(heading.end);
}

/** Insert a complete Markdown section before or after a target section. */
export function insertSection(
  markdown: string,
  target: MdHeading,
  position: SectionMovePosition,
  sectionMarkdown: string,
): string {
  const section = sectionMarkdown.trim();
  if (!section) throw new Error("插入章节不能为空");
  const firstHeading = section.match(/^(#{1,6})\s+(.+?)\s*$/m);
  if (!firstHeading || firstHeading.index !== 0) throw new Error("插入内容必须以 Markdown 标题开头");
  if (firstHeading[1].length <= 1) throw new Error("不能插入新的文档 H1 标题");
  if (target.level <= 1 && position === "before") throw new Error("不能在文档 H1 标题之前插入章节");
  const insertion = position === "before" ? target.start : target.end;
  const left = markdown.slice(0, insertion).replace(/\n*$/, "");
  const right = markdown.slice(insertion).replace(/^\n*/, "");
  return [left, section, right].filter(Boolean).join("\n\n");
}

/** Replace an absolute Markdown text range after checking its original snapshot. */
export function replaceSelection(
  markdown: string,
  start: number,
  end: number,
  expected: string,
  replacement: string,
): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > markdown.length) {
    throw new Error("选区范围无效");
  }
  if (markdown.slice(start, end) !== expected) throw new Error("文档已变化，选区原文不再匹配");
  return markdown.slice(0, start) + replacement + markdown.slice(end);
}

export interface AppliedAgentDraft {
  markdown: string;
  headingId?: string;
  selectionStart?: number;
  selectionEnd?: number;
}

function targetHeading(markdown: string, draft: AgentDraft): MdHeading {
  const sectionId = draft.target.sectionId;
  const heading = sectionId ? parseMarkdownHeadings(markdown).find(item => item.id === sectionId) : undefined;
  if (!heading) throw new Error("文档已变化，目标章节已不存在");
  const expected = draft.target.snapshot ?? draft.before;
  if (sectionBody(markdown, heading) !== expected) throw new Error("文档已变化，目标章节原文不再匹配");
  return heading;
}

function headingAtOrBefore(markdown: string, offset: number): MdHeading | undefined {
  const headings = parseMarkdownHeadings(markdown);
  return headings.filter(item => item.start <= offset).at(-1) ?? headings[0];
}

function headingAtOrAfter(markdown: string, offset: number): MdHeading | undefined {
  const headings = parseMarkdownHeadings(markdown);
  return headings.find(item => item.start >= offset) ?? headings.at(-1);
}

/** Apply one reviewed Agent proposal to the latest document with stale-target protection. */
export function applyAgentDraft(markdown: string, draft: AgentDraft): AppliedAgentDraft {
  if (draft.operation === "replace_document") {
    if (markdown !== draft.target.snapshot) throw new Error("文档已发生变化，请重新执行 Agent 任务");
    return { markdown: draft.after, headingId: parseMarkdownHeadings(draft.after)[0]?.id };
  }
  if (draft.operation === "replace_selection") {
    const start = draft.target.selectionStart;
    const end = draft.target.selectionEnd;
    if (start === undefined || end === undefined) throw new Error("提案缺少选区范围");
    const replaced = replaceSelection(markdown, start, end, draft.before, draft.after);
    const touchesHeading = /^(?:#{1,6})\s+/m.test(draft.before) || /^(?:#{1,6})\s+/m.test(draft.after);
    const next = replaced;
    return {
      markdown: next,
      headingId: headingAtOrBefore(next, start)?.id ?? draft.target.sectionId,
      selectionStart: touchesHeading ? undefined : start,
      selectionEnd: touchesHeading ? undefined : start + draft.after.length,
    };
  }

  const heading = targetHeading(markdown, draft);
  if (draft.operation === "move_section") {
    if (heading.level <= 1) throw new Error("不能移动文档 H1 标题");
    const destinationId = draft.target.destinationSectionId;
    const destination = destinationId
      ? parseMarkdownHeadings(markdown).find(item => item.id === destinationId)
      : undefined;
    if (!destination) throw new Error("文档已变化，目标位置章节已不存在");
    if (destination.id === heading.id) throw new Error("不能将章节移动到自身");
    if (destination.start > heading.start && destination.start < heading.end) throw new Error("不能将章节移动到其子章节内");
    if (sectionBody(markdown, destination) !== draft.target.destinationSnapshot) {
      throw new Error("文档已变化，目标位置章节原文不再匹配");
    }
    const position = draft.target.position;
    if (position !== "before" && position !== "after") throw new Error("提案缺少章节移动位置");
    const moved = moveSection(markdown, heading, destination, position);
    if (moved === markdown) throw new Error("章节已在目标位置，无需移动");
    const next = moved;
    const sourceName = stripHeadingPrefix(heading.title);
    const movedHeading = parseMarkdownHeadings(next).find(item => item.level === heading.level && stripHeadingPrefix(item.title) === sourceName);
    return { markdown: next, headingId: movedHeading?.id };
  }
  if (draft.operation === "delete_section") {
    if (heading.level <= 1) throw new Error("不能删除文档 H1 标题");
    const next = deleteSection(markdown, heading);
    return { markdown: next, headingId: headingAtOrAfter(next, heading.start)?.id };
  }
  if (draft.operation === "insert_section") {
    const position = draft.target.position;
    if (position !== "before" && position !== "after") throw new Error("提案缺少章节插入位置");
    const next = insertSection(markdown, heading, position, draft.after);
    const insertedTitle = parseMarkdownHeadings(draft.after)[0];
    const inserted = insertedTitle
      ? parseMarkdownHeadings(next).find(item => item.level === insertedTitle.level && stripHeadingPrefix(item.title) === stripHeadingPrefix(insertedTitle.title))
      : undefined;
    return { markdown: next, headingId: inserted?.id ?? headingAtOrAfter(next, heading.start)?.id };
  }

  const next = replaceSection(markdown, heading, draft.after);
  return { markdown: next, headingId: headingAtOrAfter(next, heading.start)?.id };
}

export function defaultProposalMarkdown(name = "未命名技术方案"): string {
  const chapters = ["背景与目标", "范围与约束", "总体架构", "详细设计", "接口与数据", "安全设计", "部署与迁移", "风险与应对", "测试与验收"];
  return [`# ${name}`, "", ...chapters.flatMap((t) => [`## ${t}`, "", "在此编写本章内容…", ""])].join("\n");
}

/** Prefer explicit H1, else filename stem. */
export function titleFromMarkdown(markdown: string, fallback: string): string {
  const m = markdown.match(/^#\s+(.+?)\s*$/m);
  return m?.[1]?.trim() || fallback;
}

export function fileNameFromTitle(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*]/g, "_").trim() || "未命名技术方案";
  return cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`;
}

/** Strip fixed chapter/section number prefixes so renumbering can re-apply them. */
export function stripHeadingPrefix(title: string): string {
  return title
    .replace(/^((?:\*{1,3}|_{1,3}|~~)?\s*)第\s*(?:\d+|[一二三四五六七八九十百零〇两]+)\s*章[\s、.．:：\-]*/u, "$1")
    .replace(/^((?:\*{1,3}|_{1,3}|~~)?\s*)(?:\d+\.)+\d*[\s、.．:：\-]*/u, "$1")
    .replace(/^((?:\*{1,3}|_{1,3}|~~)?\s*)\d+[\s、.．:：\-]+/u, "$1")
    .trim();
}

function chineseChapterNumber(value: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (value < 10) return digits[value];
  if (value < 20) return `十${value % 10 ? digits[value % 10] : ""}`;
  if (value < 100) return `${digits[Math.floor(value / 10)]}十${value % 10 ? digits[value % 10] : ""}`;
  return String(value);
}

export function formatHeadingPrefix(level: number, counters: number[], style: HeadingNumberingStyle = "chapter-h2"): string {
  const safe = Math.min(Math.max(level, 1), 6);
  if (style === "chapter-h1") {
    if (safe === 1) return `第${chineseChapterNumber(counters[0])}章`;
    return counters.slice(0, safe).join(".");
  }
  if (safe === 1) return "";
  if (safe === 2) return `第${counters[0]}章`;
  return counters.slice(0, safe - 1).join(".");
}

function headingLine(level: number, title: string): string {
  const hashes = "#".repeat(Math.min(Math.max(level, 1), 6));
  const body = title.trim() || "未命名";
  return `${hashes} ${body}`;
}

/** Re-apply fixed numbering: H1 document title (skipped), H2 第N章, H3 1.1, H4 1.1.1, … */
export function renumberHeadings(markdown: string, style: HeadingNumberingStyle = "chapter-h2"): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const counters = [0, 0, 0, 0, 0, 0];
  let inCode = false;

  let documentTitleSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const m = raw.match(HEADING_RE);
    if (!m) continue;
    const level = Math.min(m[1].length, 6);
    if (level === 1 && (style === "chapter-h2" || !documentTitleSeen)) {
      documentTitleSeen = true;
      continue;
    }
    const plain = stripHeadingPrefix(m[2].trim()) || "未命名";
    const counterIndex = style === "chapter-h1" ? level - 1 : level - 2;
    counters[counterIndex] += 1;
    for (let j = counterIndex + 1; j < 6; j++) counters[j] = 0;
    if (counters[0] === 0) counters[0] = 1;
    const prefix = formatHeadingPrefix(level, counters, style);
    lines[i] = headingLine(level, `${prefix} ${plain}`);
  }
  return lines.join("\n");
}

export interface HeadingAlignmentResult {
  markdown: string;
  headingCount: number;
  demotedCount: number;
  titlePreserved: boolean;
  titleCreated: boolean;
}

export function detectHeadingNumberingStyle(markdown: string): HeadingNumberingStyle {
  const h1s = parseMarkdownHeadings(markdown).filter(heading => heading.level === 1);
  return h1s.slice(1).some(heading => /^第\s*[一二三四五六七八九十百零〇两]+\s*章/u.test(heading.title.replace(/^(?:\*{1,3}|_{1,3}|~~)/, "")))
    ? "chapter-h1"
    : "chapter-h2";
}

function isTitleCandidate(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 120) return false;
  if (/^(?:<|[-+*]\s|\d+[.)、]\s|>|\||!\[)/u.test(text)) return false;
  if (/^(?:(?:申报|编制|建设|承建|项目|报告)?(?:单位|日期|时间|负责人|联系人|地址)|(?:申报|编制)部门)[：:]/u.test(text)) return false;
  return true;
}

/** Ensure one document title, demote chapter-like H1s, then apply fixed numbering. */
export function alignHeadingsToRules(markdown: string, fallbackTitle = "未命名技术方案", style: HeadingNumberingStyle = "chapter-h2"): HeadingAlignmentResult {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sourceStyle = detectHeadingNumberingStyle(markdown);
  let inCode = false;
  const headings: { line: number; level: number; title: string }[] = [];
  let demotedCount = 0;
  let titlePreserved = false;
  let titleCreated = false;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const heading = lines[index].match(HEADING_RE);
    if (!heading) continue;
    headings.push({ line: index, level: heading[1].length, title: heading[2].trim() });
  }

  const h1s = headings.filter(heading => heading.level === 1);
  let titleLine: number | null = null;
  if (h1s.length === 1) {
    titleLine = h1s[0].line;
  } else if (h1s.length > 1) {
    const unnumbered = h1s.filter(heading => stripHeadingPrefix(heading.title) === heading.title);
    if (unnumbered.length === 1) titleLine = unnumbered[0].line;
  }
  titlePreserved = titleLine !== null;

  if (sourceStyle !== style) {
    const delta = style === "chapter-h1" ? -1 : 1;
    for (const heading of headings) {
      if (heading.line === titleLine) continue;
      lines[heading.line] = headingLine(Math.min(6, Math.max(1, heading.level + delta)), heading.title);
      if (delta > 0) demotedCount += 1;
    }
  } else if (style === "chapter-h2") {
    for (const heading of h1s) {
      if (heading.line === titleLine) continue;
      lines[heading.line] = headingLine(2, heading.title);
      demotedCount += 1;
    }
  }

  if (titleLine === null) {
    const firstHeadingLine = headings[0]?.line ?? lines.length;
    const candidateLine = lines.findIndex((line, index) => index < firstHeadingLine && isTitleCandidate(line));
    if (candidateLine >= 0) {
      lines[candidateLine] = headingLine(1, lines[candidateLine]);
    } else {
      lines.unshift(headingLine(1, fallbackTitle.trim() || "未命名技术方案"), "");
    }
    titleCreated = true;
  }

  return {
    markdown: renumberHeadings(lines.join("\n"), style),
    headingCount: headings.length + (titleCreated ? 1 : 0),
    demotedCount,
    titlePreserved,
    titleCreated,
  };
}

function expandToLineRange(text: string, start: number, end: number): { start: number; end: number } {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(0, Math.min(end, text.length));
  if (e < s) [s, e] = [e, s];
  while (s > 0 && text[s - 1] !== "\n") s -= 1;
  if (e > s && text[e - 1] === "\n") {
    // keep exclusive end on newline if selection ended mid-line after content
  } else {
    while (e < text.length && text[e] !== "\n") e += 1;
  }
  return { start: s, end: e };
}

/**
 * Set selected lines to a heading level (batch), then renumber the whole document.
 * Collapsed caret applies to the current line.
 */
export function applyHeadingLevel(
  markdown: string,
  selectionStart: number,
  selectionEnd: number,
  level: number,
  style: HeadingNumberingStyle = "chapter-h2",
): { markdown: string; selectionStart: number; selectionEnd: number } {
  const text = markdown.replace(/\r\n/g, "\n");
  const range = expandToLineRange(text, selectionStart, selectionEnd);
  const before = text.slice(0, range.start);
  const selected = text.slice(range.start, range.end);
  const after = text.slice(range.end);
  const selectedLines = selected.split("\n");
  // If selection ends at EOF without trailing newline, split still works; preserve structure
  const endsWithNewline = selected.endsWith("\n");
  const working = endsWithNewline ? selectedLines.slice(0, -1) : selectedLines;

  const nextLevel = Math.min(Math.max(level, 1), 6);
  const converted = working.map((line) => {
    if (!line.trim()) return line;
    if (line.trim().startsWith("```")) return line;
    const heading = line.match(HEADING_RE);
    const plain = stripHeadingPrefix((heading ? heading[2] : line).trim()) || "未命名";
    return headingLine(nextLevel, plain);
  });

  const middle = converted.join("\n") + (endsWithNewline ? "\n" : "");
  const merged = before + middle + after;
  const numbered = renumberHeadings(merged, style);
  return {
    markdown: numbered,
    selectionStart: range.start,
    selectionEnd: range.start + middle.length,
  };
}
