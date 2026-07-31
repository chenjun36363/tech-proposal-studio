export interface ParsedMarkdownHeading {
  id: string;
  level: number;
  title: string;
  line: number;
  start: number;
  lineEnd: number;
  end: number;
  parentId?: string;
  path: string[];
}

export interface ParsedMarkdownChapter {
  id: string;
  order: number;
  title: string;
  titlePath: string[];
  start: number;
  end: number;
  bodyStart: number;
  heading: ParsedMarkdownHeading;
  headings: ParsedMarkdownHeading[];
  markdown: string;
  bodyMarkdown: string;
}

export interface ParsedLongWritingDocument {
  markdown: string;
  lineEnding: "\n" | "\r\n" | "\r";
  headings: ParsedMarkdownHeading[];
  chapters: ParsedMarkdownChapter[];
}

export interface FrozenHeadingEntry {
  level: number;
  title: string;
  parentIndex: number | null;
}

interface SourceLine {
  text: string;
  eol: string;
  line: number;
  start: number;
  end: number;
}

interface HeadingStart {
  id: string;
  stableKey: string;
  level: number;
  title: string;
  line: number;
  start: number;
  lineEnd: number;
  parentId?: string;
  path: string[];
}

const ATX_HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function splitSourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let line = 0;

  while (start < markdown.length) {
    let cursor = start;
    while (cursor < markdown.length && markdown[cursor] !== "\r" && markdown[cursor] !== "\n") cursor += 1;

    let eol = "";
    if (cursor < markdown.length) {
      if (markdown[cursor] === "\r" && markdown[cursor + 1] === "\n") eol = "\r\n";
      else eol = markdown[cursor];
    }

    const end = cursor + eol.length;
    lines.push({ text: markdown.slice(start, cursor), eol, line, start, end });
    start = end;
    line += 1;
  }

  return lines;
}

function parseAtxHeading(line: string): { level: number; title: string } | null {
  const match = line.match(ATX_HEADING_RE);
  if (!match) return null;
  const title = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level: match[1].length, title };
}

function normalizeIdentityTitle(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function hashStableKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function detectLineEnding(markdown: string): ParsedLongWritingDocument["lineEnding"] {
  const match = markdown.match(/\r\n|\n|\r/);
  return (match?.[0] as ParsedLongWritingDocument["lineEnding"] | undefined) ?? "\n";
}

function collectHeadingStarts(markdown: string): HeadingStart[] {
  const starts: HeadingStart[] = [];
  const stack: HeadingStart[] = [];
  const siblingOccurrences = new Map<string, number>();
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (const sourceLine of splitSourceLines(markdown)) {
    if (fence) {
      const markerPattern = fence.marker === "`" ? "`" : "~";
      const closing = new RegExp(`^ {0,3}${markerPattern}{${fence.length},}[ \\t]*$`);
      if (closing.test(sourceLine.text)) fence = null;
      continue;
    }

    const opening = sourceLine.text.match(FENCE_OPEN_RE);
    if (opening) {
      const marker = opening[1][0] as "`" | "~";
      if (marker === "~" || !opening[2].includes("`")) {
        fence = { marker, length: opening[1].length };
        continue;
      }
    }

    const parsed = parseAtxHeading(sourceLine.text);
    if (!parsed) continue;

    while (stack.length > 0 && stack[stack.length - 1].level >= parsed.level) stack.pop();
    const parent = stack[stack.length - 1];
    const identityTitle = normalizeIdentityTitle(parsed.title);
    const siblingKey = `${parent?.stableKey ?? "root"}\u0000${parsed.level}\u0000${identityTitle}`;
    const occurrence = siblingOccurrences.get(siblingKey) ?? 0;
    siblingOccurrences.set(siblingKey, occurrence + 1);
    const stableKey = `${siblingKey}\u0000${occurrence}`;
    const id = `h${parsed.level}-${hashStableKey(stableKey)}`;
    const heading: HeadingStart = {
      id,
      stableKey,
      level: parsed.level,
      title: parsed.title,
      line: sourceLine.line,
      start: sourceLine.start,
      lineEnd: sourceLine.end,
      parentId: parent?.id,
      path: [...(parent?.path ?? []), parsed.title],
    };
    starts.push(heading);
    stack.push(heading);
  }

  return starts;
}

export function parseLongWritingDocument(markdown: string): ParsedLongWritingDocument {
  const starts = collectHeadingStarts(markdown);
  const headings: ParsedMarkdownHeading[] = starts.map((heading, index) => {
    let end = markdown.length;
    for (let next = index + 1; next < starts.length; next += 1) {
      if (starts[next].level <= heading.level) {
        end = starts[next].start;
        break;
      }
    }
    return { ...heading, end };
  });

  const chapters = headings
    .filter(heading => heading.level === 2)
    .map((heading, order): ParsedMarkdownChapter => {
      const chapterHeadings = headings.filter(candidate => candidate.start >= heading.start && candidate.start < heading.end);
      return {
        id: `chapter-${heading.id.slice(3)}`,
        order,
        title: heading.title,
        titlePath: heading.path,
        start: heading.start,
        end: heading.end,
        bodyStart: heading.lineEnd,
        heading,
        headings: chapterHeadings,
        markdown: markdown.slice(heading.start, heading.end),
        bodyMarkdown: markdown.slice(heading.lineEnd, heading.end),
      };
    });

  return {
    markdown,
    lineEnding: detectLineEnding(markdown),
    headings,
    chapters,
  };
}

export function getChapterById(markdown: string, chapterId: string): ParsedMarkdownChapter | undefined {
  return parseLongWritingDocument(markdown).chapters.find(chapter => chapter.id === chapterId);
}

export function getFrozenHeadingEntries(chapter: ParsedMarkdownChapter): FrozenHeadingEntry[] {
  const indexById = new Map(chapter.headings.map((heading, index) => [heading.id, index]));
  return chapter.headings.map(heading => ({
    level: heading.level,
    title: heading.title,
    parentIndex: heading.parentId ? (indexById.get(heading.parentId) ?? null) : null,
  }));
}

export function createFrozenHeadingTreeSignature(chapter: ParsedMarkdownChapter): string {
  return JSON.stringify({ version: 1, headings: getFrozenHeadingEntries(chapter) });
}

function normalizeLineEndings(markdown: string, lineEnding: ParsedLongWritingDocument["lineEnding"]): string {
  return markdown.replace(/\r\n|\r|\n/g, "\n").replace(/\n/g, lineEnding);
}

function trailingWhitespace(value: string): string {
  return value.match(/(?:\r\n|\n|\r)(?:[ \t]*(?:\r\n|\n|\r))*[ \t]*$/)?.[0] ?? "";
}

function trimTrailingLineWhitespace(value: string): string {
  return value.replace(/(?:\r\n|\n|\r)(?:[ \t]*(?:\r\n|\n|\r))*[ \t]*$/, "");
}

export function replaceChapterExact(markdown: string, chapterId: string, replacementMarkdown: string): string {
  const document = parseLongWritingDocument(markdown);
  const target = document.chapters.find(chapter => chapter.id === chapterId);
  if (!target) throw new Error(`找不到章节：${chapterId}`);

  const normalizedReplacement = normalizeLineEndings(replacementMarkdown, document.lineEnding);
  const replacementDocument = parseLongWritingDocument(normalizedReplacement);
  if (replacementDocument.chapters.length !== 1) throw new Error("替换稿必须且只能包含一个 H2 章节");

  const replacement = replacementDocument.chapters[0];
  if (normalizedReplacement.slice(0, replacement.start).trim() || normalizedReplacement.slice(replacement.end).trim()) {
    throw new Error("替换稿不得包含章节之外的内容");
  }

  if (createFrozenHeadingTreeSignature(target) !== createFrozenHeadingTreeSignature(replacement)) {
    throw new Error("替换稿标题树与冻结标题树不一致");
  }

  const originalTail = trailingWhitespace(target.markdown);
  const replacementCore = trimTrailingLineWhitespace(replacement.markdown);
  const nextSection = replacementCore + originalTail;
  return markdown.slice(0, target.start) + nextSection + markdown.slice(target.end);
}

