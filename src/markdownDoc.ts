export interface HeadingNode {
  heading: MdHeading;
  children: HeadingNode[];
}

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

  const section = markdown.slice(source.start, source.end);
  const withoutSource = markdown.slice(0, source.start) + markdown.slice(source.end);
  const originalInsertion = position === "before" ? target.start : target.end;
  const insertion = originalInsertion >= source.end
    ? originalInsertion - (source.end - source.start)
    : originalInsertion;
  return withoutSource.slice(0, insertion) + section + withoutSource.slice(insertion);
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
    .replace(/^第\s*\d+\s*章[\s、.．:：\-]*/u, "")
    .replace(/^(?:\d+\.)+\d*[\s、.．:：\-]*/u, "")
    .replace(/^\d+[\s、.．:：\-]+/u, "")
    .trim();
}

export function formatHeadingPrefix(level: number, counters: number[]): string {
  const safe = Math.min(Math.max(level, 1), 6);
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
export function renumberHeadings(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const counters = [0, 0, 0, 0, 0, 0];
  let inCode = false;

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
    if (level === 1) continue;
    const plain = stripHeadingPrefix(m[2].trim()) || "未命名";
    counters[level - 2] += 1;
    for (let j = level - 1; j < 6; j++) counters[j] = 0;
    if (counters[0] === 0) counters[0] = 1;
    const prefix = formatHeadingPrefix(level, counters);
    lines[i] = headingLine(level, `${prefix} ${plain}`);
  }
  return lines.join("\n");
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
  const numbered = renumberHeadings(merged);
  return {
    markdown: numbered,
    selectionStart: range.start,
    selectionEnd: range.start + middle.length,
  };
}
