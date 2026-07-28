import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Bot, Check, Database, FileSearch, Globe2, Maximize2, MessageSquarePlus, Send, Square, Trash2 } from "lucide-react";
import { buildProposalAgentMessages, type ResolvedAgentContext } from "../agent/contextBuilder";
import { AGENT_CONVERSATIONS_CHANGED, compactAgentConversation, createAgentConversation, deleteAgentConversation, listAgentConversations, saveAgentConversation, type AgentConversation } from "../agent/conversationStore";
import { createProposalToolRegistry, proposalAgentSystemPrompt } from "../agent/proposalTools";
import type { AgentDraft, AgentEvent, AgentRunStatus, TodoItem } from "../agent/protocol";
import { runProposalAgent } from "../agent/runner";
import { buildAgentPreferencePrompt, normalizeAgentSettings } from "../agent/settings";
import { listProjectMemories } from "../agent/memoryService";
import type { DocumentBlock, Project, SelectedModel } from "../types";
import { resolveActiveModelConfig } from "../services/llm/resolve";
import { ModelSelect } from "./ModelSelect";
import { AgentConversationTimeline } from "./AgentConversationTimeline";
import { AgentDraftReviewModal } from "./AgentDraftReviewModal";
import { latestTodosFromMessages } from "../agent/todos";
import { AgentTodoPlan } from "./AgentTodoPlan";

type DraftDecision = { resolve: (approved: boolean) => void; cleanup: () => void };

function conversationTitle(task: string) {
  return task.replace(/\s+/g, " ").trim().slice(0, 24) || "新会话";
}

export function AgentConversationPanel({ project, block, pinnedContext, updateBlock, notify }: {
  project: Project;
  block: DocumentBlock;
  pinnedContext: ResolvedAgentContext[];
  updateBlock: (updater: (block: DocumentBlock) => DocumentBlock) => void;
  notify: (message: string) => void;
}) {
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [input, setInput] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [runStatus, setRunStatus] = useState<AgentRunStatus>("idle");
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todosCollapsed, setTodosCollapsed] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<SelectedModel | null>(project.selectedModel ?? null);
  const abortRef = useRef<AbortController | null>(null);
  const draftDecisionRef = useRef<DraftDecision | null>(null);
  const agentSettings = normalizeAgentSettings(project.agent);
  const aiEnabled = project.model?.enabled !== false;
  const running = runStatus === "running" || runStatus === "waiting_approval";
  const workspaceRoot = project.workspace?.root;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const loaded = await listAgentConversations(project.id, workspaceRoot);
        if (cancelled) return;
        const initial = loaded[0] ?? createAgentConversation(project.id, agentSettings.defaultPinnedContextOnly);
        setConversations(loaded.length ? loaded : [initial]);
        setActiveId(current => loaded.some(item => item.id === current) ? current : initial.id);
      } catch (error) {
        if (!cancelled) notify(error instanceof Error ? error.message : "历史会话加载失败");
      }
    };
    const onChanged = (event: Event) => {
      const changedProjectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (!changedProjectId || changedProjectId === project.id) void load();
    };
    void load();
    window.addEventListener(AGENT_CONVERSATIONS_CHANGED, onChanged);
    return () => { cancelled = true; window.removeEventListener(AGENT_CONVERSATIONS_CHANGED, onChanged); };
  }, [project.id, workspaceRoot, agentSettings.defaultPinnedContextOnly]);

  useEffect(() => { if (!draft) setReviewOpen(false); }, [draft]);
  useEffect(() => () => abortRef.current?.abort(), []);
  const active = useMemo(() => conversations.find(item => item.id === activeId) ?? conversations[0], [activeId, conversations]);
  const messages = active?.messages ?? [];
  const pinnedContextOnly = Boolean(active?.pinnedContextOnly && pinnedContext.length > 0);
  const webSearchEnabled = active?.webSearchEnabled === true;
  const knowledgeSearchEnabled = active?.knowledgeSearchEnabled !== false;

  useEffect(() => {
    const restored = latestTodosFromMessages(active?.messages ?? []);
    setTodos(restored);
    setTodosCollapsed(restored.length > 0 && restored.every(todo => todo.status === "completed"));
  }, [activeId, project.id]);

  const commitConversation = async (conversation: AgentConversation) => {
    const saved = await saveAgentConversation(compactAgentConversation(conversation, agentSettings.recentMessages), workspaceRoot);
    setConversations(await listAgentConversations(project.id, workspaceRoot));
    setActiveId(saved.id);
    return saved;
  };

  const createConversation = () => {
    void (async () => {
      try {
        const created = await saveAgentConversation(createAgentConversation(project.id, agentSettings.defaultPinnedContextOnly), workspaceRoot);
        setConversations(await listAgentConversations(project.id, workspaceRoot));
        setActiveId(created.id);
        setEvents([]);
        setDraft(null);
        setTodos([]);
        setTodosCollapsed(false);
      } catch (error) {
        notify(error instanceof Error ? error.message : "新建会话失败");
      }
    })();
  };

  const removeConversation = () => {
    if (!active || running) return;
    void (async () => {
      try {
        await deleteAgentConversation(active.id, project.id, workspaceRoot);
        const remaining = await listAgentConversations(project.id, workspaceRoot);
        const next = remaining[0] ?? createAgentConversation(project.id, agentSettings.defaultPinnedContextOnly);
        setConversations(remaining.length ? remaining : [next]);
        setActiveId(next.id);
        setEvents([]);
        setDraft(null);
        const restored = latestTodosFromMessages(next.messages);
        setTodos(restored);
        setTodosCollapsed(restored.length > 0 && restored.every(todo => todo.status === "completed"));
      } catch (error) {
        notify(error instanceof Error ? error.message : "删除会话失败");
      }
    })();
  };
  const setPinnedContextOnly = (value: boolean) => {
    if (!active) return;
    void commitConversation({ ...active, pinnedContextOnly: value }).catch(error => notify(error instanceof Error ? error.message : "会话设置保存失败"));
  };
  const setWebSearchEnabled = (value: boolean) => {
    if (!active) return;
    void commitConversation({ ...active, webSearchEnabled: value }).catch(error => notify(error instanceof Error ? error.message : "会话设置保存失败"));
  };
  const setKnowledgeSearchEnabled = (value: boolean) => {
    if (!active) return;
    void commitConversation({ ...active, knowledgeSearchEnabled: value }).catch(error => notify(error instanceof Error ? error.message : "会话设置保存失败"));
  };
  const stopRun = () => {
    abortRef.current?.abort();
  };

  const settleDraft = (approved: boolean) => {
    const decision = draftDecisionRef.current;
    if (!decision) return;
    decision.cleanup();
    draftDecisionRef.current = null;
    setRunStatus("running");
    decision.resolve(approved);
  };
  const reviewDraft = (nextDraft: AgentDraft, signal: AbortSignal) => new Promise<boolean>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      if (draftDecisionRef.current?.resolve === resolve) draftDecisionRef.current = null;
      setDraft(null);
      setReviewOpen(false);
      reject(new DOMException("Agent 任务已取消", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    draftDecisionRef.current = { resolve, cleanup };
    signal.addEventListener("abort", onAbort, { once: true });
    setDraft(nextDraft);
    setRunStatus("waiting_approval");
  });

  const rejectDraft = () => { setReviewOpen(false); setDraft(null); settleDraft(false); };
  const acceptDraft = () => {
    if (!draft) return;
    updateBlock(current => ({ ...current, content: draft.after }));
    setReviewOpen(false);
    setDraft(null);
    settleDraft(true);
    notify("Agent 修改已应用到当前章节");
  };


  const send = async () => {
    const task = input.trim();
    if (!task || !active) return;
    let config;
    try {
      config = resolveActiveModelConfig(project.providers ?? [], selectedModel, { aiEnabled });
    } catch (e: any) {
      notify(e?.message ?? "模型未配置");
      return;
    }
    const pendingConversation: AgentConversation = {
      ...active,
      title: active.messages.length ? active.title : conversationTitle(task),
      messages: [...active.messages, { role: "user", content: task }],
    };
    const controller = new AbortController();
    abortRef.current = controller;
    setRunStatus("running");
    setEvents([]);
    setTodos([]);
    setTodosCollapsed(false);
    setDraft(null);
    setInput("");
    try {
      await commitConversation(pendingConversation);
    } catch (error) {
      setRunStatus("failed");
      notify(error instanceof Error ? error.message : "会话保存失败");
      return;
    }
    try {
    const registry = createProposalToolRegistry({ project, block, reviewDraft, onTodos: nextTodos => { setTodos(nextTodos); setTodosCollapsed(false); } });
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
      const result = await runProposalAgent({ task, messages: requestMessages, config, registry, signal: controller.signal, onEvent: event => setEvents(current => [...current, event]), contextCompressionTokens: agentSettings.contextCompressionTokens, temperature: agentSettings.temperature, firstRoundToolName: agentSettings.planningEnabled ? "write_todo" : undefined, maxRounds: agentSettings.maxRounds });
      const runtimeMessages = result.messages.slice(1);
      setEvents([]);
      await commitConversation({ ...pendingConversation, messages: runtimeMessages });
      setRunStatus(result.status);
      setTodosCollapsed(result.status === "completed");
      if (result.status === "round_limit_reached") notify(`Agent 已达到 ${agentSettings.maxRounds} 轮执行上限`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") setRunStatus("cancelled");
      else { setRunStatus("failed"); notify(error instanceof Error ? error.message : "Agent 执行失败"); }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  return <div className="inspector-content agent-chat-panel">
    <header className="agent-chat-head">
      <select value={active?.id ?? ""} onChange={event => { const next = conversations.find(item => item.id === event.target.value); setActiveId(event.target.value); setEvents([]); setDraft(null); const restored = latestTodosFromMessages(next?.messages ?? []); setTodos(restored); setTodosCollapsed(restored.length > 0 && restored.every(todo => todo.status === "completed")); }} disabled={running} aria-label="Agent 会话">
        {conversations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <button type="button" title="新建会话" onClick={createConversation} disabled={running}><MessageSquarePlus size={15} /></button>
      <button type="button" title="删除当前会话" onClick={removeConversation} disabled={running}><Trash2 size={14} /></button>
    </header>

    <label className="agent-model-select">
      <span>模型</span>
      <ModelSelect providers={project.providers ?? []} value={selectedModel} onChange={setSelectedModel} disabled={running || !aiEnabled} />
    </label>
    {!aiEnabled && <small className="model-list-error">联网模型已关闭，请先在设置中启用。</small>}

    <AgentTodoPlan todos={todos} collapsed={todosCollapsed} toggle={() => setTodosCollapsed(value => !value)} />

    <div className="agent-chat-history" aria-live="polite">
      {!messages.length && <div className="agent-chat-empty"><Bot size={24} /><b>开始方案对话</b><span>{pinnedContext.length ? `已附加 ${pinnedContext.length} 份上下文` : "可直接提问，也可先在资料页加入上下文"}</span></div>}
      <AgentConversationTimeline messages={messages} events={events} running={running} />
    </div>

    {draft && <section className="agent-draft">
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
        <Database size={13} /><span>知识检索</span>
      </label>
      <label className="agent-tool-toggle" title="允许 Agent 在需要最新外部信息时请求联网搜索">
        <input type="checkbox" checked={webSearchEnabled} disabled={running} onChange={event => setWebSearchEnabled(event.target.checked)} />
        <Globe2 size={13} /><span>联网搜索</span>
      </label>
      <label className="agent-context-toggle" title={`仅使用已引用资料，共 ${pinnedContext.length} 条`}>
        <input type="checkbox" checked={pinnedContextOnly} disabled={!pinnedContext.length || running} onChange={event => setPinnedContextOnly(event.target.checked)} />
        <BookOpen size={13} /><span>{`引用资料${pinnedContext.length}条`}</span>
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

