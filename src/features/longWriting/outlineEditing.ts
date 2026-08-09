import { parseLongWritingDocument } from "./chapterParser";
import type { LongWritingMode, OutlineChapterAction, OutlinePlan } from "./types";

export interface EditableOutlineChapter {
  key: string;
  /** Existing chapter whose body/subtree is retained during outline application. */
  sourceChapterId?: string;
  /** Temporary outline ID used until a new chapter gets its real document ID. */
  plannedChapterId?: string;
  title: string;
  action: OutlineChapterAction;
  goal: string;
}

export interface ApplyEditableOutlineOptions {
  /** Enables creating a complete document from a blank or H1-only Markdown file. */
  documentTitle?: string;
}

function actionForMode(mode: LongWritingMode): OutlineChapterAction {
  return mode === "create" ? "fill" : "modify";
}

function plannedTitle(item: OutlinePlan["frozenOutline"][number]): string {
  return item.titlePath.at(-1)?.trim()
    || item.headingSkeleton.find(line => /^##(?!#)\s+/.test(line))?.replace(/^##(?!#)\s+/, "").trim()
    || "";
}

export function createEditableOutline(plan: OutlinePlan, markdown: string): EditableOutlineChapter[] {
  const chapters = parseLongWritingDocument(markdown).chapters;
  const itemById = new Map(plan.frozenOutline.map(item => [item.chapterId, item]));
  if (!chapters.length) {
    return plan.frozenOutline
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((item, index) => ({
        key: `planned:${item.chapterId || index}`,
        plannedChapterId: item.chapterId,
        title: plannedTitle(item),
        action: item.action,
        goal: item.goal || "按总指令编写本章",
      }));
  }
  return chapters.map(chapter => {
    const item = itemById.get(chapter.id);
    return {
      key: `existing:${chapter.id}`,
      sourceChapterId: chapter.id,
      title: chapter.title,
      action: item?.action ?? "keep",
      goal: item?.goal ?? "保持本章内容",
    };
  });
}

export function createNewOutlineChapter(mode: LongWritingMode, index: number): EditableOutlineChapter {
  return {
    key: `new:${Date.now()}:${index}:${Math.random().toString(36).slice(2)}`,
    title: "新增章节",
    action: actionForMode(mode),
    goal: mode === "create" ? "补充完整本章正文" : "按总指令修改本章",
  };
}

export function canCreateLongWritingDocument(markdown: string): boolean {
  const parsed = parseLongWritingDocument(markdown);
  if (parsed.chapters.length || parsed.headings.length > 1 || parsed.headings.some(heading => heading.level !== 1)) return false;
  if (!parsed.headings.length) return !markdown.trim();
  const [heading] = parsed.headings;
  return `${markdown.slice(0, heading.start)}${markdown.slice(heading.lineEnd)}`.trim() === "";
}

function renameChapterHeading(markdown: string, title: string, lineEnding: string): string {
  const parsed = parseLongWritingDocument(markdown);
  const chapter = parsed.chapters[0];
  if (!chapter) throw new Error("目录中的原章节已不存在");
  const relativeLineEnd = chapter.heading.lineEnd - chapter.start;
  return `## ${title}${lineEnding}${markdown.slice(relativeLineEnd)}`;
}

/** Applies H2 add/delete/rename/reorder edits while preserving every retained chapter's full subtree/body. */
export function applyEditableOutline(markdown: string, rows: EditableOutlineChapter[], options: ApplyEditableOutlineOptions = {}): string {
  if (!rows.length) throw new Error("目录至少需要保留一个 H2 章节");
  const parsed = parseLongWritingDocument(markdown);
  const chapterById = new Map(parsed.chapters.map(chapter => [chapter.id, chapter]));
  const used = new Set<string>();
  const isCreation = !parsed.chapters.length;
  const documentTitle = options.documentTitle?.trim();
  if (isCreation && (!documentTitle || !canCreateLongWritingDocument(markdown))) {
    throw new Error("从零创建只能应用到空白或仅含 H1 的文档，并且必须填写方案标题");
  }
  const prefix = isCreation ? `# ${documentTitle}${parsed.lineEnding}${parsed.lineEnding}` : markdown.slice(0, parsed.chapters[0].start);
  const sections = rows.map((row, index) => {
    const title = row.title.trim();
    if (!title) throw new Error(`第 ${index + 1} 个章节标题不能为空`);
    if (!row.sourceChapterId) return `## ${title}${parsed.lineEnding}${parsed.lineEnding}`;
    if (isCreation) throw new Error("从零创建目录不能保留原章节");
    if (used.has(row.sourceChapterId)) throw new Error("同一原章节不能在目录中出现两次");
    used.add(row.sourceChapterId);
    const chapter = chapterById.get(row.sourceChapterId);
    if (!chapter) throw new Error(`原章节已变化：${row.sourceChapterId}`);
    return renameChapterHeading(chapter.markdown, title, parsed.lineEnding);
  });
  let result = prefix;
  for (const section of sections) {
    if (result && !/(?:\r\n|\n|\r)$/.test(result)) result += parsed.lineEnding;
    result += section;
  }
  return result;
}
