import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Bot, Check, Database, FileSearch, Globe2, Maximize2, MessageSquarePlus, Send, Square, Trash2 } from "lucide-react";
import { buildProposalAgentMessages, type ResolvedAgentContext } from "../agent/contextBuilder";
import { compactAgentConversation, createAgentConversation, deleteAgentConversation, listAgentConversations, saveAgentConversation, type AgentConversation } from "../agent/conversationStore";
import { createProposalToolRegistry, proposalAgentSystemPrompt } from "../agent/proposalTools";
import type { AgentDraft, AgentEvent, AgentMessage } from "../agent/protocol";
import { runProposalAgent } from "../agent/runner";
import { buildAgentPreferencePrompt, normalizeAgentSettings } from "../agent/settings";
import { listProjectMemories } from "../agent/memoryService";
import type { DocumentBlock, Project } from "../types";
import { AgentConversationTimeline } from "./AgentConversationTimeline";
import { AgentDraftReviewModal } from "./AgentDraftReviewModal";

type TodoItem = { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string };

function conversationTitle(task: string) {
  return task.replace(/\s+/g, " ").trim().slice(0, 24) || "新会话";
}

export function AgentConversationPanel({ project, block, sourceContents, pinnedContext, updateBlock, notify }: {
  project: Project;
  block: DocumentBlock;
  sourceContents: Record<string, string>;
  pinnedContext: ResolvedAgentContext[];
  updateBlock: (updater: (block: DocumentBlock) => DocumentBlock) => void;
  notify: (message: string) => void;
}) {
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [input, setInput] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [draftRejected, setDraftRejected] = useState(false);
  const [running, setRunning] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const agentSettings = normalizeAgentSettings(project.agent);

  useEffect(() => {
    const loaded = listAgentConversations(project.id);
    const initial = loaded[0] ?? saveAgentConversation(createAgentConversation(project.id, agentSettings.defaultPinnedContextOnly));
    setConversations(loaded.length ? loaded : [initial]);
    setActiveId(initial.id);
  }, [project.id, agentSettings.defaultPinnedContextOnly]);

  useEffect(() => { if (!draft) setReviewOpen(false); }, [draft]);
  const active = useMemo(() => conversations.find(item => item.id === activeId) ?? conversations[0], [activeId, conversations]);
  const messages = active?.messages ?? [];
  const pinnedContextOnly = Boolean(active?.pinnedContextOnly && pinnedContext.length > 0);
  const webSearchEnabled = active?.webSearchEnabled === true;
  const knowledgeSearchEnabled = active?.knowledgeSearchEnabled !== false;

  const commitConversation = (conversation: AgentConversation) => {
    const saved = saveAgentConversation(compactAgentConversation(conversation, agentSettings.recentMessages));
    setConversations(listAgentConversations(project.id));
    setActiveId(saved.id);
  };

  const createConversation = () => {
    const created = saveAgentConversation(createAgentConversation(project.id, agentSettings.defaultPinnedContextOnly));
    setConversations(listAgentConversations(project.id));
    setActiveId(created.id);
    setEvents([]);
    setDraft(null);
    setDraftRejected(false);
  };

  const removeConversation = () => {
    if (!active || running) return;
    deleteAgentConversation(active.id);
    const remaining = listAgentConversations(project.id);
    const next = remaining[0] ?? saveAgentConversation(createAgentConversation(project.id, agentSettings.defaultPinnedContextOnly));
    setConversations(remaining.length ? remaining : [next]);
    setActiveId(next.id);
    setEvents([]);
    setDraft(null);
    setDraftRejected(false);
  };
  const setPinnedContextOnly = (value: boolean) => {
    if (!active) return;
    commitConversation({ ...active, pinnedContextOnly: value });
  };
  const setWebSearchEnabled = (value: boolean) => {
    if (!active) return;
    commitConversation({ ...active, webSearchEnabled: value });
  };
  const setKnowledgeSearchEnabled = (value: boolean) => {
    if (!active) return;
    commitConversation({ ...active, knowledgeSearchEnabled: value });
  };
  const stopRun = () => {
    abortRef.current?.abort();
  };


  const rejectDraft = () => { setReviewOpen(false); setDraftRejected(true); };
  const reopenDraft = () => { setDraftRejected(false); setReviewOpen(true); };
  const acceptDraft = () => {
    if (!draft) return;
    updateBlock(current => ({ ...current, content: draft.after }));
    setReviewOpen(false);
    setDraft(null);
    setDraftRejected(false);
    notify("Agent 修改已应用到当前章节");
  };


  const send = async () => {
    const task = input.trim();
    if (!task || !active) return;
    if (!project.model.enabled) return notify("请先启用模型连接");
    const pendingConversation: AgentConversation = {
      ...active,
      title: active.messages.length ? active.title : conversationTitle(task),
      messages: [...active.messages, { role: "user", content: task }],
    };
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setEvents([]);
    setDraft(null);
    setDraftRejected(false);
    setInput("");
    commitConversation(pendingConversation);
    try {
    const registry = createProposalToolRegistry({ project, block, sourceContents, onDraft: nextDraft => { setDraft(nextDraft); setDraftRejected(false); }, onTodos: (_todos: TodoItem[]) => undefined });
    if (!webSearchEnabled) registry.unregister("web_search").unregister("read_web_page");
    if (pinnedContextOnly || !agentSettings.knowledgeToolsEnabled || !knowledgeSearchEnabled) registry.unregister("search_knowledge").unregister("read_knowledge");
    if (!agentSettings.memoryEnabled) registry.unregister("search_memory").unregister("read_memory").unregister("remember_project_fact");
    else if (!agentSettings.autoRemember) registry.unregister("remember_project_fact");
    if (!agentSettings.planningEnabled) registry.unregister("write_todo");
    const promptParts = [proposalAgentSystemPrompt, buildAgentPreferencePrompt(agentSettings)];
    if (pinnedContextOnly) promptParts.push("本轮只能使用用户明确加入的引用资料和当前方案内容，不得检索或引入其他知识库资料。");
    if (!agentSettings.knowledgeToolsEnabled || !knowledgeSearchEnabled) promptParts.push("知识库检索当前已停用。不得调用 search_knowledge 或 read_knowledge，也不得声称已执行知识库检索。");
    if (!webSearchEnabled) promptParts.push("联网搜索当前已停用。不得调用 web_search 或 read_web_page。");
    else promptParts.push(`本轮最多执行 ${agentSettings.webSearchMaxCalls} 次联网搜索，达到上限后不得再次调用 web_search。`);
    if (agentSettings.planningEnabled) promptParts.push("首轮必须先调用 write_todo 制定本次任务的执行计划，再执行读取、检索或修改操作。");
    const memories = agentSettings.memoryEnabled ? await listProjectMemories(project, false) : [];
    const requestMessages = buildProposalAgentMessages({
      systemPrompt: promptParts.join("\n\n"),
      conversation: active,
      pinnedContext,
      pinnedContextChars: agentSettings.pinnedContextChars,
      memoryEnabled: agentSettings.memoryEnabled,
      memories,
      memoryIndexLimit: agentSettings.memoryIndexLimit,
    });
      const result = await runProposalAgent({ task, messages: requestMessages, config: project.model, registry, signal: controller.signal, onEvent: event => setEvents(current => [...current, event]), contextCompressionTokens: agentSettings.contextCompressionTokens, temperature: agentSettings.temperature, firstRoundToolName: agentSettings.planningEnabled ? "write_todo" : undefined });
      const runtimeMessages = result.messages.slice(1);
      setEvents([]);
      commitConversation({ ...pendingConversation, messages: runtimeMessages });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) notify(error instanceof Error ? error.message : "Agent 执行失败");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };

  return <div className="inspector-content agent-chat-panel">
    <header className="agent-chat-head">
      <select value={active?.id ?? ""} onChange={event => { setActiveId(event.target.value); setEvents([]); setDraft(null); setDraftRejected(false); }} disabled={running} aria-label="Agent 会话">
        {conversations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <button type="button" title="新建会话" onClick={createConversation} disabled={running}><MessageSquarePlus size={15} /></button>
      <button type="button" title="删除当前会话" onClick={removeConversation} disabled={running}><Trash2 size={14} /></button>
    </header>

    <section className="agent-context-references" aria-label="已加入 Agent 上下文的引用资料">
      <header><span><BookOpen size={13} />已引用资料</span><b>{pinnedContext.length} 条</b></header>
      {pinnedContext.length > 0
        ? <div>{pinnedContext.slice(0, 3).map(item => {
          const label = item.source.heading ? `${item.source.title} / ${item.source.heading}` : item.source.title;
          return <span key={item.source.id} title={label}>{label}</span>;
        })}{pinnedContext.length > 3 && <em>另有 {pinnedContext.length - 3} 条</em>}</div>
        : <p>尚未加入引用资料</p>}
      <label className="agent-context-mode"><input type="checkbox" checked={pinnedContextOnly} disabled={!pinnedContext.length || running} onChange={event => setPinnedContextOnly(event.target.checked)} /><span>仅使用已引用资料</span></label>
    </section>

    <div className="agent-chat-history" aria-live="polite">
      {!messages.length && <div className="agent-chat-empty"><Bot size={24} /><b>开始方案对话</b><span>{pinnedContext.length ? `已附加 ${pinnedContext.length} 份上下文` : "可直接提问，也可先在资料页加入上下文"}</span></div>}
      <AgentConversationTimeline messages={messages} events={events} running={running} />
    </div>

    {draft && draftRejected && <section className="agent-draft-rejected">
      <div><FileSearch size={14} /><span><b>章节修改已暂不接受</b><small>{draft.instruction}</small></span></div>
      <button type="button" onClick={reopenDraft}><Maximize2 size={12} />再次打开审核</button>
    </section>}

    {draft && !draftRejected && <section className="agent-draft">
      <header><div><FileSearch size={15} /><span>章节修改待确认</span></div><small>{draft.instruction}</small></header>
      <div className="agent-diff-stats"><span className="removed">原文 {draft.before.length.toLocaleString()} 字</span><span className="added">修改后 {draft.after.length.toLocaleString()} 字</span></div>
      <div className="agent-draft-compare">
        <section className="original">
          <div><b>优化前原文</b><span>{draft.before.length.toLocaleString()} 字</span></div>
          <pre>{draft.before || "（当前章节为空）"}</pre>
        </section>
        <section className="revised">
          <div><b>Agent 优化稿</b><span>{draft.after.length.toLocaleString()} 字</span></div>
          <pre>{draft.after}</pre>
        </section>
      </div>
      <div><button type="button" onClick={() => setReviewOpen(true)}><Maximize2 size={13} />放大审核</button><button type="button" onClick={rejectDraft}>拒绝</button><button type="button" className="primary" onClick={acceptDraft}><Check size={13} />接受修改</button></div>
    </section>}

    <div className="agent-tool-toggles">
      <label className="agent-tool-toggle" title="允许 Agent 检索和阅读工作区知识库">
        <input type="checkbox" checked={knowledgeSearchEnabled} disabled={running || pinnedContextOnly || !agentSettings.knowledgeToolsEnabled} onChange={event => setKnowledgeSearchEnabled(event.target.checked)} />
        <Database size={13} /><span>知识检索</span><em>{knowledgeSearchEnabled ? "已启用" : "已停用"}</em>
      </label>
      <label className="agent-tool-toggle" title="允许 Agent 在需要最新外部信息时请求联网搜索">
        <input type="checkbox" checked={webSearchEnabled} disabled={running} onChange={event => setWebSearchEnabled(event.target.checked)} />
        <Globe2 size={13} /><span>联网搜索</span><em>{webSearchEnabled ? "已启用" : "已停用"}</em>
      </label>
    </div>
    <div className="agent-chat-composer">
      <textarea value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="输入消息，Enter 发送，Shift+Enter 换行" disabled={running} />
      {running
        ? <button type="button" title="停止" className="agent-stop" onClick={stopRun}><Square size={14} /></button>
        : <button type="button" title="发送" className="primary" onClick={() => void send()} disabled={!input.trim()}><Send size={15} /></button>}
    </div>
    {draft && reviewOpen && <AgentDraftReviewModal draft={draft} close={() => setReviewOpen(false)} reject={rejectDraft} accept={acceptDraft} />}
  </div>;
}

