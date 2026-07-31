import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Clock3,
  FileText,
  GitCompareArrows,
  ListChecks,
  LoaderCircle,
  LocateFixed,
  RotateCcw,
} from "lucide-react";
import { MarkdownDiffPane } from "../../components/MarkdownDiffPane";
import { buildTextDiff } from "../../components/textDiff";
import { MarkdownPreview } from "../editor/MarkdownEditor";
import type { ChapterJob, ChapterJobStatus, LongWritingEvent } from "./types";

const STATUS_LABELS: Record<ChapterJobStatus, string> = {
  queued: "排队",
  running: "生成",
  validating: "校验",
  committing: "写入",
  completed: "完成",
  retryable: "等待重试",
  failed: "失败",
  cancelled: "已停止",
};

const EVENT_LABELS: Partial<Record<LongWritingEvent["type"], string>> = {
  task_started: "任务",
  backup_created: "备份",
  summary_started: "摘要",
  summary_completed: "摘要",
  outline_started: "目录",
  outline_completed: "目录",
  outline_confirmed: "冻结",
  worker_started: "Worker",
  worker_retry: "重试",
  draft_received: "返回",
  validation_passed: "校验",
  commit_started: "写入",
  commit_completed: "完成",
  consistency_started: "检查",
  consistency_completed: "检查",
  conflict_detected: "冲突",
  paused: "暂停",
  resumed: "继续",
  failed: "失败",
  cancelled: "停止",
  restored: "恢复",
};

function formatEventTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusDescription(status: ChapterJobStatus) {
  return ({
    queued: "等待 Coordinator 分配空闲 Worker。",
    running: "Worker 正在生成结构化章节草稿，返回后才会显示正文。",
    validating: "草稿已返回，正在检查冻结标题树与 Markdown 结构。",
    committing: "校验通过，正在通过串行写队列原子提交到磁盘。",
    completed: "章节已安全写入，可以查看最终输出与前后差异。",
    retryable: "遇到临时错误，等待退避后重试或手动重试。",
    failed: "本章未写入磁盘，可查看错误并单章重试。",
    cancelled: "本章请求已停止，已完成章节不受影响。",
  } satisfies Record<ChapterJobStatus, string>)[status];
}

function statusIcon(job: ChapterJob) {
  if (job.status === "completed") return <CheckCircle2 size={15} />;
  if (job.status === "failed" || job.status === "retryable") return <AlertTriangle size={15} />;
  if (["running", "validating", "committing"].includes(job.status)) return <LoaderCircle className="long-writing-spin" size={15} />;
  return <i className="job-dot" />;
}

function countNonWhitespace(value: string) {
  return value.replace(/\s/g, "").length;
}

export function LongWritingJobCard({
  job,
  filePath,
  workspaceRoot,
  onRetry,
  onLocate,
}: {
  job: ChapterJob;
  filePath: string;
  workspaceRoot: string;
  onRetry: () => void;
  onLocate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"output" | "diff" | "details">("output");
  const [copied, setCopied] = useState(false);
  const draft = job.draft;
  const diff = useMemo(() => draft ? buildTextDiff(job.originalMarkdown, draft.markdown) : null, [draft, job.originalMarkdown]);
  const beforeCount = countNonWhitespace(job.originalMarkdown);
  const afterCount = draft ? countNonWhitespace(draft.markdown) : null;
  const shownRows = diff?.rows.slice(0, 300) ?? [];
  const visibleDiff = diff ? { ...diff, rows: shownRows } : null;

  const copyDraft = async () => {
    if (!draft) return;
    await navigator.clipboard?.writeText(draft.markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return <article className={`long-writing-job-card status-${job.status} ${expanded ? "is-expanded" : ""}`}>
    <button type="button" className="long-writing-job-summary" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
      <span className="long-writing-job-state">{statusIcon(job)}</span>
      <span className="long-writing-job-heading">
        <b>{job.titlePath.join(" / ")}</b>
        <small>
          {job.attempts ? `第 ${job.attempts} 次尝试` : "尚未调用模型"}
          {afterCount !== null ? ` · ${beforeCount.toLocaleString()} → ${afterCount.toLocaleString()} 字` : ""}
        </small>
      </span>
      <em>{STATUS_LABELS[job.status]}</em>
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
    {expanded && <div className="long-writing-job-body">
      <div className="long-writing-job-toolbar">
        <div className="long-writing-output-tabs" role="tablist" aria-label="章节实施输出">
          <button type="button" className={tab === "output" ? "active" : ""} onClick={() => setTab("output")}><FileText size={12} />输出</button>
          <button type="button" className={tab === "diff" ? "active" : ""} disabled={!draft} onClick={() => setTab("diff")}><GitCompareArrows size={12} />对比</button>
          <button type="button" className={tab === "details" ? "active" : ""} disabled={!draft && !job.error} onClick={() => setTab("details")}><ListChecks size={12} />详情</button>
        </div>
        <div className="long-writing-job-tools">
          <button type="button" title="在编辑器中定位" onClick={onLocate}><LocateFixed size={13} /></button>
          <button type="button" title="复制章节输出" disabled={!draft} onClick={() => void copyDraft()}>{copied ? <Check size={13} /> : <Clipboard size={13} />}</button>
          {(["failed", "retryable", "cancelled"] as ChapterJobStatus[]).includes(job.status) && <button type="button" title="重试本章" onClick={onRetry}><RotateCcw size={13} /></button>}
        </div>
      </div>

      {job.error && <div className="long-writing-job-error"><AlertTriangle size={13} /><span>{job.error}</span></div>}

      {tab === "output" && (draft
        ? <div className="long-writing-output-preview"><MarkdownPreview markdown={draft.markdown} filePath={filePath} workspaceRoot={workspaceRoot} /></div>
        : <div className="long-writing-stage-empty"><LoaderCircle className={(["running", "validating", "committing"] as ChapterJobStatus[]).includes(job.status) ? "long-writing-spin" : ""} size={18} /><b>{STATUS_LABELS[job.status]}</b><span>{statusDescription(job.status)}</span></div>)}

      {tab === "diff" && visibleDiff && <div className="long-writing-diff">
        <div className="long-writing-diff-stats"><span className="deleted">-{visibleDiff.deletedLines} 行</span><span className="added">+{visibleDiff.addedLines} 行</span>{diff && diff.rows.length > shownRows.length && <small>仅展示前 {shownRows.length} 行差异</small>}</div>
        <section className="original"><header>原文</header><div><MarkdownDiffPane diff={visibleDiff} side="original" /></div></section>
        <section className="revised"><header>AI 稿</header><div><MarkdownDiffPane diff={visibleDiff} side="revised" /></div></section>
      </div>}

      {tab === "details" && <div className="long-writing-output-details">
        {draft && <>
          <section><b>章节摘要</b><p>{draft.summary || "未返回摘要"}</p></section>
          <section><b>使用事实</b>{draft.factsUsed.length ? <ul>{draft.factsUsed.map((fact, index) => <li key={`${fact}-${index}`}>{fact}</li>)}</ul> : <p>未声明额外事实</p>}</section>
          <section><b>术语</b>{draft.terminologyUsed.length ? <dl>{draft.terminologyUsed.map((entry, index) => <div key={`${entry.term}-${index}`}><dt>{entry.term}</dt><dd>{entry.definition}</dd></div>)}</dl> : <p>未声明术语</p>}</section>
          <section><b>待确认项</b>{draft.openQuestions.length ? <ul>{draft.openQuestions.map((question, index) => <li key={`${question}-${index}`}>{question}</li>)}</ul> : <p>无待确认项</p>}</section>
        </>}
        <section className="long-writing-technical-details"><b>执行信息</b><p>状态：{STATUS_LABELS[job.status]} · 尝试：{job.attempts}/{job.maxAttempts}</p>{job.completedAt && <p>完成：{new Date(job.completedAt).toLocaleString("zh-CN", { hour12: false })}</p>}</section>
      </div>}
    </div>}
  </article>;
}

export function LongWritingEventLog({ events, busy }: { events: LongWritingEvent[]; busy: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const visible = events.slice(-80).reverse();
  return <section className={`long-writing-event-log ${expanded ? "is-expanded" : ""}`}>
    <button type="button" className="long-writing-event-head" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
      <span><Clock3 size={14} /><b>执行动态</b>{busy && <i className="long-writing-live-dot" />}</span>
      <em>{events.length} 条</em>
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
    {expanded && <>
      <div className="long-writing-event-list" aria-live="polite">
        {visible.length ? visible.map(event => <div className={`long-writing-event event-${event.type}`} key={event.id}>
          <time>{formatEventTime(event.at)}</time>
          <i />
          <span><b>{EVENT_LABELS[event.type] ?? "系统"}</b>{event.message}{event.attempt ? <small>第 {event.attempt} 次</small> : null}</span>
        </div>) : <div className="long-writing-event-empty">任务启动后将在这里显示备份、生成、校验、重试和写入进度。</div>}
      </div>
      <p className="long-writing-event-note">仅展示可核验的系统阶段与 Worker 最终产物，不展示模型内部推理。</p>
    </>}
  </section>;
}
