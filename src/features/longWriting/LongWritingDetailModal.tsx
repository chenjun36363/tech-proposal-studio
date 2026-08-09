import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  FilePenLine,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
  User,
  Wrench,
  X,
} from "lucide-react";
import type { AgentDraft } from "../../agent/protocol";
import { AgentMarkdown } from "../../components/AgentConversationTimeline";
import { AgentDraftReviewModal } from "../../components/AgentDraftReviewModal";
import { formatConversationValue, mergeOpenCodeConversations, normalizeOpenCodeConversation, type OpenCodeConversationMessage, type OpenCodeConversationPart } from "./openCodeConversation";
import { getOpenCodeSessionMessages } from "./opencodeService";
import type { ChapterJob, ChapterJobStatus, LongWritingTaskRecord } from "./types";

const STATUS_LABELS: Record<ChapterJobStatus, string> = {
  queued: "排队", analyzing: "分析", awaiting_write: "待写入", writing: "写入", running: "生成",
  validating: "校验", committing: "写入", completed: "完成", awaiting_review: "待确认", retryable: "等待重试",
  failed: "失败", cancelled: "已停止",
};


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

function toolStatusLabel(status?: string) {
  if (status === "completed" || status === "success") return "已完成";
  if (status === "running" || status === "streaming" || status === "pending") return "执行中";
  if (status === "error" || status === "failed") return "失败";
  return status || "未知";
}

function ReasoningPart({ part }: { part: OpenCodeConversationPart }) {
  const [open, setOpen] = useState(true);
  if (!part.text?.trim()) return null;
  return <details className={`opencode-conversation-reasoning ${part.streaming ? "is-streaming" : ""}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Brain size={13} /><span><b>思考过程</b><small>OpenCode 可见输出</small></span>{part.streaming && <i className="opencode-streaming-badge">思考中</i>}<ChevronRight size={13} /></summary>
    <div className="opencode-conversation-reasoning-body"><AgentMarkdown content={part.text} />{part.streaming && <i className="opencode-streaming-caret" aria-label="正在思考" />}</div>
  </details>;
}

function ConversationPart({ part, role }: { part: OpenCodeConversationPart; role: OpenCodeConversationMessage["role"] }) {
  if (part.kind === "text") {
    if (!part.text?.trim()) return null;
    return <div className={`opencode-conversation-text type-${part.rawType ?? "text"}`}>
      {role === "assistant" ? <AgentMarkdown content={part.text} /> : <p>{part.text}</p>}
      {part.streaming && <i className="opencode-streaming-caret" aria-label="正在输出" />}
    </div>;
  }
  if (part.kind === "reasoning") return <ReasoningPart part={part} />;
  if (part.kind === "tool") {
    const preview = formatConversationValue(part.input).replace(/\s+/g, " ").trim().slice(0, 100) || "查看调用详情";
    const failed = part.status === "error" || part.status === "failed" || Boolean(part.error);
    return <details className={`opencode-conversation-tool status-${part.status ?? "unknown"}`} open={Boolean(part.streaming || failed)}>
      <summary>
        <i><Wrench size={13} /></i>
        <span><b>{part.tool}</b><small>{preview}</small></span>
        <em>{toolStatusLabel(part.status)}</em>
        <ChevronRight size={13} />
      </summary>
      <div className="opencode-conversation-tool-body">
        <PartValue title="输入参数" value={part.input} />
        <PartValue title="执行结果" value={part.output} />
        {part.error && <div className="opencode-conversation-error"><AlertTriangle size={13} />{part.error}</div>}
      </div>
    </details>;
  }
  if (part.kind === "error") return <div className="opencode-conversation-error"><AlertTriangle size={13} />{part.error}</div>;
  return <details className="opencode-conversation-unknown"><summary>未识别内容：{part.rawType ?? "unknown"}</summary>{part.text && <pre>{part.text}</pre>}</details>;
}

export function OpenCodeConversationMessageCard({ message, expanded, onToggle }: {
  message: OpenCodeConversationMessage;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyMessage = () => {
    const text = message.parts.map(part => part.text || formatConversationValue(part.output)).filter(Boolean).join("\n\n");
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return <article className={`opencode-conversation-message role-${message.role} ${expanded ? "is-expanded" : "is-collapsed"}`}>
    <header className="opencode-conversation-message-head">
      <span className="opencode-conversation-avatar">{message.role === "user" ? <User size={14} /> : <Bot size={14} />}</span>
      <span className="opencode-conversation-identity"><b>{roleLabel(message.role)}</b>{message.phase && <i className={`opencode-message-phase phase-${message.phase}`}>{message.phase === "analysis" ? "分析输入" : "写入输入"}</i>}{message.streaming && <i className="opencode-streaming-badge">实时输出</i>}</span>
      <span className="opencode-conversation-message-meta"><small>{message.model}{message.createdAt ? `${message.model ? " · " : ""}${formatTime(message.createdAt)}` : ""}</small></span>
      <button type="button" className="opencode-conversation-copy" aria-label={copied ? "已复制消息" : "复制消息"} title={copied ? "已复制" : "复制消息"} onClick={copyMessage}>{copied ? <Check size={12} /> : <Clipboard size={12} />}</button>
      <button type="button" className="opencode-conversation-toggle" aria-expanded={expanded} aria-label={expanded ? "收起消息" : "展开消息"} title={expanded ? "收起消息" : "展开消息"} onClick={onToggle}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
    </header>
    {expanded && <div className="opencode-conversation-message-body">
      {message.error && <div className="opencode-conversation-error"><AlertTriangle size={13} />{message.error}</div>}
      <div className="opencode-conversation-parts">{message.parts.map(part => <ConversationPart part={part} role={message.role} key={part.id} />)}</div>
    </div>}
  </article>;
}

function longWritingChangeDraft(job: ChapterJob): AgentDraft | null {
  if (job.scopeReview) {
    return {
      callId: `long-writing-scope-${job.id}`,
      operation: "replace_document",
      before: job.preEditDocumentMarkdown ?? "",
      after: job.scopeReview.proposedDocumentMarkdown,
      instruction: `越界修改：${job.scopeReview.reason}`,
      target: { sectionId: job.headingId ?? job.chapterId, sectionTitle: job.titlePath.join(" / ") },
    };
  }
  if (!job.draft) return null;
  return {
    callId: `long-writing-change-${job.id}`,
    operation: "replace_section",
    before: job.originalMarkdown,
    after: job.draft.markdown,
    instruction: job.summary || job.draft.summary || `修改 ${job.titlePath.join(" / ")}`,
    target: {
      sectionId: job.headingId ?? job.chapterId,
      sectionTitle: job.titlePath.join(" / "),
      sectionLevel: job.headingLevel,
      snapshot: job.originalMarkdown,
    },
  };
}

export function LongWritingChangeRecord({ job, busy = false, onAcceptScopeReview, onRejectScopeReview }: {
  job: ChapterJob;
  busy?: boolean;
  onAcceptScopeReview?: () => void;
  onRejectScopeReview?: () => void;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const draft = useMemo(() => longWritingChangeDraft(job), [job]);
  if (!draft) return job.error ? <div className="opencode-conversation-error long-writing-conversation-error"><AlertTriangle size={13} />{job.error}</div> : null;
  const review = job.scopeReview;
  const awaitingDecision = Boolean(review && !review.decision);
  const title = review
    ? review.decision === "accepted"
      ? "越界修改已确认并应用"
      : review.decision === "rejected"
        ? "越界修改已拒绝"
        : "修改超出目标范围，等待确认"
    : "已修改正式文件";
  const badge = review ? (review.decision === "accepted" ? "已应用" : review.decision === "rejected" ? "已拒绝" : "待确认") : "已写入";
  const finishReview = (action?: () => void) => {
    setReviewOpen(false);
    action?.();
  };
  return <>
    <section className={`agent-change-result long-writing-change-record ${review ? "needs-review" : "auto-applied"}`}>
      <header className="agent-change-result-head">
        <FilePenLine size={13} />
        <span><b>{title}</b><small>{draft.instruction}</small></span>
        <em>{badge}</em>
      </header>
      <p><span>修改前 {draft.before.length.toLocaleString()} 字</span><span>修改后 {draft.after.length.toLocaleString()} 字</span></p>
      {job.error && <div className="opencode-conversation-error"><AlertTriangle size={13} />{job.error}</div>}
      <footer className="long-writing-change-actions">
        <span>{review ? "该修改曾超出目标章节，正式文件已自动回滚。" : "修改已写入并通过目标范围校验。"}</span>
        <div>
          {awaitingDecision && <button type="button" disabled={busy} onClick={onRejectScopeReview}>拒绝</button>}
          <button type="button" className="agent-change-review-btn" onClick={() => setReviewOpen(true)}><Maximize2 size={12} />查看修改</button>
          {awaitingDecision && <button type="button" className="primary" disabled={busy} onClick={onAcceptScopeReview}>{busy ? "处理中…" : "确认应用"}</button>}
        </div>
      </footer>
    </section>
    {reviewOpen && <AgentDraftReviewModal
      draft={draft}
      readonly={!awaitingDecision}
      close={() => setReviewOpen(false)}
      reject={() => finishReview(onRejectScopeReview)}
      accept={() => finishReview(onAcceptScopeReview)}
    />}
  </>;
}

function ConversationView({ directory, sessionId, activitySignal, active, liveMessages, job, busy, onAcceptScopeReview, onRejectScopeReview }: {
  directory: string;
  sessionId?: string;
  activitySignal?: string;
  active: boolean;
  liveMessages?: OpenCodeConversationMessage[];
  job?: ChapterJob;
  busy?: boolean;
  onAcceptScopeReview?: () => void;
  onRejectScopeReview?: () => void;
}) {
  const [messages, setMessages] = useState<ReturnType<typeof normalizeOpenCodeConversation>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [collapsedMessageIds, setCollapsedMessageIds] = useState<Set<string>>(() => new Set());
  const visibleMessages = useMemo(() => {
    const merged = mergeOpenCodeConversations(messages, liveMessages);
    if (active) return merged;
    return merged.map(message => ({
      ...message,
      streaming: false,
      parts: message.parts.map(part => ({ ...part, streaming: false })),
    }));
  }, [active, messages, liveMessages]);
  const hasChangeRecord = Boolean(job && (job.draft || job.scopeReview || job.error));
  useEffect(() => {
    if (!sessionId) return;
    let current = true;
    let inFlight = false;
    const load = async (showLoading: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (showLoading) setLoading(true);
      try {
        const value = await getOpenCodeSessionMessages(directory, sessionId);
        if (!current) return;
        setMessages(normalizeOpenCodeConversation(value));
        setError("");
      } catch (reason) {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        inFlight = false;
        if (current && showLoading) setLoading(false);
      }
    };
    void load(true);
    const polling = active ? window.setInterval(() => void load(false), 800) : undefined;
    return () => {
      current = false;
      if (polling !== undefined) window.clearInterval(polling);
    };
  }, [directory, sessionId, revision, active]);
  useEffect(() => {
    if (!activitySignal || !active) return;
    const timer = window.setTimeout(() => setRevision(value => value + 1), 180);
    return () => window.clearTimeout(timer);
  }, [activitySignal, active]);

  if (!sessionId) return <div className="opencode-conversation-empty"><MessageSquareText size={24} /><b>尚未创建会话</b><span>OpenCode session 创建后即可查看输入和执行内容。</span></div>;
  const allCollapsed = visibleMessages.length > 0 && visibleMessages.every(message => collapsedMessageIds.has(message.id));
  const toggleAllMessages = () => setCollapsedMessageIds(allCollapsed
    ? new Set()
    : new Set(visibleMessages.map(message => message.id)));
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
        {!!visibleMessages.length && <button type="button" onClick={toggleAllMessages} title={allCollapsed ? "全部展开" : "全部收起"} aria-label={allCollapsed ? "全部展开" : "全部收起"}>{allCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button>}
        <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)} title="刷新会话" aria-label="刷新会话"><RefreshCw className={loading ? "long-writing-spin" : ""} size={14} /></button>
      </div>
    </div>
    {error && <div className="opencode-conversation-load-error"><AlertTriangle size={15} /><span><b>无法读取会话</b>{error}</span><button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
    {!error && loading && !visibleMessages.length && !hasChangeRecord && <div className="opencode-conversation-empty"><LoaderCircle className="long-writing-spin" size={24} /><b>正在读取会话</b></div>}
    {!error && !loading && !visibleMessages.length && !hasChangeRecord && <div className="opencode-conversation-empty"><MessageSquareText size={24} /><b>会话暂无可见消息</b><span>OpenCode 返回消息后，会在这里按对话顺序持续追加。</span></div>}
    <div className="opencode-conversation-messages" aria-live="polite">
      {visibleMessages.map(message => <OpenCodeConversationMessageCard key={message.id} message={message}
        expanded={!collapsedMessageIds.has(message.id)}
        onToggle={() => toggleMessage(message.id)}
      />)}
      {job && <LongWritingChangeRecord job={job} busy={busy} onAcceptScopeReview={onAcceptScopeReview} onRejectScopeReview={onRejectScopeReview} />}
    </div>
  </div>;
}

export function LongWritingDetailModal({ task, job, busy = false, close, onLocate, onRetry, onAcceptScopeReview, onRejectScopeReview, activitySignal, liveMessages }: {
  task: LongWritingTaskRecord;
  job?: ChapterJob;
  busy?: boolean;
  close: () => void;
  onLocate?: () => void;
  onRetry?: () => void;
  onAcceptScopeReview?: () => void;
  onRejectScopeReview?: () => void;
  activitySignal?: string;
  liveMessages?: OpenCodeConversationMessage[];
}) {
  const active = job
    ? ["analyzing", "writing", "running", "validating", "committing"].includes(job.status)
    : ["preparing", "running", "checking"].includes(task.status);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return createPortal(<div className="modal-backdrop opencode-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal wide opencode-detail-modal is-conversation-only" role="dialog" aria-modal="true" aria-labelledby="opencode-detail-title" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title">
        <div><MessageSquareText size={18} /><span><b id="opencode-detail-title">{job ? job.titlePath.join(" / ") : "目录生成会话"}</b><small>{job ? `${STATUS_LABELS[job.status]} · 第 ${job.attempts} 次尝试` : `任务状态：${task.status}`}</small></span></div>
        <div className="opencode-detail-head-actions">
          {job && onLocate && <button type="button" title="在编辑器中定位" onClick={onLocate}>定位章节</button>}
          {job && onRetry && (["failed", "retryable", "cancelled"] as ChapterJobStatus[]).includes(job.status) && <button type="button" onClick={onRetry}><RotateCcw size={13} />重试本章</button>}
          <button type="button" className="icon-button" title="关闭" aria-label="关闭" onClick={close}><X size={18} /></button>
        </div>
      </div>
      <div className="opencode-detail-body is-conversation-only">
        <ConversationView
          directory={task.workspaceRoot}
          sessionId={job?.sessionId ?? task.mainSessionId}
          activitySignal={activitySignal}
          active={active}
          liveMessages={liveMessages}
          job={job}
          busy={busy}
          onAcceptScopeReview={onAcceptScopeReview}
          onRejectScopeReview={onRejectScopeReview}
        />
      </div>
      <footer className="opencode-detail-note">会话按时间顺序展示输入、可见思考、工具调用和输出；Worker 对正式文件的修改可通过“查看修改”打开前后对照。</footer>
    </section>
  </div>, document.body);
}
