import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpen, CheckCheck, ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, CirclePause, CirclePlay, Power, RefreshCw, RotateCcw, Search, Server, Square, WandSparkles, X } from "lucide-react";
import type { Project } from "../../core/types";
import { ContextReferences } from "../../components/ContextReferences";
import { isDesktop } from "../../services/runtime";
import { readTextFileSnapshot, writeTextFileChecked, type TextFileSnapshot } from "../workspace/documentSafety";
import { buildHeadingTargetTree, collectCollapsibleHeadingIds, filterHeadingTargetTree, getHeadingTargetById, normalizeSelectedHeadingIds, parseHeadingTargets, selectAllHeadingTargetIds, validateHeadingTargetEdit, type HeadingTargetTreeNode, type ParsedHeadingTarget } from "./chapterParser";
import { appendLongWritingEvent, createLongWritingEvent } from "./events";
import { LongWritingCoordinatorCard, LongWritingEventLog, LongWritingJobCard } from "./LongWritingOutput";
import { createProposalBackup, listLongWritingTasks, restoreProposalBackup, saveLongWritingChapter, saveLongWritingTask } from "./service";
import { abortOpenCodeSession, createOpenCodeSession, getOpenCodeServerStatus, listOpenCodeModels, listenOpenCodeEvents, listenOpenCodeServerStatus, promptOpenCodeSession, startOpenCodeServer, stopOpenCodeServer, type OpenCodeModelOption, type OpenCodeModelRef, type OpenCodeServerStatus } from "./opencodeService";
import { OpenCodeModelSelect } from "./OpenCodeModelSelect";
import { appendOpenCodeSessionActivity, normalizeOpenCodeSessionEvent, type OpenCodeSessionActivityMap } from "./openCodeEvents";
import { LongWritingDetailModal } from "./LongWritingDetailModal";
import type { ChapterDraftResult, ChapterJob, LongWritingMode, LongWritingSourceRef, LongWritingTaskRecord } from "./types";
import { getLongWritingAvailability } from "./availability";

const ACTIVE_TASKS = new Set<LongWritingTaskRecord["status"]>(["preparing", "awaiting_outline", "running", "paused", "checking", "failed", "conflict"]);
const WRITING_SYSTEM = [
  "你是构案的 OpenCode 标题子树编辑 Worker。",
  "必须先重新读取正式 Markdown 文件，再使用文件编辑工具直接修改它。",
  "只能修改指定标题从标题行开始到下一个同级或更高标题之前的完整子树。",
  "不得修改标题文本、标题层级、父子关系、其他章节、引用资料或任何其他文件。",
  "不得运行 shell、联网搜索、子代理或外部命令。完成编辑后只简要说明结果。",
].join("\n");
const ANALYSIS_SYSTEM = [
  "你是构案的 OpenCode 长任务分析 Worker。",
  "本阶段只读，不得编辑文件、运行命令或联网。",
  "分析指定标题子树应如何按总指令优化，列出事实约束、内容结构、保留项和风险。",
  "不要输出思维过程，只输出可供后续写入阶段执行的简洁编辑计划。",
].join("\n");

function uid(prefix: string) { return `${prefix}-${Date.now()}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`; }
async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function mapConcurrent<T>(values: T[], concurrency: number, mapper: (value: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, async () => {
    while (cursor < values.length) await mapper(values[cursor++]);
  }));
}
function boundedReferences(refs: LongWritingSourceRef[], target?: ParsedHeadingTarget) {
  const terms = target ? `${target.titlePath.join(" ")} ${target.markdown.slice(0, 1200)}`.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1) : [];
  const sorted = refs.map(ref => ({ ref, score: terms.reduce((sum, term) => sum + (`${ref.title}\n${ref.content ?? ref.excerpt ?? ""}`.toLocaleLowerCase().includes(term) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score);
  let used = 0;
  const chunks: string[] = [];
  for (const { ref } of sorted) {
    const value = `### ${ref.title}\n${ref.content ?? ref.excerpt ?? ""}`.slice(0, 8000);
    if (used + value.length <= 32_000) { chunks.push(value); used += value.length; }
  }
  return chunks.length ? chunks.join("\n\n") : "（无引用资料）";
}
function extractCreatedOutline(value: string) {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? value;
  const start = fenced.indexOf("{"); const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("OpenCode 未返回可解析的目录 JSON");
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as { outlineMarkdown?: unknown };
  if (typeof parsed.outlineMarkdown !== "string" || !/^##\s+/m.test(parsed.outlineMarkdown)) throw new Error("OpenCode 返回的目录缺少 H2 标题");
  return parsed.outlineMarkdown.trim();
}
function serverLabel(status: OpenCodeServerStatus) { return ({ stopped: "已停止", starting: "启动中", healthy: "正常", unhealthy: "异常", stopping: "停止中" } satisfies Record<OpenCodeServerStatus["phase"], string>)[status.phase]; }

export function LongWritingPanel({ project, saveBeforeStart, onDocumentSnapshot, onLockChange, onLocateChapter, onManageReferences, notify }: {
  project: Project;
  baselineHash: string | null;
  saveBeforeStart: (content?: string) => Promise<TextFileSnapshot | null>;
  onDocumentSnapshot: (snapshot: TextFileSnapshot) => Promise<void> | void;
  onLockChange: (locked: boolean) => void;
  onLocateChapter: (titlePath: string[]) => void;
  onManageReferences?: () => void;
  notify: (message: string) => void;
}) {
  const desktop = isDesktop();
  const availability = getLongWritingAvailability(desktop, project);
  const targets = useMemo(() => parseHeadingTargets(project.markdown), [project.markdown]);
  const targetTree = useMemo(() => buildHeadingTargetTree(project.markdown), [project.markdown]);
  const [headingSearch, setHeadingSearch] = useState("");
  const targetById = useMemo(() => new Map(targets.map(target => [target.id, target])), [targets]);
  const referencedSources = useMemo(() => project.sources.filter(source => project.contextSourceRefs.includes(source.id)), [project.sources, project.contextSourceRefs]);
  const [serverStatus, setServerStatus] = useState<OpenCodeServerStatus>({ phase: "stopped", activeSessions: 0, recentLogs: [] });
  const [models, setModels] = useState<OpenCodeModelOption[]>([]);
  const [modelRef, setModelRef] = useState<OpenCodeModelRef | null>(null);
  const [mode, setMode] = useState<LongWritingMode>("fill");
  const [documentTitle, setDocumentTitle] = useState(project.name);
  const [instruction, setInstruction] = useState("");
  const [concurrency, setConcurrency] = useState<1 | 2 | 3>(2);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [generatedOutline, setGeneratedOutline] = useState("");
  const [task, setTask] = useState<LongWritingTaskRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionActivities, setSessionActivities] = useState<OpenCodeSessionActivityMap>({});
  const [detailTarget, setDetailTarget] = useState<{ jobId?: string } | null>(null);
  const visibleTargetTree = useMemo(() => filterHeadingTargetTree(targetTree, headingSearch), [headingSearch, targetTree]);
  const taskRef = useRef<LongWritingTaskRecord | null>(null);
  const activeSessions = useRef<Set<string>>(new Set());
  const mutationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const stopRequested = useRef(false);
  const setTaskBoth = (value: LongWritingTaskRecord | null) => { taskRef.current = value; setTask(value); };
  const persist = (value: LongWritingTaskRecord, saveJobs = false) => {
    const operation = mutationQueue.current.then(async () => {
      setTaskBoth(value); await saveLongWritingTask(value.workspaceRoot, value);
      if (saveJobs) for (const job of value.chapters) await saveLongWritingChapter(value.workspaceRoot, value.id, job);
      return value;
    });
    mutationQueue.current = operation.then(() => undefined, () => undefined); return operation;
  };
  const mutate = (updater: (value: LongWritingTaskRecord) => LongWritingTaskRecord, jobIds: string[] = []) => {
    const operation = mutationQueue.current.then(async () => {
      const current = taskRef.current; if (!current) throw new Error("长任务不存在");
      const next = updater(current); setTaskBoth(next);
      for (const id of jobIds) { const job = next.chapters.find(candidate => candidate.id === id); if (job) await saveLongWritingChapter(next.workspaceRoot, next.id, job); }
      await saveLongWritingTask(next.workspaceRoot, next); return next;
    });
    mutationQueue.current = operation.then(() => undefined, () => undefined); return operation;
  };
  const patchJob = (jobId: string, patch: Partial<ChapterJob>) => mutate(current => ({ ...current, chapters: current.chapters.map(job => job.id === jobId ? { ...job, ...patch } : job), updatedAt: new Date().toISOString() }), [jobId]);
  const appendEvent = (type: Parameters<typeof createLongWritingEvent>[0], message: string, chapterId?: string) => mutate(current => ({ ...current, events: appendLongWritingEvent(current.events, createLongWritingEvent(type, message, { chapterId })), updatedAt: new Date().toISOString() }));

  const refreshServer = async () => {
    try {
      const status = await getOpenCodeServerStatus(); setServerStatus(status);
      if (status.phase === "healthy" && project.workspace?.root) {
        const options = await listOpenCodeModels(project.workspace.root); setModels(options);
        setModelRef(current => current && options.some(item => item.providerId === current.providerId && item.modelId === current.modelId) ? current : options.find(item => item.isDefault) ?? options[0] ?? null);
      }
      return status;
    } catch (error) { notify(error instanceof Error ? error.message : "读取 OpenCode Server 状态失败"); return null; }
  };
  const ensureServer = async () => {
    if (serverStatus.phase === "healthy") return serverStatus;
    const status = await startOpenCodeServer(); setServerStatus(status);
    if (project.workspace?.root) {
      const options = await listOpenCodeModels(project.workspace.root); setModels(options);
      setModelRef(options.find(item => item.isDefault) ?? options[0] ?? null);
    }
    return status;
  };
  useEffect(() => {
    if (!desktop) return;
    void refreshServer(); let unlisten: (() => void) | undefined;
    void listenOpenCodeServerStatus(setServerStatus).then(value => { unlisten = value; });
    const timer = window.setInterval(() => void refreshServer(), 5000);
    return () => { unlisten?.(); window.clearInterval(timer); };
  }, [desktop, project.workspace?.root]);
  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void) | undefined;
    void listenOpenCodeEvents(value => {
      const activity = normalizeOpenCodeSessionEvent(value);
      if (activity) setSessionActivities(current => appendOpenCodeSessionActivity(current, activity));
    }).then(value => { unlisten = value; });
    return () => unlisten?.();
  }, [desktop]);
  useEffect(() => {
    if (taskRef.current || mode === "create") { if (mode === "create") setSelected(new Set()); return; }
    const defaults = targets.filter(target => target.level === 2 && (mode !== "fill" || target.bodyMarkdown.replace(/\s/g, "").length < 200));
    setSelected(new Set(defaults.map(target => target.id)));
  }, [mode, project.filePath, targets.length]);
  useEffect(() => {
    if (!project.workspace?.root || !project.filePath) return;
    let active = true;
    void listLongWritingTasks<LongWritingTaskRecord>(project.workspace.root, project.filePath).then(rows => {
      const latest = rows.find(value => value.backend === "opencode-http" && ACTIVE_TASKS.has(value.status));
      if (!latest || !active) return;
      const recovered = { ...latest, status: latest.status === "running" || latest.status === "checking" ? "paused" as const : latest.status, chapters: latest.chapters.map(job => ["analyzing", "writing", "validating"].includes(job.status) ? { ...job, status: "retryable" as const, error: "应用中断，已重新排队并等待磁盘对账" } : job) };
      setTaskBoth(recovered); setGeneratedOutline(recovered.generatedOutlineMarkdown ?? "");
      if (recovered.modelRef) setModelRef(recovered.modelRef);
      onLockChange(!["completed", "cancelled", "restored"].includes(recovered.status));
      notify("已恢复 OpenCode 长任务记录；继续前会重新读取正式文件并校验目标范围");
      void persist(recovered, true);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [project.workspace?.root, project.filePath]);

  const snapshotReferences = async (): Promise<LongWritingSourceRef[]> => Promise.all(referencedSources.map(async source => {
    const content = source.content ?? source.excerpt ?? "";
    return { id: source.id, title: source.title, path: source.location, excerpt: source.excerpt, content, contentHash: await sha256Text(content) };
  }));
  const startPlanning = async () => {
    if (!project.workspace?.root || !project.filePath) return notify("请先打开工作区内已保存的 Markdown");
    if (!instruction.trim()) return notify("请填写长任务总指令");
    if (mode !== "create" && !normalizeSelectedHeadingIds(project.markdown, selected).length) return notify("请至少选择一个标题范围");
    if (mode === "create" && !documentTitle.trim()) return notify("请填写方案标题");
    setBusy(true); stopRequested.current = false; onLockChange(true);
    try {
      const server = await ensureServer(); if (!modelRef) throw new Error("OpenCode 没有可用的已连接模型");
      const saved = await saveBeforeStart(); if (!saved) throw new Error("启动前保存已取消");
      const taskId = uid("long-writing-v2");
      const backup = await createProposalBackup({ workspaceRoot: project.workspace.root, filePath: project.filePath, taskId, kind: "original" });
      const sourceRefs = await snapshotReferences();
      const selectedHeadingIds = normalizeSelectedHeadingIds(saved.content, selected);
      const mainSessionId = await createOpenCodeSession({ directory: project.workspace.root, title: `构案长任务：${project.name}`, model: modelRef, filePath: project.filePath });
      activeSessions.current.add(mainSessionId);
      const now = new Date().toISOString();
      const base: LongWritingTaskRecord = {
        id: taskId, schemaVersion: 2, backend: "opencode-http", mainSessionId, serverVersion: server.version ?? undefined,
        filePath: project.filePath, workspaceRoot: project.workspace.root, mode, status: "preparing", instruction: instruction.trim(), documentTitle: mode === "create" ? documentTitle.trim() : undefined,
        model: modelRef.modelId, modelProviderId: modelRef.providerId, modelRef, concurrency, selectedHeadingIds, selectedChapterIds: selectedHeadingIds, sourceRefs,
        initialDocumentHash: saved.sha256, currentDocumentHash: saved.sha256,
        initialBackup: { path: backup.path, sourceFilePath: project.filePath, sourceHash: backup.sha256, kind: "initial", createdAt: backup.createdAt },
        chapters: [], consistencyIssues: [],
        events: [createLongWritingEvent("server_started", `OpenCode Server ${server.version ?? "unknown"} 已就绪`), createLongWritingEvent("backup_created", `已创建任务前备份：${backup.path}`), createLongWritingEvent("session_created", `已创建 Coordinator session：${mainSessionId}`)],
        createdAt: now, updatedAt: now,
      };
      await persist(base);
      const scope = mode === "create" ? `从零创建方案，标题为“${documentTitle.trim()}”。` : `仅规划以下已由用户选择的标题子树：\n${selectedHeadingIds.map(id => targetById.get(id)?.titlePath.join(" / ")).filter(Boolean).join("\n")}`;
      const format = mode === "create" ? "只返回 JSON：{\"outlineMarkdown\":\"以 ## 开始、可包含 ### 到 ###### 的完整目录骨架\"}。不得使用代码围栏。" : "返回简洁的 Document Bible、各目标范围的写作目标、固定事实、术语和衔接要求。不得编辑文件。";
      const result = await promptOpenCodeSession({ directory: project.workspace.root, sessionId: mainSessionId, phase: "analysis", system: "你是构案长任务 Coordinator。只做规划，不编辑文件、不运行命令、不联网；只使用当前方案和显式引用资料。", text: `${scope}\n\n总指令：\n${instruction.trim()}\n\n引用资料：\n${boundedReferences(sourceRefs)}\n\n${format}` });
      const outline = mode === "create" ? extractCreatedOutline(result.text) : "";
      const current = taskRef.current ?? base;
      const next: LongWritingTaskRecord = { ...current, status: "awaiting_outline", mainAnalysis: result.text, generatedOutlineMarkdown: outline || undefined, updatedAt: new Date().toISOString(), events: appendLongWritingEvent(current.events, createLongWritingEvent("outline_completed", "Coordinator 规划已完成，等待确认范围")) };
      setGeneratedOutline(outline); await persist(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (taskRef.current) await mutate(current => ({ ...current, status: "failed", error: message, updatedAt: new Date().toISOString() })).catch(() => undefined); else onLockChange(false);
      notify(message);
    } finally { setBusy(false); }
  };
  const createJobs = async (current: LongWritingTaskRecord, markdown: string, ids: string[]) => {
    const currentTargets = parseHeadingTargets(markdown); const jobs: ChapterJob[] = [];
    for (const headingId of normalizeSelectedHeadingIds(markdown, ids)) {
      const target = currentTargets.find(value => value.id === headingId); if (!target) continue;
      jobs.push({ id: uid("heading-job"), taskId: current.id, chapterId: headingId, headingId, headingLevel: target.level, parentHeadingId: target.parentId, order: target.order, titlePath: target.titlePath, status: "queued", originalMarkdown: target.markdown, originalHash: await sha256Text(target.markdown), frozenHeadingSignature: "v2-heading-target", attempts: 0, maxAttempts: 3 });
    }
    if (!jobs.length) throw new Error("确认后的目录中没有可执行标题范围"); return jobs;
  };
  const confirmAndRun = async () => {
    const current = taskRef.current; if (!current) return; setBusy(true);
    try {
      let snapshot = await readTextFileSnapshot(current.filePath); let ids = current.selectedHeadingIds ?? [];
      if (current.mode === "create") {
        const skeleton = `# ${current.documentTitle}\n\n${generatedOutline.trim()}\n`;
        if (!parseHeadingTargets(skeleton).length) throw new Error("目录至少需要一个 H2-H6 标题");
        const write = await writeTextFileChecked(current.filePath, skeleton, snapshot.sha256); if (write.outcome !== "saved") throw new Error("应用新目录时文件已被外部修改");
        snapshot = write.snapshot; ids = parseHeadingTargets(skeleton).filter(target => target.level === 2).map(target => target.id); await onDocumentSnapshot(snapshot);
      }
      const jobs = await createJobs(current, snapshot.content, ids);
      const next: LongWritingTaskRecord = { ...current, status: "running", selectedHeadingIds: jobs.map(job => job.headingId!), selectedChapterIds: jobs.map(job => job.headingId!), chapters: jobs, currentDocumentHash: snapshot.sha256, generatedOutlineMarkdown: current.mode === "create" ? generatedOutline : undefined, events: appendLongWritingEvent(current.events, createLongWritingEvent("outline_confirmed", `已冻结目录并创建 ${jobs.length} 个标题子任务`)), updatedAt: new Date().toISOString() };
      await persist(next, true); await runJobs(next);
    } catch (error) { notify(error instanceof Error ? error.message : "确认目录失败"); } finally { setBusy(false); }
  };

  const runJobs = async (input?: LongWritingTaskRecord, onlyHeadingId?: string) => {
    const current = input ?? taskRef.current; if (!current?.mainSessionId || !current.modelRef) return;
    setBusy(true); stopRequested.current = false; onLockChange(true);
    try {
      await ensureServer();
      const candidates = current.chapters.filter(job => (!onlyHeadingId || job.headingId === onlyHeadingId) && job.status !== "completed" && job.status !== "awaiting_review");
      await mutate(value => ({ ...value, status: "running", error: undefined, chapters: value.chapters.map(job => candidates.some(candidate => candidate.id === job.id) ? { ...job, status: job.analysis ? "awaiting_write" : "queued", error: undefined } : job), events: appendLongWritingEvent(value.events, createLongWritingEvent("resumed", `开始 ${candidates.length} 个子任务：并行分析 ${value.concurrency}，串行写入 1`)), updatedAt: new Date().toISOString() }));
      await mapConcurrent(candidates.filter(job => !job.analysis), current.concurrency, async seed => {
        if (stopRequested.current) return;
        let job = taskRef.current!.chapters.find(value => value.id === seed.id)!; let sessionId = job.sessionId;
        if (!sessionId) {
          sessionId = await createOpenCodeSession({ directory: current.workspaceRoot, title: `标题任务：${job.titlePath.join(" / ")}`, parentId: current.mainSessionId, model: current.modelRef!, filePath: current.filePath });
          activeSessions.current.add(sessionId);
        }
        await patchJob(job.id, { status: "analyzing", sessionId, startedAt: new Date().toISOString(), attempts: job.attempts + 1 });
        const snapshot = await readTextFileSnapshot(current.filePath); const target = getHeadingTargetById(snapshot.content, job.headingId ?? job.chapterId);
        if (!target) throw new Error(`标题范围已不存在：${job.titlePath.join(" / ")}`);
        const result = await promptOpenCodeSession({ directory: current.workspaceRoot, sessionId, phase: "analysis", system: ANALYSIS_SYSTEM, text: `正式文件：${current.filePath}\n目标：${target.titlePath.join(" / ")}（H${target.level}）\n总指令：${current.instruction}\n\n当前目标子树：\n${target.markdown}\n\n引用资料：\n${boundedReferences(current.sourceRefs, target)}` });
        await patchJob(job.id, { status: "awaiting_write", analysis: result.text || "按总指令优化目标子树" });
        await appendEvent("analysis_completed", `分析完成：${job.titlePath.join(" / ")}`, job.headingId);
      });
      for (const seed of candidates) {
        if (stopRequested.current) break;
        const job = taskRef.current!.chapters.find(value => value.id === seed.id)!;
        if (job.status === "completed") continue; if (!job.sessionId) throw new Error(`子任务缺少 session：${job.titlePath.join(" / ")}`);
        const before = await readTextFileSnapshot(current.filePath); const beforeTarget = getHeadingTargetById(before.content, job.headingId ?? job.chapterId);
        if (!beforeTarget) throw new Error(`写入前标题范围已不存在：${job.titlePath.join(" / ")}`);
        await patchJob(job.id, { status: "writing", preEditDocumentMarkdown: before.content, preEditDocumentHash: before.sha256, originalMarkdown: beforeTarget.markdown, originalHash: await sha256Text(beforeTarget.markdown) });
        await appendEvent("commit_started", `获得写锁：${job.titlePath.join(" / ")}`, job.headingId);
        await promptOpenCodeSession({ directory: current.workspaceRoot, sessionId: job.sessionId, phase: "write", system: WRITING_SYSTEM, text: `正式文件绝对路径：${current.filePath}\n唯一允许修改的目标：${beforeTarget.titlePath.join(" / ")}（H${beforeTarget.level}，ID ${beforeTarget.id}）\n总指令：${current.instruction}\n\n已完成的分析计划：\n${job.analysis}\n\n允许使用的引用资料：\n${boundedReferences(current.sourceRefs, beforeTarget)}\n\n现在重新读取正式文件，只编辑该目标子树。` });
        const after = await readTextFileSnapshot(current.filePath);
        if (after.sha256 === before.sha256) { await patchJob(job.id, { status: "retryable", error: "OpenCode 未修改正式文件" }); continue; }
        const validation = validateHeadingTargetEdit(before.content, after.content, beforeTarget.id);
        if (!validation.valid) {
          const rollback = await writeTextFileChecked(current.filePath, before.content, after.sha256);
          if (rollback.outcome !== "saved") {
            await mutate(value => ({ ...value, status: "conflict", error: `OpenCode 越界修改且回滚时检测到外部变化：${validation.reason}`, updatedAt: new Date().toISOString() }));
            throw new Error("检测到越界修改和外部文件冲突，未覆盖磁盘版本");
          }
          const reason = `OpenCode 修改超出目标范围，已回滚：${validation.reason}`;
          await onDocumentSnapshot(rollback.snapshot);
          await patchJob(job.id, {
            status: "awaiting_review",
            error: reason,
            scopeReview: {
              reason: validation.reason,
              proposedDocumentMarkdown: after.content,
              proposedDocumentHash: after.sha256,
              rollbackDocumentHash: rollback.snapshot.sha256,
              createdAt: new Date().toISOString(),
            },
          });
          await appendEvent("scope_review_requested", `越界修改已回滚并等待确认：${job.titlePath.join(" / ")}`, job.headingId); break;
        }
        const draft: ChapterDraftResult = { chapterId: beforeTarget.id, markdown: validation.after.markdown, summary: job.analysis ?? "OpenCode 已完成目标子树编辑", factsUsed: [], terminologyUsed: [], openQuestions: [] };
        await onDocumentSnapshot(after);
        await patchJob(job.id, { status: "completed", draft, summary: draft.summary, postEditDocumentHash: after.sha256, committedChapterHash: await sha256Text(validation.after.markdown), completedAt: new Date().toISOString(), error: undefined });
        await appendEvent("commit_completed", `已校验并保留：${job.titlePath.join(" / ")}`, job.headingId);
      }
      if (stopRequested.current) return;
      const remaining = taskRef.current!.chapters.filter(job => job.status !== "completed");
      const reviews = remaining.filter(job => job.status === "awaiting_review").length;
      if (remaining.length) { await mutate(value => ({ ...value, status: "paused", error: reviews ? `${reviews} 个越界修改等待确认，队列已暂停` : `${remaining.length} 个标题任务等待重试`, updatedAt: new Date().toISOString() })); return; }
      await mutate(value => ({ ...value, status: "checking", updatedAt: new Date().toISOString(), events: appendLongWritingEvent(value.events, createLongWritingEvent("consistency_started", "Coordinator 开始全篇一致性检查")) }));
      const finalSnapshot = await readTextFileSnapshot(current.filePath);
      const consistency = await promptOpenCodeSession({ directory: current.workspaceRoot, sessionId: current.mainSessionId, phase: "analysis", system: "你是构案长任务 Coordinator。只读当前正式方案，检查术语、事实、重复、缺失、衔接和 Markdown 结构；不得编辑文件、运行命令或联网。", text: `正式文件：${current.filePath}\n总指令：${current.instruction}\n请读取最终方案并给出简洁一致性检查报告。` });
      await mutate(value => ({ ...value, status: "completed", currentDocumentHash: finalSnapshot.sha256, mainAnalysis: `${value.mainAnalysis ?? ""}\n\n## 最终一致性检查\n${consistency.text}`.trim(), completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: appendLongWritingEvent(value.events, createLongWritingEvent("consistency_completed", "OpenCode 一致性检查完成")) }));
      onLockChange(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await mutate(value => ({ ...value, status: value.status === "conflict" ? "conflict" : "failed", error: message, updatedAt: new Date().toISOString() })).catch(() => undefined); notify(message);
    } finally { setBusy(false); }
  };
  const decideScopeReview = async (jobId: string, decision: "accepted" | "rejected") => {
    const current = taskRef.current; const job = current?.chapters.find(value => value.id === jobId); const review = job?.scopeReview;
    if (!current || !job || !review || review.decision) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      if (decision === "rejected") {
        await mutate(value => ({
          ...value,
          status: "paused",
          error: undefined,
          chapters: value.chapters.map(valueJob => valueJob.id === jobId ? {
            ...valueJob,
            status: "retryable",
            error: "用户已拒绝越界修改，可重新执行本章",
            scopeReview: { ...review, decision, decidedAt: now },
          } : valueJob),
          events: appendLongWritingEvent(value.events, createLongWritingEvent("scope_review_rejected", `已拒绝越界修改：${job.titlePath.join(" / ")}`, { chapterId: job.headingId })),
          updatedAt: now,
        }), [jobId]);
        return;
      }
      const write = await writeTextFileChecked(current.filePath, review.proposedDocumentMarkdown, review.rollbackDocumentHash);
      if (write.outcome !== "saved") {
        await mutate(value => ({ ...value, status: "conflict", error: "确认越界修改时检测到外部文件变化，未覆盖磁盘版本", updatedAt: now }));
        return;
      }
      const acceptedTarget = getHeadingTargetById(write.snapshot.content, job.headingId ?? job.chapterId);
      const acceptedMarkdown = acceptedTarget?.markdown ?? review.proposedDocumentMarkdown;
      const acceptedHash = await sha256Text(acceptedMarkdown);
      const draft: ChapterDraftResult = {
        chapterId: job.headingId ?? job.chapterId,
        markdown: acceptedMarkdown,
        summary: job.analysis ?? "用户已确认 OpenCode 的越界修改",
        factsUsed: [],
        terminologyUsed: [],
        openQuestions: [],
      };
      await onDocumentSnapshot(write.snapshot);
      await mutate(value => ({
        ...value,
        status: "paused",
        error: undefined,
        currentDocumentHash: write.snapshot.sha256,
        chapters: value.chapters.map(valueJob => valueJob.id === jobId ? {
          ...valueJob,
          status: "completed",
          draft,
          summary: draft.summary,
          postEditDocumentHash: write.snapshot.sha256,
          committedChapterHash: acceptedHash,
          completedAt: now,
          error: undefined,
          scopeReview: { ...review, decision, decidedAt: now },
        } : valueJob),
        events: appendLongWritingEvent(value.events, createLongWritingEvent("scope_review_accepted", `已确认并应用越界修改：${job.titlePath.join(" / ")}`, { chapterId: job.headingId })),
        updatedAt: now,
      }), [jobId]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "处理越界修改失败");
    } finally {
      setBusy(false);
    }
  };
  const stopTask = async (cancel = false) => {
    stopRequested.current = true; const current = taskRef.current; if (!current) return;
    await Promise.all([...activeSessions.current].map(sessionId => abortOpenCodeSession(current.workspaceRoot, sessionId).catch(() => false)));
    await mutate(value => ({ ...value, status: cancel ? "cancelled" : "paused", events: appendLongWritingEvent(value.events, createLongWritingEvent(cancel ? "cancelled" : "paused", cancel ? "用户已终止长任务" : "用户已暂停长任务")), updatedAt: new Date().toISOString() }));
    setBusy(false); if (cancel) onLockChange(false);
  };
  const restoreOriginal = async () => {
    const current = taskRef.current; if (!current || !confirm("恢复任务前原文会撤销本次长任务的全部修改，是否继续？")) return;
    await stopTask(false); const disk = await readTextFileSnapshot(current.filePath);
    const restored = await restoreProposalBackup({ workspaceRoot: current.workspaceRoot, filePath: current.filePath, backupPath: current.initialBackup.path, expectedDocumentHash: disk.sha256, taskId: current.id });
    const snapshot: TextFileSnapshot = { path: restored.filePath, content: restored.content, sha256: restored.sha256, updatedAt: new Date().toISOString() };
    await onDocumentSnapshot(snapshot); await mutate(value => ({ ...value, status: "restored", currentDocumentHash: restored.sha256, updatedAt: new Date().toISOString() })); onLockChange(false);
  };
  const stopServer = async () => {
    if (task && ACTIVE_TASKS.has(task.status) && !confirm("停止 OpenCode Server 会暂停当前长任务，是否继续？")) return;
    if (task && ACTIVE_TASKS.has(task.status)) await stopTask(false);
    setServerStatus(await stopOpenCodeServer()); setModels([]); setModelRef(null);
  };
  const hasSelectedAncestor = (target: ParsedHeadingTarget) => {
    let parentId = target.parentId; while (parentId) { if (selected.has(parentId)) return true; parentId = targetById.get(parentId)?.parentId; } return false;
  };
  const toggleTarget = (target: ParsedHeadingTarget) => setSelected(current => {
    const next = new Set(current);
    if (next.has(target.id)) next.delete(target.id); else {
      next.add(target.id);
      for (const candidate of targets) { let parentId = candidate.parentId; while (parentId) { if (parentId === target.id) { next.delete(candidate.id); break; } parentId = targetById.get(parentId)?.parentId; } }
    }
    return next;
  });

  const renderTree = (nodes: HeadingTargetTreeNode[]): React.ReactNode => nodes.map(node => {
    const inherited = hasSelectedAncestor(node.target); const checked = inherited || selected.has(node.target.id);
    const partial = !checked && targets.some(candidate => selected.has(candidate.id) && candidate.titlePath.slice(0, node.target.titlePath.length).join("\0") === node.target.titlePath.join("\0"));
    const isCollapsed = collapsed.has(node.target.id);
    return <div className="long-writing-tree-node" key={node.target.id}>
      <div className={`long-writing-tree-row ${inherited ? "is-inherited" : ""}`} style={{ paddingLeft: `${Math.max(0, node.target.level - 2) * 14}px` }}>
        <button type="button" className="long-writing-tree-toggle" disabled={!node.children.length} onClick={() => setCollapsed(value => { const next = new Set(value); next.has(node.target.id) ? next.delete(node.target.id) : next.add(node.target.id); return next; })} title={isCollapsed ? "展开" : "折叠"}>{node.children.length ? isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} /> : <span />}</button>
        <input type="checkbox" checked={checked} disabled={inherited} ref={element => { if (element) element.indeterminate = partial; }} onChange={() => toggleTarget(node.target)} />
        <span title={node.target.titlePath.join(" / ")}><small>H{node.target.level}</small>{node.target.title}</span><em>{node.target.bodyMarkdown.replace(/\s/g, "").length} 字</em>
      </div>{(!isCollapsed || headingSearch.trim()) && node.children.length > 0 && renderTree(node.children)}
    </div>;
  });
  if (availability && !task) return <div className="long-writing-empty" data-reason={availability.issue}><WandSparkles size={24} /><b>{availability.title}</b><span>{availability.description}</span></div>;
  const serverBar = <div className={`opencode-server-bar status-${serverStatus.phase}`}>
    <span className="opencode-server-state"><Server size={14} /><i /><b>{serverLabel(serverStatus)}</b></span>
    <small>{serverStatus.version ? `v${serverStatus.version}` : "OpenCode"}{serverStatus.port ? ` · :${serverStatus.port}` : ""}{serverStatus.activeSessions ? ` · ${serverStatus.activeSessions} sessions` : ""}</small>
    <button type="button" onClick={() => void refreshServer()} title="重新检测"><RefreshCw size={13} /></button>
    {serverStatus.phase === "healthy" ? <button type="button" onClick={() => void stopServer()} title="停止 OpenCode Server"><Square size={12} /></button> : <button type="button" disabled={serverStatus.phase === "starting"} onClick={() => void ensureServer().catch(error => notify(error instanceof Error ? error.message : "启动失败"))} title="启动 OpenCode Server"><Power size={13} /></button>}
  </div>;
  if (!task) return <div className="long-writing-panel">
    {serverBar}
    <div className="long-writing-intro"><WandSparkles size={18} /><div><b>OpenCode 长任务</b><span>Coordinator 与标题子任务统一使用本地 HTTP API；并行分析，串行写入。</span></div></div>
    <label>任务模式<select value={mode} onChange={event => setMode(event.target.value as LongWritingMode)}><option value="fill">补写空白/短范围</option><option value="rewrite">改写所选范围</option><option value="targeted">按指令定向修改</option><option value="create">从零创建完整方案</option></select></label>
    {mode === "create" && <label>方案标题<input value={documentTitle} onChange={event => setDocumentTitle(event.target.value)} /></label>}
    <label>总指令<textarea rows={5} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="说明目标、必须保留的事实、写作风格和边界…" /></label>
    <label>OpenCode 模型<OpenCodeModelSelect models={models} value={modelRef} onChange={setModelRef} disabled={serverStatus.phase !== "healthy"} placeholder={serverStatus.phase === "healthy" ? "请选择已连接模型" : "请先启动 OpenCode Server"} /></label>
    {mode !== "create" && <section className="long-writing-section"><div className="long-writing-section-title"><b>章节范围</b><span>{normalizeSelectedHeadingIds(project.markdown, selected).length} 个有效任务</span></div><div className="long-writing-tree-toolbar"><div className="long-writing-tree-search"><Search size={12} /><input type="search" value={headingSearch} onChange={event => setHeadingSearch(event.target.value)} placeholder="搜索标题或路径" aria-label="搜索章节范围" /></div><button type="button" onClick={() => setSelected(new Set(selectAllHeadingTargetIds(targetTree)))} title="全选" aria-label="全选章节"><CheckCheck size={13} /></button><button type="button" onClick={() => setSelected(new Set())} title="取消全选" aria-label="取消全选章节"><X size={13} /></button><button type="button" onClick={() => setCollapsed(new Set())} title="全部展开" aria-label="全部展开章节"><ChevronsDown size={13} /></button><button type="button" onClick={() => setCollapsed(new Set(collectCollapsibleHeadingIds(targetTree)))} title="全部收起" aria-label="全部收起章节"><ChevronsUp size={13} /></button></div><div className="long-writing-tree">{renderTree(visibleTargetTree)}{headingSearch.trim() && !visibleTargetTree.length && <div className="long-writing-tree-empty">没有匹配的标题</div>}</div></section>}
    <ContextReferences labels={referencedSources.map(source => source.title)} footer={<button type="button" onClick={onManageReferences}><BookOpen size={13} />管理引用资料</button>} />
    <label>并行分析<select value={concurrency} onChange={event => setConcurrency(Number(event.target.value) as 1 | 2 | 3)}><option value={1}>1</option><option value={2}>2（默认）</option><option value={3}>3</option></select></label>
    <button className="long-writing-primary" disabled={busy || !modelRef || serverStatus.phase !== "healthy"} onClick={() => void startPlanning()}>{busy ? "Coordinator 正在规划…" : "生成计划"}</button>
  </div>;
  const completed = task.chapters.filter(job => job.status === "completed").length; const progress = task.chapters.length ? Math.round(completed / task.chapters.length * 100) : 0;
  const detailJob = detailTarget?.jobId ? task.chapters.find(job => job.id === detailTarget.jobId) : undefined;
  const detailSessionId = detailTarget ? detailJob?.sessionId ?? (!detailTarget.jobId ? task.mainSessionId : undefined) : undefined;
  return <div className="long-writing-panel">
    {serverBar}
    <div className={`long-writing-task-head status-${task.status}`}><div><b>{task.status === "awaiting_outline" ? "计划待确认" : `OpenCode 长任务：${task.status}`}</b><span>{task.modelProviderId} / {task.model} · 并行分析 {task.concurrency} · 串行写入</span></div><em>{progress}%</em></div>
    <div className="long-writing-progress"><i style={{ width: `${progress}%` }} /></div>
    {task.error && <div className="long-writing-warning"><AlertTriangle size={14} />{task.error}</div>}
    <LongWritingEventLog events={task.events ?? []} busy={busy} />
    {task.status === "awaiting_outline" && <><section className="long-writing-plan-review"><b>Coordinator 计划</b><pre>{task.mainAnalysis}</pre></section>{task.mode === "create" && <label>目录 Markdown<textarea rows={12} value={generatedOutline} onChange={event => setGeneratedOutline(event.target.value)} /></label>}<button className="long-writing-primary" disabled={busy} onClick={() => void confirmAndRun()}><CirclePlay size={14} />确认范围并运行</button><button disabled={busy} onClick={() => void restoreOriginal()}><RotateCcw size={14} />取消并恢复原文</button></>}
    <div className="long-writing-jobs">
      <LongWritingCoordinatorCard task={task} onOpen={() => setDetailTarget({})} />
      {task.status !== "awaiting_outline" && task.chapters.map(job => <LongWritingJobCard key={job.id} job={job} filePath={task.filePath} workspaceRoot={task.workspaceRoot} onOpen={() => setDetailTarget({ jobId: job.id })} onLocate={() => onLocateChapter(job.titlePath)} onRetry={() => void runJobs(undefined, job.headingId ?? job.chapterId)} />)}
    </div>
    {detailTarget && <LongWritingDetailModal task={task} job={detailJob} busy={busy} close={() => setDetailTarget(null)} onLocate={detailJob ? () => onLocateChapter(detailJob.titlePath) : undefined} onRetry={detailJob ? () => void runJobs(undefined, detailJob.headingId ?? detailJob.chapterId) : undefined} onAcceptScopeReview={detailJob ? () => void decideScopeReview(detailJob.id, "accepted") : undefined} onRejectScopeReview={detailJob ? () => void decideScopeReview(detailJob.id, "rejected") : undefined} activitySignal={detailSessionId ? sessionActivities[detailSessionId]?.at(-1)?.id : undefined} />}
    {busy && <div className="long-writing-actions"><button onClick={() => void stopTask(false)}><CirclePause size={14} />暂停</button><button onClick={() => void stopTask(true)}><Square size={13} />终止</button></div>}
    {!busy && ["paused", "failed"].includes(task.status) && <div className="long-writing-actions"><button onClick={() => void runJobs()}><CirclePlay size={14} />继续未完成任务</button><button onClick={() => void stopTask(true)}><Square size={13} />终止</button></div>}
    {task.status !== "restored" && <button className="long-writing-restore" disabled={busy} onClick={() => void restoreOriginal()}><RotateCcw size={14} />恢复任务前原文</button>}
    {["completed", "cancelled", "restored"].includes(task.status) && <button onClick={() => { setTaskBoth(null); setGeneratedOutline(""); onLockChange(false); }}>新建长任务</button>}
  </div>;
}
