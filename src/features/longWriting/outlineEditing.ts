import { parseLongWritingDocument } from "./chapterParser";
import type { LongWritingMode, OutlineChapterAction, OutlinePlan } from "./types";

export interface EditableOutlineChapter {
  key: string;
  sourceChapterId?: string;
  title: string;
  action: OutlineChapterAction;
  goal: string;
}

function actionForMode(mode: LongWritingMode): OutlineChapterAction {
  return mode === "fill" ? "fill" : mode === "rewrite" ? "rewrite" : "modify";
}

export function createEditableOutline(plan: OutlinePlan, markdown: string): EditableOutlineChapter[] {
  const chapters = parseLongWritingDocument(markdown).chapters;
  const itemById = new Map(plan.frozenOutline.map(item => [item.chapterId, item]));
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
    goal: mode === "fill" ? "补充完整本章正文" : mode === "rewrite" ? "编写并提升本章" : "按总指令编写本章",
  };
}

function renameChapterHeading(markdown: string, title: string, lineEnding: string): string {
  const parsed = parseLongWritingDocument(markdown);
  const chapter = parsed.chapters[0];
  if (!chapter) throw new Error("目录中的原章节已不存在");
  const relativeLineEnd = chapter.heading.lineEnd - chapter.start;
  return `## ${title}${lineEnding}${markdown.slice(relativeLineEnd)}`;
}

/** Applies H2 add/delete/rename/reorder edits while preserving every retained chapter's full subtree/body. */
export function applyEditableOutline(markdown: string, rows: EditableOutlineChapter[]): string {
  if (!rows.length) throw new Error("目录至少需要保留一个 H2 章节");
  const parsed = parseLongWritingDocument(markdown);
  if (!parsed.chapters.length) throw new Error("当前文档没有 H2 章节");
  const chapterById = new Map(parsed.chapters.map(chapter => [chapter.id, chapter]));
  const used = new Set<string>();
  const prefix = markdown.slice(0, parsed.chapters[0].start);
  const sections = rows.map((row, index) => {
    const title = row.title.trim();
    if (!title) throw new Error(`第 ${index + 1} 个章节标题不能为空`);
    if (!row.sourceChapterId) return `## ${title}${parsed.lineEnding}${parsed.lineEnding}`;
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
