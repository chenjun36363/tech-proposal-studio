import {
  createFrozenHeadingTreeSignature,
  getFrozenHeadingEntries,
  parseLongWritingDocument,
  type FrozenHeadingEntry,
  type ParsedMarkdownChapter,
} from "./chapterParser";

export type ChapterDraftValidationCode =
  | "missing_chapter"
  | "extra_chapter"
  | "content_outside_chapter"
  | "missing_heading"
  | "extra_heading"
  | "heading_level_changed"
  | "heading_title_changed"
  | "heading_parent_changed"
  | "empty_body";

export interface ChapterDraftValidationIssue {
  code: ChapterDraftValidationCode;
  message: string;
  headingIndex?: number;
  expected?: FrozenHeadingEntry;
  actual?: FrozenHeadingEntry;
}

export interface ChapterDraftValidationResult {
  valid: boolean;
  expectedSignature: string;
  actualSignature?: string;
  issues: ChapterDraftValidationIssue[];
}

function compareHeadingEntries(expected: FrozenHeadingEntry[], actual: FrozenHeadingEntry[]): ChapterDraftValidationIssue[] {
  const issues: ChapterDraftValidationIssue[] = [];
  const sharedLength = Math.min(expected.length, actual.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const expectedHeading = expected[index];
    const actualHeading = actual[index];
    if (expectedHeading.level !== actualHeading.level) {
      issues.push({
        code: "heading_level_changed",
        message: `第 ${index + 1} 个标题层级从 H${expectedHeading.level} 变为 H${actualHeading.level}`,
        headingIndex: index,
        expected: expectedHeading,
        actual: actualHeading,
      });
    }
    if (expectedHeading.title !== actualHeading.title) {
      issues.push({
        code: "heading_title_changed",
        message: `第 ${index + 1} 个标题名称已改变`,
        headingIndex: index,
        expected: expectedHeading,
        actual: actualHeading,
      });
    }
    if (expectedHeading.parentIndex !== actualHeading.parentIndex) {
      issues.push({
        code: "heading_parent_changed",
        message: `第 ${index + 1} 个标题的父级关系已改变`,
        headingIndex: index,
        expected: expectedHeading,
        actual: actualHeading,
      });
    }
  }

  if (actual.length < expected.length) {
    for (let index = actual.length; index < expected.length; index += 1) {
      issues.push({
        code: "missing_heading",
        message: `缺少冻结标题：H${expected[index].level} ${expected[index].title}`,
        headingIndex: index,
        expected: expected[index],
      });
    }
  } else if (actual.length > expected.length) {
    for (let index = expected.length; index < actual.length; index += 1) {
      issues.push({
        code: "extra_heading",
        message: `出现额外标题：H${actual[index].level} ${actual[index].title}`,
        headingIndex: index,
        actual: actual[index],
      });
    }
  }

  return issues;
}

function nonHeadingBody(chapter: ParsedMarkdownChapter): string {
  let cursor = chapter.bodyStart;
  let content = "";
  for (const heading of chapter.headings.slice(1)) {
    content += chapter.markdown.slice(cursor - chapter.start, heading.start - chapter.start);
    cursor = heading.lineEnd;
  }
  content += chapter.markdown.slice(cursor - chapter.start);
  return content;
}

function hasMeaningfulBody(chapter: ParsedMarkdownChapter): boolean {
  const withoutFenceMarkers = nonHeadingBody(chapter)
    .split(/\r\n|\n|\r/)
    .filter(line => !/^ {0,3}(?:`{3,}|~{3,})(?:.*)?$/.test(line))
    .join("\n");
  return withoutFenceMarkers.trim().length > 0;
}

function parseSingleDraftChapter(draftMarkdown: string): {
  chapter?: ParsedMarkdownChapter;
  issues: ChapterDraftValidationIssue[];
} {
  const document = parseLongWritingDocument(draftMarkdown);
  const issues: ChapterDraftValidationIssue[] = [];

  if (document.chapters.length === 0) {
    issues.push({ code: "missing_chapter", message: "模型返回中缺少 H2 章节" });
    return { issues };
  }
  if (document.chapters.length > 1) {
    issues.push({ code: "extra_chapter", message: "模型返回包含多个 H2 章节" });
  }

  const chapter = document.chapters[0];
  const before = draftMarkdown.slice(0, chapter.start);
  const after = draftMarkdown.slice(chapter.end);
  const headingsOutsideChapter = document.headings.filter(heading => heading.start < chapter.start || heading.start >= chapter.end);
  if (before.trim() || after.trim() || headingsOutsideChapter.length > 0) {
    issues.push({ code: "content_outside_chapter", message: "模型返回包含目标章节之外的内容或标题" });
  }
  return { chapter, issues };
}

export function validateFrozenHeadingTree(
  expectedSignature: string,
  draftMarkdown: string,
): ChapterDraftValidationResult {
  const parsed = parseSingleDraftChapter(draftMarkdown);
  let expected: FrozenHeadingEntry[];
  try {
    const payload = JSON.parse(expectedSignature) as { version?: unknown; headings?: unknown };
    if (payload.version !== 1 || !Array.isArray(payload.headings)) throw new Error("invalid signature");
    expected = payload.headings as FrozenHeadingEntry[];
  } catch {
    throw new Error("无效的冻结标题树签名");
  }

  if (!parsed.chapter) {
    return { valid: false, expectedSignature, issues: parsed.issues };
  }

  const actual = getFrozenHeadingEntries(parsed.chapter);
  const issues = [...parsed.issues, ...compareHeadingEntries(expected, actual)];
  return {
    valid: issues.length === 0,
    expectedSignature,
    actualSignature: createFrozenHeadingTreeSignature(parsed.chapter),
    issues,
  };
}

export function validateChapterDraft(
  frozenChapterMarkdown: string,
  draftMarkdown: string,
): ChapterDraftValidationResult {
  const frozen = parseLongWritingDocument(frozenChapterMarkdown);
  if (frozen.chapters.length !== 1) throw new Error("冻结章节必须且只能包含一个 H2 章节");
  const frozenChapter = frozen.chapters[0];
  if (frozenChapter.start > 0 && frozenChapterMarkdown.slice(0, frozenChapter.start).trim()) {
    throw new Error("冻结章节包含 H2 章节之外的内容");
  }

  const expectedSignature = createFrozenHeadingTreeSignature(frozenChapter);
  const result = validateFrozenHeadingTree(expectedSignature, draftMarkdown);
  const draft = parseSingleDraftChapter(draftMarkdown).chapter;
  const issues = [...result.issues];
  if (draft && !hasMeaningfulBody(draft)) {
    issues.push({ code: "empty_body", message: "章节正文不能为空或只包含标题" });
  }

  return { ...result, valid: issues.length === 0, issues };
}
