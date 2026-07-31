import { useEffect, useState } from "react";
import { Clock3, HardDrive, MessageSquareText, Trash2 } from "lucide-react";
import { AGENT_CONVERSATIONS_CHANGED, applyAgentConversationChange, clearAgentConversations, deleteAgentConversation, listAgentConversations, type AgentConversation, type AgentConversationChange } from "../agent/conversationStore";
import { isDesktop } from "../services/runtime";
import type { Project } from "../core/types";

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function conversationPreview(conversation: AgentConversation): string {
  const message = [...conversation.messages].reverse().find(item => (item.role === "user" || item.role === "assistant") && item.content?.trim());
  return message?.content?.replace(/\s+/g, " ").trim().slice(0, 120) || conversation.summary.replace(/\s+/g, " ").trim().slice(-120) || "尚无消息";
}

function messageCount(conversation: AgentConversation): number {
  return conversation.messageCount ?? conversation.messages.filter(item => item.role === "user" || item.role === "assistant").length;
}

export function ConversationHistorySettings({ project }: { project: Project }) {
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const root = project.workspace?.root;

  const reload = async () => {
    setLoading(true);
    setError("");
    try {
      setConversations(await listAgentConversations(project.id, root));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "历史会话加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<AgentConversationChange>).detail;
      if (change?.projectId === project.id) setConversations(current => applyAgentConversationChange(current, change));
    };
    window.addEventListener(AGENT_CONVERSATIONS_CHANGED, onChanged);
    return () => window.removeEventListener(AGENT_CONVERSATIONS_CHANGED, onChanged);
  }, [project.id, root]);

  const remove = async (conversation: AgentConversation) => {
    if (!window.confirm(`删除会话“${conversation.title}”？此操作无法撤销。`)) return;
    setBusyId(conversation.id);
    setError("");
    try {
      await deleteAgentConversation(conversation.id, project.id, root);
      setConversations(current => current.filter(item => item.id !== conversation.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除会话失败");
    } finally {
      setBusyId(null);
    }
  };

  const clearAll = async () => {
    if (!conversations.length || !window.confirm(`清空当前项目的 ${conversations.length} 条历史会话？此操作无法撤销。`)) return;
    setBusyId("all");
    setError("");
    try {
      await clearAgentConversations(project.id, root);
      setConversations([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "清空历史会话失败");
    } finally {
      setBusyId(null);
    }
  };

  const storageLabel = isDesktop() && root
    ? `${root.replace(/[\\/]+$/, "")}\\.gouan\\conversations.db`
    : "浏览器 localStorage";

  return <div className="settings-section-content conversation-history-settings">
    <div className="conversation-history-summary">
      <div><MessageSquareText size={18} /><span><b>{conversations.length}</b><small>历史会话</small></span></div>
      <div><HardDrive size={17} /><span><b>{isDesktop() && root ? "SQLite 数据库" : "浏览器存储"}</b><small title={storageLabel}>{storageLabel}</small></span></div>
      <button type="button" className="danger-action" onClick={() => void clearAll()} disabled={!conversations.length || busyId !== null}><Trash2 size={14} />清空全部</button>
    </div>

    {error && <p className="conversation-history-error">{error}</p>}
    {loading ? <div className="conversation-history-empty">正在读取历史会话...</div> : conversations.length === 0
      ? <div className="conversation-history-empty"><MessageSquareText size={24} /><b>暂无历史会话</b><span>开始一次 Agent 对话后，会话将自动保存在这里。</span></div>
      : <div className="conversation-history-list">
        {conversations.map(conversation => <article key={conversation.id}>
          <div className="conversation-history-icon"><MessageSquareText size={16} /></div>
          <div className="conversation-history-main">
            <header><b>{conversation.title}</b><span><Clock3 size={12} />{formatTime(conversation.updatedAt)}</span></header>
            <p>{conversationPreview(conversation)}</p>
            <small>{messageCount(conversation)} 条对话消息{conversation.summary ? " · 含较早消息摘要" : ""}</small>
          </div>
          <button type="button" title={`删除会话 ${conversation.title}`} onClick={() => void remove(conversation)} disabled={busyId !== null}><Trash2 size={14} /></button>
        </article>)}
      </div>}
  </div>;
}
