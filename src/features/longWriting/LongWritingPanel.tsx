import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, CirclePause, CirclePlay, Plus, RotateCcw, Square, Trash2, WandSparkles } from "lucide-react";
import type { Project, ResolvedModelConfig, SelectedModel } from "../../core/types";
import { readTextFileSnapshot, writeTextFileChecked, type TextFileSnapshot } from "../workspace/documentSafety";
import { alignHeadingsToRules } from "../editor/markdownDoc";
import { resolveActiveModelConfig } from "../../services/llm/resolve";
import { isDesktop } from "../../services/runtime";
import { createFrozenHeadingTreeSignature, parseLongWritingDocument, replaceChapterExact } from "./chapterParser";
import { runChapterWorkerPool } from "./coordinator";
import { inspectLocalConsistency } from "./consistency";
import { longWritingErrorMessage } from "./errors";
import { appendLongWritingEvent, createLongWritingEvent } from "./events";
import { LongWritingEventLog, LongWritingJobCard } from "./LongWritingOutput";
import { applyEditableOutline, createEditableOutline, createNewOutlineChapter, type EditableOutlineChapter } from "./outlineEditing";
import { createChapterDraft, createChapterSummary, createConsistencyReport, createLocalChapterSummary, createOutlinePlan } from "./model";
import {
  commitLongTaskChapter,
  createProposalBackup,
  listLongWritingTasks,
  recoverLongWritingTask,
  restoreProposalBackup,
  saveLongWritingChapter,
  saveLongWritingTask,
} from "./service";
import type {
  ChapterJob,
  ChapterJobStatus,
  ChapterDraftResult,
  OutlineChapterAction,
  LongWritingMode,
  LongWritingTaskRecord,
  OutlinePlan,
  LongWritingEventDetails,
  LongWritingEventType,
} from "./types";
import { validateChapterDraft } from "./validation";
import { getLongWritingAvailability } from "./availability";

const unfinished = new Set<LongWritingTaskRecord["status"]>([
  "preparing", "awaiting_outline", "running", "paused", "checking", "awaiting_repairs", "conflict", "failed",
]);

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  signal: AbortSignal,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (cursor < values.length) {
      signal.throwIfAborted();
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function textFromSource(source: Project["sources"][number]): string {
  return [source.title, source.heading, source.content ?? source.excerpt].filter(Boolean).join("\n");
}

function modelKey(selection: SelectedModel): string {
  return `${selection.providerId}\u0000${selection.model}`;
}

function normalizePlan(plan: OutlinePlan, markdown: string, mode: LongWritingMode, requested: string[]): OutlinePlan {
  const chapters = parseLongWritingDocument(markdown).chapters;
  const goalById = new Map(plan.frozenOutline.map(item => [item.chapterId, item]));
  const goalByOrder = new Map(plan.frozenOutline.map(item => [item.order, item]));
  const requestedSet = new Set(requested);
  const targetSet = new Set(plan.targetChapterIds.filter(id => chapters.some(chapter => chapter.id === id)));
  if (mode !== "targeted" || !targetSet.size) requested.forEach(id => targetSet.add(id));
  const frozenOutline = chapters.map(chapter => {
    const generated = goalById.get(chapter.id) ?? goalByOrder.get(chapter.order);
    const action: OutlineChapterAction = targetSet.has(chapter.id)
      ? mode === "fill" ? "fill" : mode === "rewrite" ? "rewrite" : "modify"
      : "keep";
    return {
      chapterId: chapter.id,
      order: chapter.order,
      titlePath: chapter.titlePath,
      headingSkeleton: chapter.headings.map(heading => `${"#".repeat(heading.level)} ${heading.title}`),
      goal: generated?.goal || (action === "fill" ? "补充完整本章正文" : action === "rewrite" ? "重写并提升本章" : "按总指令修改本章"),
      action: requestedSet.has(chapter.id) || mode === "targeted" ? action : "keep" as const,
    };
  });
  const finalTargets = frozenOutline.filter(item => item.action !== "keep").map(item => item.chapterId);
  return {
    ...plan,
    frozenOutline,
    targetChapterIds: finalTargets,
    frozenHeadingSignature: JSON.stringify(frozenOutline.map(item => item.headingSkeleton)),
  };
}

function createLocalOutlinePlan(
  chapters: ReturnType<typeof parseLongWritingDocument>["chapters"],
  mode: LongWritingMode,
  requested: string[],
): OutlinePlan {
  // This plan is only a safe reviewable fallback. The user still confirms it
  // before any chapter worker is allowed to write to the document.
  const targetIds = new Set(requested.length ? requested : chapters.map(chapter => chapter.id));
  const action: OutlineChapterAction = mode === "fill" ? "fill" : mode === "rewrite" ? "rewrite" : "modify";
  const frozenOutline = chapters.map(chapter => ({
    chapterId: chapter.id,
    order: chapter.order,
    titlePath: chapter.titlePath,
    headingSkeleton: chapter.headings.map(heading => `${"#".repeat(heading.level)} ${heading.title}`),
    goal: targetIds.has(chapter.id)
      ? action === "fill" ? "补充完整本章正文" : action === "rewrite" ? "重写并提升本章" : "按总指令修改本章"
      : "保留现有章节内容",
    action: targetIds.has(chapter.id) ? action : "keep" as const,
  }));
  return {
    documentSummary: "基于当前正文和现有标题结构生成的本地目录规划。",
    audience: "技术方案评审人员",
    writingRules: ["保持现有章节结构、标题文本和顺序不变"],
    fixedFacts: [],
    terminology: [],
    frozenOutline,
    transitionRequirements: [],
    targetChapterIds: frozenOutline.filter(item => item.action !== "keep").map(item => item.chapterId),
  };
}


export function LongWritingPanel({
  project,
  baselineHash,
  saveBeforeStart,
  onDocumentSnapshot,
  onLockChange,
  onLocateChapter,
  notify,
}: {
  project: Project;
  baselineHash: string | null;
  saveBeforeStart: (content?: string) => Promise<TextFileSnapshot | null>;
  onDocumentSnapshot: (snapshot: TextFileSnapshot) => Promise<void> | void;
  onLockChange: (locked: boolean) => void;
  onLocateChapter: (titlePath: string[]) => void;
  notify: (message: string) => void;
}) {
  const desktop = isDesktop();
  const availability = getLongWritingAvailability(desktop, project);
  const parsed = useMemo(() => parseLongWritingDocument(project.markdown), [project.markdown]);
  const modelOptions = useMemo(() => project.providers
    .filter(provider => provider.enabled)
    .flatMap(provider => provider.activeModels.map(model => ({
      selection: { providerId: provider.id, model } satisfies SelectedModel,
      label: `${provider.name} / ${model}`,
    }))), [project.providers]);
  const [mode, setMode] = useState<LongWritingMode>("fill");
  const [instruction, setInstruction] = useState("");
  const [concurrency, setConcurrency] = useState<1 | 2 | 3>(2);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sourceIds, setSourceIds] = useState<Set<string>>(new Set(project.contextSourceRefs));
  const [modelSelection, setModelSelection] = useState<SelectedModel | null>(project.selectedModel);
  const [outlineRows, setOutlineRows] = useState<EditableOutlineChapter[]>([]);
  const [task, setTask] = useState<LongWritingTaskRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const pausedRef = useRef(false);
  const taskRef = useRef<LongWritingTaskRecord | null>(null);
  const documentRef = useRef(project.markdown);
  const mutationQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  const setTaskBoth = (next: LongWritingTaskRecord | null) => {
    taskRef.current = next;
    setTask(next);
  };

  const enqueue = <T,>(operation: () => Promise<T>): Promise<T> => {
    const queued = mutationQueueRef.current.then(operation, operation);
    mutationQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  };

  const replacePersistedTask = (next: LongWritingTaskRecord, saveChapters = false) => enqueue(async () => {
    setTaskBoth(next);
    await saveLongWritingTask(next.workspaceRoot, next);
    if (saveChapters) {
      for (const chapter of next.chapters) await saveLongWritingChapter(next.workspaceRoot, next.id, chapter);
    }
    return next;
  });

  const mutateTask = (
    updater: (current: LongWritingTaskRecord) => LongWritingTaskRecord,
    changedChapterIds: string[] = [],
  ) => enqueue(async () => {
    const current = taskRef.current;
    if (!current) throw new Error("长任务不存在");
    const next = updater(current);
    setTaskBoth(next);
    for (const chapterId of changedChapterIds) {
      const chapter = next.chapters.find(item => item.id === chapterId);
      if (chapter) await saveLongWritingChapter(next.workspaceRoot, next.id, chapter);
    }
    await saveLongWritingTask(next.workspaceRoot, next);
    return next;
  });

  const recordEvent = (
    type: LongWritingEventType,
    message: string,
    options: { chapterId?: string; attempt?: number; details?: LongWritingEventDetails } = {},
  ) => mutateTask(current => ({
    ...current,
    events: appendLongWritingEvent(current.events, createLongWritingEvent(type, message, options)),
    updatedAt: new Date().toISOString(),
  }));

  useEffect(() => {
    documentRef.current = project.markdown;
  }, [project.markdown]);

  useEffect(() => {
    if (!taskRef.current) setModelSelection(project.selectedModel);
  }, [project.selectedModel]);

  useEffect(() => {
    if (mode === "fill") {
      setSelected(new Set(parsed.chapters.filter(chapter => chapter.bodyMarkdown.replace(/\s/g, "").length < 200).map(chapter => chapter.id)));
    } else {
      setSelected(new Set(parsed.chapters.map(chapter => chapter.id)));
    }
  }, [mode, project.filePath]);

  useEffect(() => {
    if (!project.workspace?.root || !project.filePath) return;
    let active = true;
    void listLongWritingTasks<LongWritingTaskRecord>(project.workspace.root, project.filePath)
      .then(async rows => {
        const latest = rows.find(item => unfinished.has(item.status));
        if (!latest || !active) return;
        try {
          const recovered = await recoverLongWritingTask<LongWritingTaskRecord, ChapterJob>(project.workspace!.root, latest.id);
          const snapshot = await readTextFileSnapshot(latest.filePath);
          if (!active) return;
          documentRef.current = snapshot.content;
          await onDocumentSnapshot(snapshot);
          const next = { ...recovered.task, chapters: recovered.chapters, currentDocumentHash: snapshot.sha256 };
          setTaskBoth(next);
          if (next.modelProviderId) setModelSelection({ providerId: next.modelProviderId, model: next.model });
          if (next.plan) setOutlineRows(createEditableOutline(next.plan, snapshot.content));
          const planningFailed = next.status === "failed" && !next.plan;
          const locked = !["completed", "cancelled", "restored"].includes(next.status) && !planningFailed;
          onLockChange(locked);
          if (recovered.recovery === "conflict") notify("检测到长任务与磁盘文件冲突，请恢复备份或人工处理");
          else if (planningFailed) notify(`上次目录规划失败：${next.error || "未记录错误详情"}`);
          else notify("检测到未完成长任务，可继续、终止或恢复任务前原文");
        } catch (error) {
          notify(longWritingErrorMessage(error, "恢复长任务失败"));
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [project.workspace?.root, project.filePath]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const hasValidModelSelection = !!modelSelection && modelOptions.some(option => modelKey(option.selection) === modelKey(modelSelection));

  const modelConfig = (record?: LongWritingTaskRecord): ResolvedModelConfig => resolveActiveModelConfig(
    project.providers,
    record?.modelProviderId ? { providerId: record.modelProviderId, model: record.model } : modelSelection,
    { aiEnabled: project.model.enabled },
  );

  const updateJob = (jobId: string, patch: Partial<ChapterJob>) => mutateTask(current => ({
    ...current,
    chapters: current.chapters.map(job => job.id === jobId ? { ...job, ...patch } : job),
    updatedAt: new Date().toISOString(),
  }), [jobId]);

  const startPlanning = async () => {
    if (!project.workspace?.root || !project.filePath) return notify("长任务仅支持已保存的工作区 Markdown");
    if (!parsed.chapters.length) return notify("当前文档没有可处理的 H2 章节");
    if (!selected.size && mode !== "targeted") return notify("请至少选择一个章节");
    if (!instruction.trim()) return notify("请填写通篇编写或修改指令");
    if (!hasValidModelSelection) return notify("请选择可用模型");
    setBusy(true);
    onLockChange(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let preparingTask: LongWritingTaskRecord | null = null;
    try {
      const config = modelConfig();
      const snapshot = await saveBeforeStart();
      if (!snapshot) throw new Error("启动前保存被取消");
      documentRef.current = snapshot.content;
      const taskId = uid("long-writing");
      const backup = await createProposalBackup({ workspaceRoot: project.workspace.root, filePath: project.filePath, taskId, kind: "original" });
      const requested = [...selected];
      const sourceRefs = project.sources.filter(source => sourceIds.has(source.id)).map(source => ({ id: source.id, title: source.title, path: source.location, excerpt: source.excerpt }));
      const now = new Date().toISOString();
      const baseTask: LongWritingTaskRecord = {
        id: taskId,
        filePath: project.filePath,
        workspaceRoot: project.workspace.root,
        mode,
        status: "preparing",
        instruction: instruction.trim(),
        model: config.model,
        modelProviderId: config.providerId,
        concurrency,
        selectedChapterIds: requested,
        sourceRefs,
        initialDocumentHash: snapshot.sha256,
        currentDocumentHash: snapshot.sha256,
        initialBackup: { path: backup.path, sourceFilePath: project.filePath, sourceHash: backup.sha256, kind: "initial", createdAt: backup.createdAt },
        chapters: [],
        consistencyIssues: [],
        events: [
          createLongWritingEvent("task_started", "已保存当前正文，Coordinator 开始准备长任务"),
          createLongWritingEvent("backup_created", `已创建任务前原文备份：${backup.path}`, { details: { backupPath: backup.path } }),
        ],
        createdAt: now,
        updatedAt: now,
      };
      preparingTask = baseTask;
      await replacePersistedTask(baseTask);

      const attachedSources = project.sources.filter(source => sourceIds.has(source.id)).map(textFromSource);
      const planningChapters = parseLongWritingDocument(snapshot.content).chapters;
      const useModelSummaries = planningChapters.length >= 8 || snapshot.content.length >= 30_000;
      const chapterSummaries = useModelSummaries
        ? await mapConcurrent(planningChapters, concurrency, controller.signal, async chapter => {
            try {
              await recordEvent("summary_started", `开始提取章节摘要：${chapter.titlePath.join(" / ")}`, { chapterId: chapter.id });
              const summary = await createChapterSummary({
                chapterId: chapter.id,
                titlePath: chapter.titlePath,
                markdown: chapter.markdown,
                documentTitle: project.name,
                instruction: instruction.trim(),
                contextBudgetTokens: project.agent.contextCompressionTokens,
              }, config, controller.signal);
              await recordEvent("summary_completed", `章节摘要已完成：${chapter.titlePath.join(" / ")}`, {
                chapterId: chapter.id,
                details: { contentLength: chapter.bodyMarkdown.length, factCount: summary.facts.length, termCount: summary.terminology.length },
              });
              return {
                chapterId: chapter.id,
                order: chapter.order,
                titlePath: chapter.titlePath,
                summary: summary.summary,
                facts: summary.facts,
                terminology: summary.terminology,
                unresolvedQuestions: summary.unresolvedQuestions,
                contentLength: chapter.bodyMarkdown.length,
              };
            } catch (error) {
              if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
              const detail = longWritingErrorMessage(error, "未知模型错误");
              const fallback = createLocalChapterSummary({
                chapterId: chapter.id,
                titlePath: chapter.titlePath,
                markdown: chapter.markdown,
              });
              await recordEvent("summary_fallback", `章节摘要模型调用失败，已使用本地摘要：${chapter.titlePath.join(" / ")}`, {
                chapterId: chapter.id,
                details: { error: detail, fallback: true },
              });
              return {
                chapterId: chapter.id,
                order: chapter.order,
                titlePath: chapter.titlePath,
                summary: fallback.summary,
                facts: fallback.facts,
                terminology: fallback.terminology,
                unresolvedQuestions: fallback.unresolvedQuestions,
                contentLength: chapter.bodyMarkdown.length,
              };
            }
          })
        : planningChapters.map(chapter => ({
            chapterId: chapter.id, order: chapter.order, titlePath: chapter.titlePath,
            summary: chapter.bodyMarkdown.replace(/\s+/g, " ").slice(0, 800), contentLength: chapter.bodyMarkdown.length,
          }));
      let generated: OutlinePlan;
      try {
        await recordEvent("outline_started", `章节信息已就绪，开始生成目录规划（${planningChapters.length} 章）`, { details: { chapterCount: planningChapters.length } });
        generated = await createOutlinePlan({
          mode,
          instruction: instruction.trim(),
          documentTitle: project.name,
          markdown: useModelSummaries ? snapshot.content.slice(0, 12_000) : snapshot.content,
          requestedChapterIds: requested,
          attachedSources,
          chapterSummaries,
          contextBudgetTokens: project.agent.contextCompressionTokens,
        }, config, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
        const detail = longWritingErrorMessage(error, "未知模型错误");
        generated = createLocalOutlinePlan(planningChapters, mode, requested);
        await recordEvent("outline_fallback", "目录规划模型调用失败，已使用本地目录规划，等待人工确认", {
          details: { error: detail, fallback: true, chapterCount: planningChapters.length },
        });
      }
      const plan = normalizePlan(generated, snapshot.content, mode, requested);
      const planningState = taskRef.current?.id === baseTask.id ? taskRef.current : baseTask;
      const next: LongWritingTaskRecord = {
        ...planningState,
        status: "awaiting_outline",
        selectedChapterIds: plan.targetChapterIds,
        plan,
        events: appendLongWritingEvent(planningState.events, createLongWritingEvent("outline_completed", `目录规划已生成，等待确认 ${plan.targetChapterIds.length} 个处理章节`, { details: { targetChapterCount: plan.targetChapterIds.length } })),
        error: undefined,
        updatedAt: new Date().toISOString(),
      };
      setOutlineRows(createEditableOutline(plan, snapshot.content));
      await replacePersistedTask(next);
      onLockChange(true);
      notify("目录规划已生成，可新增、删除、改名、重排并调整处理范围");
    } catch (error) {
      const message = longWritingErrorMessage(error, "生成目录规划失败");
      const cancelled = controller.signal.aborted;
      // Promise.all rejects as soon as one summary fails. Cancel sibling summary
      // requests so an abandoned planning attempt does not keep loading the gateway.
      if (!cancelled) controller.abort(error);
      if (preparingTask && taskRef.current?.id === preparingTask.id) {
        try {
          await mutateTask(current => ({
            ...current,
            status: cancelled ? "cancelled" : "failed",
            error: message,
            events: appendLongWritingEvent(current.events, createLongWritingEvent(cancelled ? "cancelled" : "failed", cancelled ? "目录规划已停止" : `目录规划失败：${message}`)),
            updatedAt: new Date().toISOString(),
          }));
        } catch (persistError) {
          console.error("保存目录规划失败诊断失败", persistError);
        }
      }
      onLockChange(false);
      notify(message);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const confirmOutlineAndStart = async () => {
    const current = taskRef.current;
    if (!current?.plan) return;
    if (!outlineRows.some(row => row.action !== "keep")) return notify("请至少选择一个需要处理的章节");
    setBusy(true);
    try {
      const edited = applyEditableOutline(documentRef.current, outlineRows);
      const numbered = alignHeadingsToRules(edited, project.name, "chapter-h2").markdown;
      const outlineWrite = await writeTextFileChecked(current.filePath, numbered, current.currentDocumentHash, false);
      if (outlineWrite.outcome === "conflict") {
        const conflictSnapshot = outlineWrite.snapshot;
        if (conflictSnapshot) {
          documentRef.current = conflictSnapshot.content;
          await onDocumentSnapshot(conflictSnapshot);
        }
        const message = "目录确认前检测到磁盘文件已被外部修改，未覆盖外部版本。请终止任务后重新规划，或明确恢复任务前原文。";
        await mutateTask(taskValue => ({
          ...taskValue,
          status: "conflict",
          currentDocumentHash: conflictSnapshot?.sha256 ?? taskValue.currentDocumentHash,
          error: message,
          events: appendLongWritingEvent(taskValue.events, createLongWritingEvent("conflict_detected", message, {
            details: { phase: "outline_commit", diskHash: conflictSnapshot?.sha256 ?? "unavailable" },
          })),
          updatedAt: new Date().toISOString(),
        }));
        onLockChange(true);
        notify(message);
        setBusy(false);
        return;
      }
      const snapshot = outlineWrite.snapshot;
      documentRef.current = snapshot.content;
      await onDocumentSnapshot(snapshot);
      const chapters = parseLongWritingDocument(snapshot.content).chapters;
      if (chapters.length !== outlineRows.length) throw new Error("应用目录后的章节数量与审核结果不一致");
      const oldToNew = new Map<string, string>();
      outlineRows.forEach((row, index) => { if (row.sourceChapterId) oldToNew.set(row.sourceChapterId, chapters[index].id); });
      const frozenOutline = chapters.map((chapter, index) => ({
        chapterId: chapter.id,
        order: chapter.order,
        titlePath: chapter.titlePath,
        headingSkeleton: chapter.headings.map(heading => `${"#".repeat(heading.level)} ${heading.title}`),
        goal: outlineRows[index].goal.trim() || "按总指令完善本章",
        action: outlineRows[index].action,
      }));
      const plan: OutlinePlan = {
        ...current.plan,
        frozenOutline,
        targetChapterIds: frozenOutline.filter(item => item.action !== "keep").map(item => item.chapterId),
        transitionRequirements: current.plan.transitionRequirements.flatMap(item => {
          const fromChapterId = oldToNew.get(item.fromChapterId);
          const toChapterId = oldToNew.get(item.toChapterId);
          return fromChapterId && toChapterId ? [{ ...item, fromChapterId, toChapterId }] : [];
        }),
        frozenHeadingSignature: JSON.stringify(frozenOutline.map(item => item.headingSkeleton)),
      };
      const jobs: ChapterJob[] = [];
      for (const chapter of chapters.filter(item => plan.targetChapterIds.includes(item.id))) {
        jobs.push({
          id: uid("chapter-job"), taskId: current.id, chapterId: chapter.id, order: chapter.order, titlePath: chapter.titlePath,
          status: "queued", originalMarkdown: chapter.markdown, originalHash: await sha256Text(chapter.markdown),
          frozenHeadingSignature: createFrozenHeadingTreeSignature(chapter), attempts: 0, maxAttempts: 3,
        });
      }
      const confirmed: LongWritingTaskRecord = {
        ...current, status: "running", plan, chapters: jobs, selectedChapterIds: plan.targetChapterIds,
        currentDocumentHash: snapshot.sha256, consistencyIssues: [],
        events: appendLongWritingEvent(current.events, createLongWritingEvent("outline_confirmed", `目录已确认并冻结，创建 ${jobs.length} 个章节 Worker 任务`, { details: { jobCount: jobs.length } })),
        error: undefined, updatedAt: new Date().toISOString(),
      };
      await replacePersistedTask(confirmed, true);
      await runJobs(undefined, undefined, confirmed);
    } catch (error) {
      notify(longWritingErrorMessage(error, "应用目录失败"));
      setBusy(false);
    }
  };

  const runJobs = async (onlyIds?: Set<string>, repairInstruction?: string, taskOverride?: LongWritingTaskRecord) => {
    const initialTask = taskOverride ?? taskRef.current;
    if (!initialTask?.plan || initialTask.status === "cancelled") return;
    const controller = new AbortController();
    abortRef.current = controller;
    pausedRef.current = false;
    setPaused(false);
    setBusy(true);
    let currentMarkdown = documentRef.current;
    let currentHash = initialTask.currentDocumentHash || baselineHash || await sha256Text(currentMarkdown);
    const conflictState: { snapshot: TextFileSnapshot | null } = { snapshot: null };
    const sourceText = project.sources.filter(source => initialTask.sourceRefs.some(ref => ref.id === source.id)).map(textFromSource);
    const candidates = initialTask.chapters.filter(job => onlyIds ? onlyIds.has(job.chapterId) : job.status !== "completed");
    await mutateTask(current => ({
      ...current,
      status: "running",
      error: undefined,
      chapters: current.chapters.map(job => candidates.some(candidate => candidate.id === job.id) ? { ...job, status: "queued", error: undefined } : job),
      events: appendLongWritingEvent(current.events, createLongWritingEvent("resumed", `开始执行 ${candidates.length} 个章节任务，并发 ${initialTask.concurrency}`, { details: { jobCount: candidates.length, concurrency: initialTask.concurrency } })),
      updatedAt: new Date().toISOString(),
    }), candidates.map(job => job.id));
    try {
      const result = await runChapterWorkerPool<ChapterJob, ChapterDraftResult, unknown>(candidates.map(job => ({ id: job.id, order: job.order, value: job })), {
        concurrency: initialTask.concurrency,
        signal: controller.signal,
        isPaused: () => pausedRef.current,
        maxAttempts: 3,
        onProgress: progress => {
          const chapter = progress.job.value;
          const title = chapter.titlePath.join(" / ");
          const event = (() => {
            switch (progress.state) {
              case "running":
                return createLongWritingEvent("worker_started", `${title}：Worker 开始生成`, { chapterId: chapter.chapterId, attempt: progress.attempt });
              case "retryable":
                return createLongWritingEvent("worker_retry", `${title}：临时失败，等待退避重试`, { chapterId: chapter.chapterId, attempt: progress.attempt, details: { error: progress.error ?? "未知错误" } });
              case "validating":
                return createLongWritingEvent("draft_received", `${title}：草稿已返回，开始结构校验`, { chapterId: chapter.chapterId, attempt: progress.attempt, details: { outputLength: progress.result?.markdown.length ?? 0 } });
              case "committing":
                return createLongWritingEvent("commit_started", `${title}：校验通过，进入串行写入队列`, { chapterId: chapter.chapterId, attempt: progress.attempt });
              case "completed":
                return createLongWritingEvent("commit_completed", `${title}：已原子提交到文档`, { chapterId: chapter.chapterId, attempt: progress.attempt, details: { outputLength: progress.result?.markdown.length ?? 0 } });
              case "failed":
                return createLongWritingEvent("failed", `${title}：章节处理失败`, { chapterId: chapter.chapterId, attempt: progress.attempt, details: { error: progress.error ?? "未知错误" } });
              case "cancelled":
                return createLongWritingEvent("cancelled", `${title}：章节请求已停止`, { chapterId: chapter.chapterId, attempt: progress.attempt });
              default:
                return undefined;
            }
          })();
          void mutateTask(current => ({
            ...current,
            chapters: current.chapters.map(job => job.id === progress.job.id ? { ...job, status: progress.state as ChapterJobStatus, attempts: progress.attempt, error: progress.error } : job),
            events: event ? appendLongWritingEvent(current.events, event) : current.events,
            updatedAt: new Date().toISOString(),
          }), [progress.job.id]);
        },
        run: async ({ value: job }, signal) => {
          const chapter = parseLongWritingDocument(currentMarkdown).chapters.find(item => item.id === job.chapterId)
            ?? parseLongWritingDocument(job.originalMarkdown).chapters[0];
          const outline = initialTask.plan!.frozenOutline.find(item => item.chapterId === job.chapterId);
          const transitions = initialTask.plan!.transitionRequirements.filter(item => item.toChapterId === job.chapterId || item.fromChapterId === job.chapterId);
          return createChapterDraft({
            chapterId: job.chapterId,
            titlePath: job.titlePath,
            originalMarkdown: chapter?.markdown ?? job.originalMarkdown,
            chapterGoal: [outline?.goal, repairInstruction].filter(Boolean).join("\n"),
            outlinePlan: initialTask.plan!,
            adjacentBriefs: initialTask.plan!.frozenOutline.filter(item => Math.abs(item.order - job.order) === 1).map(item => ({
              chapterId: item.chapterId,
              relation: item.order < job.order ? "previous" : "next",
              titlePath: item.titlePath,
              summary: taskRef.current?.chapters.find(candidate => candidate.chapterId === item.chapterId)?.summary ?? item.goal,
              transitionRequirement: transitions.find(value => value.fromChapterId === item.chapterId || value.toChapterId === item.chapterId)?.requirement,
            })),
            attachedSources: sourceText,
            contextBudgetTokens: project.agent.contextCompressionTokens,
          }, modelConfig(initialTask), signal);
        },
        validate: ({ value: job }, draft) => {
          const currentChapter = parseLongWritingDocument(currentMarkdown).chapters.find(item => item.id === job.chapterId);
          if (!currentChapter) throw new Error("提交前章节已不存在");
          const validation = validateChapterDraft(currentChapter.markdown, draft.markdown);
          if (!validation.valid) throw new Error(validation.issues.map(issue => issue.message).join("；"));
        },
        commit: async ({ value: job }, draft) => {
          const currentChapter = parseLongWritingDocument(currentMarkdown).chapters.find(item => item.id === job.chapterId);
          if (!currentChapter) throw new Error("提交时章节已不存在");
          const expectedChapterHash = await sha256Text(currentChapter.markdown);
          const nextMarkdown = replaceChapterExact(currentMarkdown, job.chapterId, draft.markdown);
          const targetDocumentHash = await sha256Text(nextMarkdown);
          const committed = await commitLongTaskChapter({
            workspaceRoot: initialTask.workspaceRoot, taskId: initialTask.id, chapterId: job.chapterId, filePath: initialTask.filePath,
            expectedDocumentHash: currentHash, expectedChapterHash, replacementMarkdown: draft.markdown, targetDocumentHash,
          });
          if (committed.outcome === "conflict") {
            if (committed.content && committed.documentHash) {
              conflictState.snapshot = {
                path: committed.filePath,
                content: committed.content,
                sha256: committed.documentHash,
                updatedAt: new Date().toISOString(),
              };
            }
            throw new Error(`磁盘冲突：${committed.reason}`);
          }
          currentMarkdown = committed.content;
          currentHash = committed.documentHash;
          documentRef.current = committed.content;
          await onDocumentSnapshot({ path: committed.filePath, content: committed.content, sha256: committed.documentHash, updatedAt: new Date().toISOString() });
          await updateJob(job.id, {
            draft, summary: draft.summary, committedChapterHash: committed.chapterHash,
            commitTargetDocumentHash: committed.documentHash, completedAt: new Date().toISOString(),
          });
          await mutateTask(current => ({ ...current, currentDocumentHash: committed.documentHash, updatedAt: new Date().toISOString() }));
          return committed;
        },
      });
      await mutationQueueRef.current;
      if (controller.signal.aborted) {
        await mutateTask(current => ({ ...current, status: "cancelled", updatedAt: new Date().toISOString() }));
        onLockChange(false);
        return;
      }
      if (result.failed.size) {
        const conflict = [...result.failed.values()].some(message => message.includes("磁盘冲突"));
        const diskConflictSnapshot = conflictState.snapshot;
        if (diskConflictSnapshot) {
          documentRef.current = diskConflictSnapshot.content;
          await onDocumentSnapshot(diskConflictSnapshot);
          currentMarkdown = diskConflictSnapshot.content;
          currentHash = diskConflictSnapshot.sha256;
        }
        const error = [...result.failed.values()].join("；");
        await mutateTask(current => ({
          ...current,
          status: conflict ? "conflict" : "failed",
          currentDocumentHash: diskConflictSnapshot?.sha256 ?? current.currentDocumentHash,
          error,
          events: conflict
            ? appendLongWritingEvent(current.events, createLongWritingEvent("conflict_detected", "检测到磁盘内容或章节结构与任务预期不一致，已停止后续写入且未覆盖磁盘版本", {
                details: { phase: "chapter_commit", diskHash: diskConflictSnapshot?.sha256 ?? "unavailable" },
              }))
            : current.events,
          updatedAt: new Date().toISOString(),
        }));
        if (conflict) onLockChange(true);
        return;
      }
      await mutateTask(current => ({
        ...current,
        status: "checking",
        currentDocumentHash: currentHash,
        events: appendLongWritingEvent(current.events, createLongWritingEvent("consistency_started", "全部章节已提交，开始本地结构与模型一致性检查")),
        updatedAt: new Date().toISOString(),
      }));
      const latest = taskRef.current ?? initialTask;
      const localIssues = inspectLocalConsistency(initialTask.plan, currentMarkdown);
      const modelIssues = await createConsistencyReport({
        outlinePlan: initialTask.plan,
        markdown: currentMarkdown,
        chapterSummaries: latest.chapters.filter(job => job.summary).map(job => ({ chapterId: job.chapterId, titlePath: job.titlePath, summary: job.summary! })),
        contextBudgetTokens: project.agent.contextCompressionTokens,
      }, modelConfig(initialTask), controller.signal);
      const issues = [...new Map([...localIssues, ...modelIssues].map(issue => [issue.id, { ...issue, status: "pending" as const }])).values()];
      await mutateTask(current => ({
        ...current,
        status: issues.length ? "awaiting_repairs" : "completed",
        consistencyIssues: issues,
        currentDocumentHash: currentHash,
        events: appendLongWritingEvent(current.events, createLongWritingEvent("consistency_completed", issues.length ? `一致性检查完成，发现 ${issues.length} 个待确认问题` : "一致性检查完成，未发现待处理问题", { details: { issueCount: issues.length } })),
        completedAt: issues.length ? undefined : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      if (!issues.length) onLockChange(false);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      await mutateTask(current => ({
        ...current,
        status: cancelled ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
        events: appendLongWritingEvent(current.events, createLongWritingEvent(cancelled ? "cancelled" : "failed", cancelled ? "长任务已停止，已提交章节保留" : `长任务失败：${error instanceof Error ? error.message : String(error)}`)),
        updatedAt: new Date().toISOString(),
      })).catch(() => undefined);
      if (cancelled) onLockChange(false);
      notify(longWritingErrorMessage(error, "长任务失败"));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const togglePause = async () => {
    if (!taskRef.current) return;
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    await mutateTask(current => ({
      ...current,
      status: pausedRef.current ? "paused" : "running",
      events: appendLongWritingEvent(current.events, createLongWritingEvent(pausedRef.current ? "paused" : "resumed", pausedRef.current ? "Coordinator 已暂停分配和写入" : "Coordinator 已继续执行")),
      updatedAt: new Date().toISOString(),
    }));
  };

  const stop = () => {
    abortRef.current?.abort();
    if (!busy && taskRef.current) {
      void mutateTask(current => ({
        ...current,
        status: "cancelled",
        events: appendLongWritingEvent(current.events, createLongWritingEvent("cancelled", "用户已终止长任务，已提交章节保留")),
        updatedAt: new Date().toISOString(),
      }))
        .then(() => onLockChange(false));
    }
  };

  const restoreOriginal = async () => {
    const current = taskRef.current;
    if (!current || !confirm("恢复会撤销本次长任务已提交的正文。当前 AI 版本会先创建安全快照，是否继续？")) return;
    abortRef.current?.abort();
    setBusy(true);
    try {
      const preRestore = await createProposalBackup({ workspaceRoot: current.workspaceRoot, filePath: current.filePath, taskId: current.id, kind: "pre-restore" });
      const restored = await restoreProposalBackup({
        workspaceRoot: current.workspaceRoot, filePath: current.filePath, backupPath: current.initialBackup.path,
        expectedDocumentHash: preRestore.sha256, taskId: current.id,
      });
      const snapshot = { path: restored.filePath, content: restored.content, sha256: restored.sha256, updatedAt: new Date().toISOString() };
      documentRef.current = restored.content;
      await onDocumentSnapshot(snapshot);
      await mutateTask(taskValue => ({
        ...taskValue,
        status: "restored",
        currentDocumentHash: restored.sha256,
        events: appendLongWritingEvent(taskValue.events, createLongWritingEvent("restored", "已创建 pre-restore 快照并恢复任务前原文")),
        updatedAt: new Date().toISOString(),
      }));
      onLockChange(false);
    } catch (error) {
      notify(longWritingErrorMessage(error, "恢复原文失败"));
    } finally { setBusy(false); }
  };

  const repairSelected = async () => {
    const current = taskRef.current;
    if (!current?.plan) return;
    const issues = current.consistencyIssues.filter(issue => issue.status === "selected");
    if (!issues.length) return notify("请先勾选要修正的问题");
    const requestedIds = new Set(issues.flatMap(issue => issue.chapterIds));
    const parsedCurrent = parseLongWritingDocument(documentRef.current);
    const repairableIds = new Set(current.plan.frozenOutline
      .filter(item => requestedIds.has(item.chapterId) && parsedCurrent.chapters.some(chapter => chapter.id === item.chapterId))
      .map(item => item.chapterId));
    if (!repairableIds.size) return notify("所选问题无法通过章节 Worker 自动修正，请恢复目录或人工处理");
    const missingJobs: ChapterJob[] = [];
    for (const chapterId of repairableIds) {
      if (current.chapters.some(job => job.chapterId === chapterId)) continue;
      const chapter = parsedCurrent.chapters.find(item => item.id === chapterId)!;
      missingJobs.push({
        id: uid("repair-job"), taskId: current.id, chapterId, order: chapter.order, titlePath: chapter.titlePath,
        status: "queued", originalMarkdown: chapter.markdown, originalHash: await sha256Text(chapter.markdown),
        frozenHeadingSignature: createFrozenHeadingTreeSignature(chapter), attempts: 0, maxAttempts: 3,
      });
    }
    if (missingJobs.length) {
      await mutateTask(taskValue => ({ ...taskValue, chapters: [...taskValue.chapters, ...missingJobs], updatedAt: new Date().toISOString() }), missingJobs.map(job => job.id));
    }
    await createProposalBackup({ workspaceRoot: current.workspaceRoot, filePath: current.filePath, taskId: current.id, kind: "consistency" });
    await runJobs(repairableIds, `仅修正以下已确认问题，不改变冻结标题：\n${issues.map(issue => `- ${issue.suggestion}`).join("\n")}`);
  };

  const toggleIssue = (id: string) => {
    void mutateTask(current => ({
      ...current,
      consistencyIssues: current.consistencyIssues.map(issue => issue.id === id
        ? { ...issue, status: issue.status === "selected" ? "pending" as const : "selected" as const }
        : issue),
      updatedAt: new Date().toISOString(),
    }));
  };

  const updateOutlineRow = (key: string, patch: Partial<EditableOutlineChapter>) => {
    setOutlineRows(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row));
  };

  const moveOutlineRow = (index: number, delta: -1 | 1) => {
    setOutlineRows(rows => {
      const target = index + delta;
      if (target < 0 || target >= rows.length) return rows;
      const next = [...rows];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  if (!task && availability) return <div className="long-writing-empty" data-reason={availability.issue}><WandSparkles size={24} /><b>{availability.title}</b><span>{availability.description}</span></div>;

  if (!task) return <div className="long-writing-panel">
    <div className="long-writing-intro"><WandSparkles size={18} /><div><b>按章节通篇编写/修改</b><span>Coordinator 规划，隔离 Worker 限并发生成，串行安全写入。</span></div></div>
    <label>任务模式<select value={mode} onChange={event => setMode(event.target.value as LongWritingMode)}>
      <option value="fill">补写空白/短章节</option><option value="rewrite">通篇改写所选章节</option><option value="targeted">按指令修改受影响章节</option>
    </select></label>
    <label>总指令<textarea value={instruction} onChange={event => setInstruction(event.target.value)} rows={5} placeholder="说明目标、必须保留的事实、风格和边界…" /></label>
    <label>模型<select value={modelSelection ? modelKey(modelSelection) : ""} onChange={event => {
      const option = modelOptions.find(item => modelKey(item.selection) === event.target.value);
      setModelSelection(option?.selection ?? null);
    }}><option value="">请选择模型</option>{modelOptions.map(option => <option key={modelKey(option.selection)} value={modelKey(option.selection)}>{option.label}</option>)}</select></label>
    <div className="long-writing-section"><b>章节范围</b>{parsed.chapters.map(chapter => <label className="long-writing-check" key={chapter.id}>
      <input type="checkbox" checked={selected.has(chapter.id)} onChange={() => setSelected(current => { const next = new Set(current); next.has(chapter.id) ? next.delete(chapter.id) : next.add(chapter.id); return next; })} />
      <span>{chapter.titlePath.join(" / ")}</span><em>{chapter.bodyMarkdown.replace(/\s/g, "").length} 字</em>
    </label>)}</div>
    {!!project.sources.length && <div className="long-writing-section"><b>明确附加资料</b>{project.sources.map(source => <label className="long-writing-check" key={source.id}>
      <input type="checkbox" checked={sourceIds.has(source.id)} onChange={() => setSourceIds(current => { const next = new Set(current); next.has(source.id) ? next.delete(source.id) : next.add(source.id); return next; })} />
      <span>{source.title}</span>
    </label>)}</div>}
    <label>并发 Worker<select value={concurrency} onChange={event => setConcurrency(Number(event.target.value) as 1 | 2 | 3)}><option value={1}>1（严格顺序）</option><option value={2}>2（默认）</option><option value={3}>3（最快）</option></select></label>
    <button className="long-writing-primary" disabled={busy || !hasValidModelSelection} onClick={() => void startPlanning()}>{busy ? "正在备份并规划…" : "检查目录并生成计划"}</button>
    {busy && <button onClick={() => abortRef.current?.abort()}><Square size={13} />停止规划</button>}
  </div>;

  const done = task.chapters.filter(job => job.status === "completed").length;
  const progress = task.chapters.length ? Math.round(done / task.chapters.length * 100) : 0;
  const planningFailed = task.status === "failed" && !task.plan;
  const resumable = !!task.plan && task.chapters.length > 0 && ["running", "paused", "failed"].includes(task.status);
  return <div className="long-writing-panel">
    {availability && <div className="long-writing-warning"><AlertTriangle size={15} /><span>当前编辑器的桌面工作区上下文暂时不可用：{availability.title}。长任务仍绑定到 <code>{task.filePath}</code>，进度和执行输出不会被此提示页覆盖。</span></div>}
    <div className={`long-writing-task-head status-${task.status}`}><div><b>{task.status === "awaiting_outline" ? "目录待确认" : task.status === "awaiting_repairs" ? "一致性检查待处理" : `长任务：${task.status}`}</b><span>{task.mode} · {task.model} · 并发 {task.concurrency}</span></div><em>{progress}%</em></div>
    <div className="long-writing-progress"><i style={{ width: `${progress}%` }} /></div>
    {task.error && <div className="long-writing-warning"><AlertTriangle size={15} />{task.error}</div>}
    <LongWritingEventLog events={task.events ?? []} busy={busy} />
    {planningFailed && <button className="long-writing-primary" disabled={busy} onClick={() => { void mutateTask(current => ({ ...current, status: "cancelled", events: appendLongWritingEvent(current.events, createLongWritingEvent("cancelled", "已关闭失败的目录规划，准备重新创建任务")), updatedAt: new Date().toISOString() })).then(() => { setTaskBoth(null); setOutlineRows([]); onLockChange(false); }).catch(error => notify(longWritingErrorMessage(error, "关闭失败任务失败"))); }}>返回并重新规划</button>}
    {task.status === "awaiting_outline" && task.plan && <>
      <div className="long-writing-bible"><b>Document Bible</b><p>{task.plan.documentSummary}</p><small>受众：{task.plan.audience}</small><small>规则：{task.plan.writingRules.join("；") || "无"}</small></div>
      <div className="long-writing-section long-writing-outline-editor"><div className="long-writing-section-title"><b>审核目录与处理范围</b><button type="button" onClick={() => setOutlineRows(rows => [...rows, createNewOutlineChapter(task.mode, rows.length)])}><Plus size={13} />新增章节</button></div>
        {outlineRows.map((row, index) => <div className={`long-writing-outline-edit-row ${row.action === "keep" ? "keep" : "target"}`} key={row.key}>
          <div className="long-writing-outline-main"><span>{index + 1}</span><input value={row.title} onChange={event => updateOutlineRow(row.key, { title: event.target.value })} /></div>
          <div className="long-writing-outline-controls"><select value={row.action} onChange={event => updateOutlineRow(row.key, { action: event.target.value as OutlineChapterAction })}><option value="keep">保持</option><option value="fill">补写</option><option value="rewrite">改写</option><option value="modify">定向修改</option></select><button title="上移" disabled={index === 0} onClick={() => moveOutlineRow(index, -1)}><ChevronUp size={13} /></button><button title="下移" disabled={index === outlineRows.length - 1} onClick={() => moveOutlineRow(index, 1)}><ChevronDown size={13} /></button><button title="删除" disabled={outlineRows.length === 1} onClick={() => setOutlineRows(rows => rows.filter(item => item.key !== row.key))}><Trash2 size={13} /></button></div>
          <textarea rows={2} value={row.goal} onChange={event => updateOutlineRow(row.key, { goal: event.target.value })} placeholder="章节目标" />
        </div>)}
      </div>
      <div className="long-writing-warning"><AlertTriangle size={15} />确认后会一次性应用新增、删除、改名、重排和编号，并冻结全部标题；Worker 只能修改正文。</div>
      <button className="long-writing-primary" disabled={busy || !outlineRows.some(row => row.action !== "keep")} onClick={() => void confirmOutlineAndStart()}>确认目录并开始写作</button>
      <button onClick={() => void restoreOriginal()}>取消并恢复原文</button>
    </>}
    {task.status !== "awaiting_outline" && <div className="long-writing-jobs">{task.chapters.map(job => <LongWritingJobCard
      key={job.id}
      job={job}
      filePath={task.filePath}
      workspaceRoot={task.workspaceRoot}
      onLocate={() => onLocateChapter(job.titlePath)}
      onRetry={() => void runJobs(new Set([job.chapterId]))}
    />)}</div>}
    {busy && <div className="long-writing-actions"><button onClick={() => void togglePause()}>{paused ? <CirclePlay size={14} /> : <CirclePause size={14} />}{paused ? "继续" : "暂停"}</button><button onClick={stop}><Square size={13} />停止</button></div>}
    {!busy && resumable && <div className="long-writing-actions"><button onClick={() => void runJobs()}><CirclePlay size={14} />继续未完成章节</button><button onClick={stop}><Square size={13} />终止任务</button></div>}
    {task.status === "awaiting_repairs" && <div className="long-writing-issues"><b>一致性问题（不会自动修改）</b>{task.consistencyIssues.map(issue => <label key={issue.id}>
      <input type="checkbox" checked={issue.status === "selected"} onChange={() => toggleIssue(issue.id)} /><span><strong>{issue.type}</strong>{issue.evidence}<small>{issue.suggestion}</small></span><em>{issue.severity}</em>
    </label>)}<button className="long-writing-primary" disabled={busy} onClick={() => void repairSelected()}>修正已选择问题</button><button onClick={() => { void mutateTask(current => ({ ...current, status: "completed", completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })).then(() => onLockChange(false)); }}>忽略问题并完成</button></div>}
    {task.status === "conflict" && <div className="long-writing-conflict-actions">
      <div className="long-writing-warning"><AlertTriangle size={15} />长任务已停止模型执行但继续占有文档写锁。当前编辑器已同步为磁盘版本，不会自动合并或强制覆盖。</div>
      <button disabled={busy} onClick={() => { void mutateTask(current => ({ ...current, status: "cancelled", events: appendLongWritingEvent(current.events, createLongWritingEvent("cancelled", "用户选择保留外部磁盘版本并终止长任务")), updatedAt: new Date().toISOString() })).then(() => onLockChange(false)); }}>保留外部版本并终止</button>
    </div>}
    {task.status !== "restored" && <button className="long-writing-restore" disabled={busy} onClick={() => void restoreOriginal()}><RotateCcw size={14} />恢复任务前原文</button>}
    {["completed", "cancelled", "restored"].includes(task.status) && <button disabled={busy} onClick={() => { setTaskBoth(null); setOutlineRows([]); onLockChange(false); }}>新建长任务</button>}
  </div>;

}


