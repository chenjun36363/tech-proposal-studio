import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  FileText,
  GitCompareArrows,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
  User,
  Wrench,
  X,
} from "lucide-react";
import { MarkdownDiffPane } from "../../components/MarkdownDiffPane";
import { buildTextDiff } from "../../components/textDiff";
import { MarkdownPreview } from "../editor/MarkdownEditor";
import { formatConversationValue, normalizeOpenCodeConversation, type OpenCodeConversationMessage, type OpenCodeConversationPart } from "./openCodeConversation";
import { getOpenCodeSessionMessages } from "./opencodeService";
import type { ChapterJob, ChapterJobStatus, LongWritingTaskRecord } from "./types";

const STATUS_LABELS: Record<ChapterJobStatus, string> = {
  queued: "排队", analyzing: "分析", awaiting_write: "待写入", writing: "写入", running: "生成",
  validating: "校验", committing: "写入", completed: "完成", awaiting_review: "待确认", retryable: "等待重试",
  failed: "失败", cancelled: "已停止",
};

type DetailTab = "plan" | "review" | "output" | "diff" | "details" | "session";

function formatTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { hour12: false });
}

function roleLabel(role: string) {
  if (role === "user") return "构案输入";
  if (role === "assistant") return "OpenCode";
  if (role === "system") return "系统";
  return "消息";
}

function PartValue({ title, value }: { title: string; value: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = formatConversationValue(value);
  if (!text) return null;
  return <details className="opencode-conversation-value">
    <summary>{title}<button type="button" title={`复制${title}`} onClick={event => { event.preventDefault(); event.stopPropagation(); void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }); }}>{copied ? <Check size={12} /> : <Clipboard size={12} />}</button></summary>
    <pre>{text}</pre>
  </details>;
}

function ConversationPart({ part }: { part: OpenCodeConversationPart }) {
  if (part.kind === "text") {
    if (!part.text?.trim()) return null;
    return <div className={`opencode-conversation-text type-${part.rawType ?? "text"}`}><pre>{part.text}</pre></div>;
  }
  if (part.kind === "tool") return <section className={`opencode-conversation-tool status-${part.status ?? "unknown"}`}>
    <header><Wrench size={14} /><b>{part.tool}</b><em>{part.status ?? "unknown"}</em></header>
    <PartValue title="输入参数" value={part.input} />
    <PartValue title="执行结果" value={part.output} />
    {part.error && <div className="opencode-conversation-error"><AlertTriangle size={13} />{part.error}</div>}
  </section>;
  if (part.kind === "error") return <div className="opencode-conversation-error"><AlertTriangle size={13} />{part.error}</div>;
  return <details className="opencode-conversation-unknown"><summary>未识别内容：{part.rawType ?? "unknown"}</summary>{part.text && <pre>{part.text}</pre>}</details>;
}
export function OpenCodeConversationMessageCard({ message, expanded, onToggle }: {
  message: OpenCodeConversationMessage;
  expanded: boolean;
  onToggle: () => void;
}) {
  return <article className={`opencode-conversation-message role-${message.role} ${expanded ? "is-expanded" : "is-collapsed"}`}>
    <header>
      <span>{message.role === "user" ? <User size={15} /> : <Bot size={15} />}<b>{roleLabel(message.role)}</b></span>
      <div className="opencode-conversation-message-meta">
        <small>{message.model}{message.createdAt ? ` · ${formatTime(message.createdAt)}` : ""}</small>
        <button type="button" className="opencode-conversation-toggle" aria-expanded={expanded} aria-label={expanded ? "收起消息" : "展开消息"} title={expanded ? "收起消息" : "展开消息"} onClick={onToggle}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
      </div>
    </header>
    {expanded && <div className="opencode-conversation-message-body">
      {message.error && <div className="opencode-conversation-error"><AlertTriangle size={13} />{message.error}</div>}
      <div className="opencode-conversation-parts">{message.parts.map(part => <ConversationPart part={part} key={part.id} />)}</div>
    </div>}
  </article>;
}

function ConversationView({ directory, sessionId, activitySignal, active }: {
  directory: string;
  sessionId?: string;
  activitySignal?: string;
  active: boolean;
}) {
  const [messages, setMessages] = useState<ReturnType<typeof normalizeOpenCodeConversation>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [collapsedMessageIds, setCollapsedMessageIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!sessionId) return;
    let current = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void getOpenCodeSessionMessages(directory, sessionId).then(value => {
        if (!current) return;
        setMessages(normalizeOpenCodeConversation(value));
        setError("");
      }).catch(reason => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      }).finally(() => {
        if (current) setLoading(false);
      });
    }, activitySignal && active ? 350 : 0);
    return () => { current = false; window.clearTimeout(timer); };
  }, [directory, sessionId, revision, activitySignal, active]);

  if (!sessionId) return <div className="opencode-conversation-empty"><MessageSquareText size={24} /><b>尚未创建会话</b><span>OpenCode session 创建后即可查看输入和执行内容。</span></div>;
  const allCollapsed = messages.length > 0 && messages.every(message => collapsedMessageIds.has(message.id));
  const toggleAllMessages = () => setCollapsedMessageIds(allCollapsed
    ? new Set()
    : new Set(messages.map(message => message.id)));
  const toggleMessage = (messageId: string) => setCollapsedMessageIds(current => {
    const next = new Set(current);
    if (next.has(messageId)) next.delete(messageId);
    else next.add(messageId);
    return next;
  });

  return <div className="opencode-conversation">
    <div className="opencode-conversation-actions">
      <code>{sessionId}</code>
      <div>
        {!!messages.length && <button type="button" onClick={toggleAllMessages} title={allCollapsed ? "全部展开" : "全部收起"} aria-label={allCollapsed ? "全部展开" : "全部收起"}>{allCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button>}
        <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)} title="刷新会话" aria-label="刷新会话"><RefreshCw className={loading ? "long-writing-spin" : ""} size={14} /></button>
      </div>
    </div>
    {error && <div className="opencode-conversation-load-error"><AlertTriangle size={15} /><span><b>无法读取会话</b>{error}</span><button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
    {!error && loading && !messages.length && <div className="opencode-conversation-empty"><LoaderCircle className="long-writing-spin" size={24} /><b>正在读取会话</b></div>}
    {!error && !loading && !messages.length && <div className="opencode-conversation-empty"><MessageSquareText size={24} /><b>会话暂无可见消息</b><span>这里不会展示模型隐藏推理。</span></div>}
    <div className="opencode-conversation-messages" aria-live="polite">
      {messages.map(message => <OpenCodeConversationMessageCard key={message.id} message={message}
        expanded={!collapsedMessageIds.has(message.id)}
        onToggle={() => toggleMessage(message.id)}
      />)}
    </div>
  </div>;
}

export function LongWritingDetailModal({ task, job, busy = false, close, onLocate, onRetry, onAcceptScopeReview, onRejectScopeReview, activitySignal }: {
  task: LongWritingTaskRecord;
  job?: ChapterJob;
  busy?: boolean;
  close: () => void;
  onLocate?: () => void;
  onRetry?: () => void;
  onAcceptScopeReview?: () => void;
  onRejectScopeReview?: () => void;
  activitySignal?: string;
}) {
  const tabs: { id: DetailTab; label: string; icon: React.ReactNode; disabled?: boolean }[] = job
    ? [
      ...(job.scopeReview ? [{ id: "review" as const, label: "越界审核", icon: <AlertTriangle size={14} /> }] : []),
      { id: "output", label: "输出", icon: <FileText size={14} /> },
      { id: "diff", label: "对比", icon: <GitCompareArrows size={14} />, disabled: !job.draft },
      { id: "details", label: "详情", icon: <ListChecks size={14} /> },
      { id: "session", label: "会话", icon: <MessageSquareText size={14} />, disabled: !job.sessionId },
    ]
    : [
      { id: "plan", label: "计划", icon: <ListChecks size={14} /> },
      { id: "session", label: "会话", icon: <MessageSquareText size={14} />, disabled: !task.mainSessionId },
    ];
  const [tab, setTab] = useState<DetailTab>(job?.scopeReview && !job.scopeReview.decision ? "review" : job ? "output" : "plan");
  const draft = job?.draft;
  const diff = useMemo(() => job && draft ? buildTextDiff(job.originalMarkdown, draft.markdown) : null, [job, draft]);
  const visibleDiff = diff ? { ...diff, rows: diff.rows.slice(0, 500) } : null;
  const reviewDiff = useMemo(() => job?.scopeReview && job.preEditDocumentMarkdown ? buildTextDiff(job.preEditDocumentMarkdown, job.scopeReview.proposedDocumentMarkdown) : null, [job]);
  const visibleReviewDiff = reviewDiff ? { ...reviewDiff, rows: reviewDiff.rows.slice(0, 800) } : null;
  const active = job
    ? ["analyzing", "writing", "running", "validating", "committing"].includes(job.status)
    : ["preparing", "running", "checking"].includes(task.status);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return createPortal(<div className="modal-backdrop opencode-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal wide opencode-detail-modal" role="dialog" aria-modal="true" aria-labelledby="opencode-detail-title" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title">
        <div><MessageSquareText size={18} /><span><b id="opencode-detail-title">{job ? job.titlePath.join(" / ") : "Coordinator"}</b><small>{job ? `${STATUS_LABELS[job.status]} · 第 ${job.attempts} 次尝试` : `任务状态：${task.status}`}</small></span></div>
        <button type="button" className="icon-button" title="关闭" aria-label="关闭" onClick={close}><X size={18} /></button>
      </div>
      <div className="opencode-detail-tabs" role="tablist">
        {tabs.map(item => <button type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : ""} disabled={item.disabled} title={item.disabled && item.id === "session" ? "尚未创建会话" : undefined} onClick={() => setTab(item.id)} key={item.id}>{item.icon}{item.label}</button>)}
        {job && <div className="opencode-detail-tools">
          <button type="button" title="在编辑器中定位" onClick={onLocate}>定位章节</button>
          {(["failed", "retryable", "cancelled"] as ChapterJobStatus[]).includes(job.status) && <button type="button" onClick={onRetry}><RotateCcw size={13} />重试本章</button>}
        </div>}
      </div>
      <div className="opencode-detail-body">
        {tab === "plan" && <div className="opencode-coordinator-plan"><b>Coordinator 计划与检查结果</b><pre>{task.mainAnalysis || "Coordinator 尚未返回计划。"}</pre></div>}
        {tab === "review" && job?.scopeReview && <div className="opencode-scope-review">
          <div className="opencode-scope-review-warning"><AlertTriangle size={17} /><span><b>修改超出目标章节，正式文件已回滚</b><small>原因：{job.scopeReview.reason}。确认将应用 OpenCode 对整份文档的修改；拒绝则保持当前文件不变。</small></span></div>
          {visibleReviewDiff && <div className="long-writing-diff opencode-detail-diff">
            <div className="long-writing-diff-stats"><span className="deleted">-{visibleReviewDiff.deletedLines} 行</span><span className="added">+{visibleReviewDiff.addedLines} 行</span>{reviewDiff && reviewDiff.rows.length > visibleReviewDiff.rows.length && <small>仅展示前 {visibleReviewDiff.rows.length} 行</small>}</div>
            <section className="original"><header>回滚后当前文件</header><div><MarkdownDiffPane diff={visibleReviewDiff} side="original" /></div></section>
            <section className="revised"><header>OpenCode 完整修改稿</header><div><MarkdownDiffPane diff={visibleReviewDiff} side="revised" /></div></section>
          </div>}
          {job.scopeReview.decision
            ? <div className={`opencode-scope-review-decision is-${job.scopeReview.decision}`}>{job.scopeReview.decision === "accepted" ? "已确认并应用该修改" : "已拒绝该修改，当前文件保持回滚状态"}</div>
            : <div className="opencode-scope-review-actions"><button type="button" disabled={busy} onClick={onRejectScopeReview}>拒绝修改</button><button type="button" className="primary" disabled={busy} onClick={onAcceptScopeReview}>{busy ? "正在处理…" : "确认并应用全部修改"}</button></div>}
        </div>}
        {tab === "output" && job && (draft
          ? <div className="long-writing-output-preview opencode-detail-output"><MarkdownPreview markdown={draft.markdown} filePath={task.filePath} workspaceRoot={task.workspaceRoot} /></div>
          : <div className="opencode-conversation-empty"><LoaderCircle className={active ? "long-writing-spin" : ""} size={24} /><b>{STATUS_LABELS[job.status]}</b><span>章节返回后将在这里显示最终输出。</span></div>)}
        {tab === "diff" && visibleDiff && <div className="long-writing-diff opencode-detail-diff">
          <div className="long-writing-diff-stats"><span className="deleted">-{visibleDiff.deletedLines} 行</span><span className="added">+{visibleDiff.addedLines} 行</span>{diff && diff.rows.length > visibleDiff.rows.length && <small>仅展示前 {visibleDiff.rows.length} 行</small>}</div>
          <section className="original"><header>原文</header><div><MarkdownDiffPane diff={visibleDiff} side="original" /></div></section>
          <section className="revised"><header>AI 稿</header><div><MarkdownDiffPane diff={visibleDiff} side="revised" /></div></section>
        </div>}
        {tab === "details" && job && <div className="long-writing-output-details opencode-detail-metadata">
          {job.error && <section className="opencode-conversation-error"><AlertTriangle size={13} />{job.error}</section>}
          {draft && <>
            <section><b>章节摘要</b><p>{draft.summary || "未返回摘要"}</p></section>
            <section><b>使用事实</b>{draft.factsUsed.length ? <ul>{draft.factsUsed.map((fact, index) => <li key={`${fact}-${index}`}>{fact}</li>)}</ul> : <p>未声明额外事实</p>}</section>
            <section><b>术语</b>{draft.terminologyUsed.length ? <dl>{draft.terminologyUsed.map((entry, index) => <div key={`${entry.term}-${index}`}><dt>{entry.term}</dt><dd>{entry.definition}</dd></div>)}</dl> : <p>未声明术语</p>}</section>
            <section><b>待确认项</b>{draft.openQuestions.length ? <ul>{draft.openQuestions.map((question, index) => <li key={`${question}-${index}`}>{question}</li>)}</ul> : <p>无待确认项</p>}</section>
          </>}
          <section><b>执行信息</b><p>状态：{STATUS_LABELS[job.status]} · 尝试：{job.attempts}/{job.maxAttempts}</p>{job.completedAt && <p>完成：{formatTime(job.completedAt)}</p>}</section>
        </div>}
        {tab === "session" && <ConversationView directory={task.workspaceRoot} sessionId={job?.sessionId ?? task.mainSessionId} activitySignal={activitySignal} active={active} />}
      </div>
      <footer className="opencode-detail-note">仅展示 OpenCode API 返回的可见消息和工具记录，不展示模型隐藏推理。</footer>
    </section>
  </div>, document.body);
}
