import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, BookOpen, Bot, Brain, BrainCircuit, Check, Database, FileSearch, Gauge, GitBranch, Globe2, Hammer, ListTree, Maximize2, MessageSquarePlus, Send, ShieldAlert, Sparkles, Square, Trash2, X } from "lucide-react";
import { buildProposalAgentMessages, type ResolvedAgentContext } from "../agent/contextBuilder";
import { AGENT_CONVERSATIONS_CHANGED, agentConversationMessageCount, applyAgentConversationChange, compactAgentConversationToBudget, createAgentConversation, deleteAgentConversation, getAgentConversation, listAgentConversations, patchAgentConversation, saveAgentConversation, type AgentConversation, type AgentConversationChange, type AgentConversationPatch, type AgentMode, type ConversationDefaults } from "../agent/conversationStore";
import { buildEditorSelectionPrompt, createProposalToolRegistry, proposalAgentSystemPrompt, type AgentSearchHighlight, type AgentWorkspaceRuntime } from "../agent/proposalTools";
import type { AgentDraft, AgentEditorSelection, AgentEvent, AgentGitApprovalRequest, AgentRunStatus, AgentUserQuestion, AgentUserQuestionAnswer, AgentUserQuestionChoice, TodoItem } from "../agent/protocol";
import { runProposalAgent } from "../agent/runner";
import { buildAgentPreferencePrompt, normalizeAgentSettings, type AgentSettings } from "../agent/settings";
import { estimateAgentContextTokens, estimateAgentTextTokens } from "../agent/contextCompaction";
import { listProjectMemories } from "../agent/memoryService";
import type { DocumentBlock, Project, ReasoningEffort, ResolvedModelConfig, SelectedModel } from "../core/types";
import { resolveModelConfigChain } from "../services/llm/resolve";
import { runWithModelFallback } from "../services/llm/fallback";
import { REASONING_EFFORT_LABELS } from "../services/llm/thinking";
import { ModelSelect } from "./ModelSelect";
import { OpenCodeModelSelect } from "../features/longWriting/OpenCodeModelSelect";
import type { CliAgentConnection, CliAgentProvider, CliAgentRuntimeStatus } from "../agent/cliAgentService";
import type { OpenCodeModelOption, OpenCodeModelRef } from "../features/longWriting/opencodeService";
import { createCliAgentCompletion, cliAgentProviderMeta, cliAgentRuntimeLabel, defaultCliAgentModels, resolveCliAgentModelOption } from "../agent/cliAgentService";
import { AgentConversationTimeline } from "./AgentConversationTimeline";
import { AgentDraftReviewModal } from "./AgentDraftReviewModal";
import { latestTodosFromMessages } from "../agent/todos";
import { AgentTodoPlan } from "./AgentTodoPlan";
import { AGENT_GIT_CHANGED, type AgentGitRuntime } from "../agent/gitTools";
import { commitGitChanges, createGitBranch, fetchGitRepository, getGitBranches, getGitCommitDiff, getGitDiff, getGitLog, getGitStatus, popGitStash, pullGitRepository, pushGitRepository, stageAllGitFiles, stageGitFile, stashGitChanges, switchGitBranch, unstageAllGitFiles, unstageGitFile } from "../services/git";
import { applySkillSlashSelection, buildSkillsSystemPrompt, discoverSkills, resolveEnabledSkills, skillSlashQuery, type SkillSummary } from "../features/skills/skills";
import { registerSkillTools } from "../agent/skillTools";
import { fuzzyFilter } from "../utils/fuzzy";
import { applyAgentModeTools } from "../agent/modes";

type DraftDecision = { resolve: (approved: boolean) => void; cleanup: () => void };
type QuestionDecision = { resolve: (answer: AgentUserQuestionAnswer) => void; cleanup: () => void };
type GitDecision = { resolve: (approved: boolean) => void; cleanup: () => void };

type AgentReasoningEffort = ReasoningEffort | "inherit";

const AGENT_REASONING_EFFORTS: AgentReasoningEffort[] = ["inherit", "off", "low", "medium", "high"];
const AGENT_REASONING_EFFORT_SHORT_LABELS: Record<AgentReasoningEffort, string> = { inherit: "自", off: "关", low: "低", medium: "中", high: "高" };

function agentReasoningEffortLabel(effort: AgentReasoningEffort) {
  return effort === "inherit" ? "跟随提供方" : REASONING_EFFORT_LABELS[effort];
}

function nextAgentReasoningEffort(effort: AgentReasoningEffort) {
  const index = AGENT_REASONING_EFFORTS.indexOf(effort);
  return AGENT_REASONING_EFFORTS[(index + 1) % AGENT_REASONING_EFFORTS.length];
}

function conversationTitle(task: string) {
  return task.replace(/\s+/g, " ").trim().slice(0, 24) || "新会话";
}

function draftCopy(draft: AgentDraft) {
  if (draft.operation === "move_section") return { title: "章节移动待确认", before: "待移动章节", after: "目标位置章节" };
  if (draft.operation === "replace_selection") return { title: "选区修改待确认", before: "选区原文", after: "替换稿" };
  if (draft.operation === "insert_section") return { title: "章节插入待确认", before: "插入位置", after: "待插入章节" };
  if (draft.operation === "delete_section") return { title: "章节删除待确认", before: "待删除章节", after: "删除后" };
  return { title: "章节修改待确认", before: "章节原文", after: "修改稿" };
}

/**
 * 组装发送给模型的 system prompt 各段（不含运行时注入的 summary / 记忆目录 / 钉住资料）。
 * send() 与上下文 meter 共用，保证 meter 的 token 估算与真实发送内容一致口径。
 */
function buildAgentSystemPromptParts(params: {
  agentSettings: AgentSettings;
  enabledSkills: SkillSummary[];
  webSearchEnabled: boolean;
  knowledgeSearchEnabled: boolean;
  memorySearchEnabled: boolean;
  pinnedContextOnly: boolean;
  fullAccessEnabled: boolean;
  mode: AgentMode;
  capturedSelection?: AgentEditorSelection;
}): string[] {
  const parts = [proposalAgentSystemPrompt, buildAgentPreferencePrompt(params.agentSettings)];
  const skillsPrompt = buildSkillsSystemPrompt(params.enabledSkills);
  if (skillsPrompt) parts.push(skillsPrompt);
  if (params.pinnedContextOnly) parts.push("本轮只能使用用户明确加入的引用资料和当前方案内容，不得检索或引入其他知识库资料。");
  if (!params.knowledgeSearchEnabled) parts.push("知识库检索当前已停用。不得调用 search_knowledge 或 read_knowledge，也不得声称已执行知识库检索。");
  if (!params.webSearchEnabled) parts.push("联网搜索当前已停用。不得调用 web_search 或 read_web_page。");
  else parts.push(`本轮最多执行 ${params.agentSettings.webSearchMaxCalls} 次联网搜索，达到上限后不得再次调用 web_search。`);
  if (!params.memorySearchEnabled) parts.push("长期记忆检索当前已停用。不得调用 search_memory 或 read_memory；如需记录事实，请明确告知用户当前未启用记忆引用。");
  if (params.capturedSelection) parts.push(buildEditorSelectionPrompt(params.capturedSelection));
  parts.push(params.fullAccessEnabled
    ? "本会话已开启完全访问。文档、工作区、Git 写入和系统工具均可直接执行，无需请求逐项确认；用户询问本次修改或当前差异时，优先调用 git_changes 一次性读取全部已暂存、未暂存和未跟踪变更；必须如实报告成功、失败和实际目标。"
    : "本会话未开启完全访问。文档修改必须提交审核提案，且不得尝试系统级文件或命令操作。");
  parts.push(params.mode === "plan"
    ? "当前为 Plan 模式。首轮必须先调用 write_todo 制定计划；只能读取、检索、分析和向用户提问，不得修改文档、工作区、Git、记忆或系统状态。最终输出可执行计划，不得声称已经实施。"
    : "当前为 Build 模式。直接完成用户任务；不要创建任务规划或调用 write_todo。可按当前会话权限使用写入工具，并如实报告实际结果。");
  return parts;
}

export interface LocalAgentPanelConfig {
  connection: CliAgentConnection;
  onConnectionChange: (next: CliAgentConnection) => void;
  models?: OpenCodeModelOption[];
  runtimeStatus?: CliAgentRuntimeStatus;
  runtimeBusy?: boolean;
  onRefreshRuntime?: () => void;
}

export function AgentConversationPanel({ project, block, pinnedContext, editorSelection, clearEditorSelection, applyDraft, workspaceRuntime, onDocumentSearch, notify, localAgent }: {
  project: Project;
  block: DocumentBlock;
  pinnedContext: ResolvedAgentContext[];
  editorSelection?: AgentEditorSelection;
  clearEditorSelection: () => void;
  applyDraft: (draft: AgentDraft) => void;
  workspaceRuntime?: AgentWorkspaceRuntime;
  onDocumentSearch?: (search: AgentSearchHighlight) => void;
  notify: (message: string) => void;
  localAgent?: LocalAgentPanelConfig;
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
  const [userQuestion, setUserQuestion] = useState<AgentUserQuestion | null>(null);
  const [questionChoice, setQuestionChoice] = useState<AgentUserQuestionChoice>("A");
  const [customAnswer, setCustomAnswer] = useState("");
  const [gitApproval, setGitApproval] = useState<AgentGitApprovalRequest | null>(null);
  const [composerCursor, setComposerCursor] = useState(0);
  const [skillSuggestionIndex, setSkillSuggestionIndex] = useState(0);
  const [skillSuggestionsDismissed, setSkillSuggestionsDismissed] = useState(false);
  const [reasoningEffortOverride, setReasoningEffortOverride] = useState<AgentReasoningEffort>("inherit");
  const [selectedModel, setSelectedModel] = useState<SelectedModel | null>(project.selectedModel ?? null);
  const localMode = Boolean(localAgent);
  const [availableSkills, setAvailableSkills] = useState<SkillSummary[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const draftDecisionRef = useRef<DraftDecision | null>(null);
  const questionDecisionRef = useRef<QuestionDecision | null>(null);
  const gitDecisionRef = useRef<GitDecision | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const followOutputRef = useRef(true);
  const agentSettings = normalizeAgentSettings(project.agent);
  const aiEnabled = localMode || project.model?.enabled !== false;
  const running = runStatus === "running" || runStatus === "waiting_approval" || runStatus === "waiting_user";
  const workspaceRoot = project.workspace?.root;
  const conversationDefaults = (): ConversationDefaults => ({
    pinnedContextOnly: agentSettings.defaultPinnedContextOnly,
    webSearchEnabled: agentSettings.webSearchEnabled,
    knowledgeSearchEnabled: agentSettings.knowledgeToolsEnabled,
    memorySearchEnabled: agentSettings.memoryEnabled,
  });

  useEffect(() => {
    let cancelled = false;
    void discoverSkills(workspaceRoot).then(result => { if (!cancelled) setAvailableSkills(result.skills); }).catch(error => notify(error instanceof Error ? error.message : "Skill 发现失败"));
    return () => { cancelled = true; };
  }, [workspaceRoot]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const loaded = await listAgentConversations(project.id, workspaceRoot);
        if (cancelled) return;
        const preferred = loaded.find(item => item.id === activeId) ?? loaded[0];
        const initial = preferred
          ? (preferred.messagesLoaded ? preferred : await getAgentConversation(preferred.id, workspaceRoot))
          : createAgentConversation(project.id, conversationDefaults());
        if (cancelled) return;
        setConversations(loaded.length ? applyAgentConversationChange(loaded, { projectId: project.id, type: "saved", conversation: initial }) : [initial]);
        setActiveId(initial.id);
      } catch (error) {
        if (!cancelled) notify(error instanceof Error ? error.message : "历史会话加载失败");
      }
    };
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<AgentConversationChange>).detail;
      if (!change || change.projectId !== project.id) return;
      setConversations(current => applyAgentConversationChange(current, change));
      if (change.type === "deleted") setActiveId(current => current === change.conversationId ? "" : current);
      if (change.type === "cleared") setActiveId("");
    };
    void load();
    window.addEventListener(AGENT_CONVERSATIONS_CHANGED, onChanged);
    return () => { cancelled = true; window.removeEventListener(AGENT_CONVERSATIONS_CHANGED, onChanged); };
  }, [project.id, workspaceRoot, agentSettings.defaultPinnedContextOnly, agentSettings.webSearchEnabled, agentSettings.knowledgeToolsEnabled, agentSettings.memoryEnabled]);

  useEffect(() => { if (!draft) setReviewOpen(false); }, [draft]);
  useEffect(() => () => abortRef.current?.abort(), []);
  const active = useMemo(() => conversations.find(item => item.id === activeId) ?? conversations[0], [activeId, conversations]);
  const messages = active?.messages ?? [];
  const pinnedContextOnly = Boolean(active?.pinnedContextOnly && pinnedContext.length > 0);
  const webSearchEnabled = active?.webSearchEnabled === true;
  const knowledgeSearchEnabled = active?.knowledgeSearchEnabled !== false;
  const memorySearchEnabled = active?.memorySearchEnabled === true;
  const agentMode: AgentMode = !localAgent && active?.mode === "plan" ? "plan" : "build";
  const fullAccessEnabled = agentMode === "build" && active?.fullAccessEnabled === true;
  const enabledSkills = resolveEnabledSkills(agentSettings.enabledSkills, availableSkills);
  const slashQuery = skillSuggestionsDismissed ? null : skillSlashQuery(input, composerCursor);
  const skillSuggestions = useMemo(() => slashQuery
    ? fuzzyFilter(enabledSkills.filter(skill => skill.available), slashQuery.query, skill => `${skill.name} ${skill.description}`).slice(0, 7)
    : [], [enabledSkills, slashQuery?.query, slashQuery?.start, skillSuggestionsDismissed]);
  useEffect(() => { setSkillSuggestionIndex(0); }, [slashQuery?.query, slashQuery?.start]);
  useEffect(() => {
    if (!running || !followOutputRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const history = historyRef.current;
      if (history) history.scrollTop = history.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [events, messages.length, running]);

  // 真实「累计上下文」估算 = system prompt（不含摘要） + 工具定义 + 钉住资料 + 历史检查点(summary) + 会话消息。
  // 与运行期自动压缩（compactAgentRunContext）使用同一套 estimate，使 meter 数字 / 阈值警告与真实发送量一致。
  const systemPromptTokens = useMemo(
    () => estimateAgentTextTokens(buildAgentSystemPromptParts({
      agentSettings, enabledSkills, webSearchEnabled, knowledgeSearchEnabled, memorySearchEnabled,
      pinnedContextOnly, fullAccessEnabled,
      mode: agentMode,
      capturedSelection: editorSelection,
    }).join("\n\n")),
    [agentSettings, enabledSkills, webSearchEnabled, knowledgeSearchEnabled, memorySearchEnabled, pinnedContextOnly, fullAccessEnabled, agentMode, editorSelection],
  );
  // 工具定义为常量开销：构造注册表仅读取 definitions（execute 不会在构造期被调用），失败时回退 0。
  // 用签名隔离依赖，避免 agentSettings 每次渲染都重建注册表（只在影响工具集的开关变化时重算）。
  const toolSignature = JSON.stringify([
    fullAccessEnabled, knowledgeSearchEnabled, memorySearchEnabled, webSearchEnabled,
    agentMode,
    agentSettings.disabledTools, enabledSkills.map(skill => skill.name),
  ]);
  const toolContextTokens = useMemo(() => {
    try {
      const registry = createProposalToolRegistry({
        project, modelConfig: undefined, block, selection: undefined,
        reviewDraft: () => true, onTodos: () => {}, askUser: undefined,
        fullAccess: fullAccessEnabled, workspaceRuntime, gitRuntime: undefined,
        reviewGitOperation: async () => true, onDocumentSearch: () => {},
      });
      applyAgentModeTools(registry, agentMode);
      return estimateAgentTextTokens(JSON.stringify(registry.definitions()));
    } catch { return 0; }
  }, [toolSignature, project, block, workspaceRuntime]);
  const pinnedContextTokens = useMemo(() => estimateAgentTextTokens(pinnedContext.map(item => item.content).join("\n\n")), [pinnedContext]);
  const contextThreshold = agentSettings.contextCompressionTokens;
  const summaryTokens = useMemo(() => estimateAgentTextTokens(active?.summary ?? ""), [active?.summary]);
  const contextTokens = useMemo(
    () => systemPromptTokens + toolContextTokens + pinnedContextTokens + summaryTokens + estimateAgentContextTokens(messages, []),
    [systemPromptTokens, toolContextTokens, pinnedContextTokens, summaryTokens, messages],
  );
  const contextPct = contextThreshold > 0 ? Math.min(100, Math.max(1, Math.round((contextTokens / contextThreshold) * 100))) : 0;
  const contextMessageCount = agentConversationMessageCount(active);
  const minKeepMessages = Math.max(4, Math.round(agentSettings.recentMessages));
  const canCompact = !running && messages.length > minKeepMessages;
  const pendingDraftCopy = draft ? draftCopy(draft) : null;
  const pendingRevisedContent = draft?.operation === "move_section" ? draft.target.destinationSnapshot ?? "" : draft?.after ?? "";

  const activateConversation = async (next: AgentConversation) => {
    try {
      const resolved = next.messagesLoaded ? next : await getAgentConversation(next.id, workspaceRoot);
      setConversations(current => applyAgentConversationChange(current, { projectId: project.id, type: "saved", conversation: resolved }));
      setActiveId(resolved.id);
      setEvents([]);
      setDraft(null);
      const restored = latestTodosFromMessages(resolved.messages);
      setTodos(restored);
      setTodosCollapsed(restored.length > 0 && restored.every(todo => todo.status === "completed"));
    } catch (error) {
      notify(error instanceof Error ? error.message : "会话加载失败");
    }
  };

  useEffect(() => {
    const restored = latestTodosFromMessages(active?.messages ?? []);
    setTodos(restored);
    setTodosCollapsed(restored.length > 0 && restored.every(todo => todo.status === "completed"));
  }, [activeId, project.id]);

  const commitConversation = async (conversation: AgentConversation) => {
    const saved = await saveAgentConversation(conversation, workspaceRoot);
    setActiveId(saved.id);
    return saved;
  };

  // 主动压缩：复用本地结构化检查点（buildAgentCheckpoint，无需调用 LLM，免费且即时）。
  // 预算感知——与运行期自动压缩同一口径：把固定开销（system + 工具 + 钉住资料）计入预算，
  // 逐步减少保留条数，确保压完后累计上下文真正回落到阈值以内，而非只按消息条数裁剪。
  const manualCompact = async () => {
    if (!active || !canCompact) return;
    const before = contextTokens;
    const compacted = compactAgentConversationToBudget(active, {
      keepRecent: agentSettings.recentMessages,
      thresholdTokens: agentSettings.contextCompressionTokens,
      fixedOverheadTokens: systemPromptTokens + toolContextTokens + pinnedContextTokens,
    });
    if (compacted === active) { notify("当前上下文较短，暂无需压缩"); return; }
    try {
      const saved = await saveAgentConversation(compacted, workspaceRoot);
      setConversations(current => applyAgentConversationChange(current, { projectId: project.id, type: "saved", conversation: saved }));
      const afterSummary = estimateAgentTextTokens(saved.summary ?? "");
      const after = systemPromptTokens + toolContextTokens + pinnedContextTokens + afterSummary + estimateAgentContextTokens(saved.messages, []);
      const removed = messages.length - saved.messages.length;
      setEvents(current => [...current, { id: crypto.randomUUID(), type: "context_compacted", at: Date.now(), round: -1, beforeTokens: before, afterTokens: after, removedMessages: removed }]);
      notify(`已主动压缩上下文：${before.toLocaleString()} → ${after.toLocaleString()} tokens（移除 ${removed} 条较早消息）`);
    } catch (error) {
      notify(`上下文压缩失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const createConversation = () => {
    if (running) return;
    // 新建会话先只放进内存，不立即落盘——
    // 只有用户真正发送消息（产生对话）后才会在 commitConversation 中持久化。
    // 这样“新建后未发送消息”的空会话就不会被保留在历史里。
    const created = createAgentConversation(project.id, conversationDefaults());
    void activateConversation(created);
  };

  const removeConversation = () => {
    if (!active || running) return;
    void (async () => {
      try {
        const remaining = conversations.filter(item => item.id !== active.id);
        await deleteAgentConversation(active.id, project.id, workspaceRoot);
        const next = remaining[0] ?? createAgentConversation(project.id, conversationDefaults());
        if (!remaining.length) setConversations([next]);
        await activateConversation(next);
      } catch (error) {
        notify(error instanceof Error ? error.message : "删除会话失败");
      }
    })();
  };
  const updateActiveConversationRuntime = (patch: AgentConversationPatch) => {
    if (!active) return;
    const previous = active;
    setConversations(current => current.map(item => item.id === active.id ? { ...item, ...patch } : item));
    // 空会话（0 条对话消息）不落盘：避免用户只是切换开关就生成一个无内容的空记录。
    if (!agentConversationMessageCount(active)) return;
    if ((active.revision ?? 0) === 0) {
      void saveAgentConversation({ ...active, ...patch }, workspaceRoot)
        .then(saved => setConversations(current => applyAgentConversationChange(current, { projectId: project.id, type: "saved", conversation: saved })))
        .catch(error => {
          setConversations(current => current.map(item => item.id === previous.id ? previous : item));
          notify(error instanceof Error ? error.message : "会话设置保存失败");
        });
      return;
    }
    void patchAgentConversation(active, patch, workspaceRoot)
      .then(saved => setConversations(current => applyAgentConversationChange(current, {
        projectId: project.id,
        type: "saved",
        conversation: saved,
      })))
      .catch(error => {
        setConversations(current => current.map(item => item.id === previous.id ? previous : item));
        notify(error instanceof Error ? error.message : "会话设置保存失败");
      });
  };
  const setPinnedContextOnly = (value: boolean) => updateActiveConversationRuntime({ pinnedContextOnly: value });
  const setWebSearchEnabled = (value: boolean) => updateActiveConversationRuntime({ webSearchEnabled: value });
  const setKnowledgeSearchEnabled = (value: boolean) => updateActiveConversationRuntime({ knowledgeSearchEnabled: value });
  const setMemorySearchEnabled = (value: boolean) => updateActiveConversationRuntime({ memorySearchEnabled: value });
  const setAgentMode = (mode: AgentMode) => updateActiveConversationRuntime({ mode });
  const setFullAccessEnabled = (value: boolean) => {
    if (!active) return;
    if (!value) return updateActiveConversationRuntime({ fullAccessEnabled: false });
    if (active.fullAccessAcknowledged) return updateActiveConversationRuntime({ fullAccessEnabled: true });
    const accepted = window.confirm("完全访问将允许 AI 无需逐项确认即可修改文档、访问任意系统路径、永久删除文件并执行任意 PowerShell 命令。\n\n这些操作可能无法恢复。仅在你信任当前任务和模型时开启。是否继续？");
    if (accepted) updateActiveConversationRuntime({ fullAccessEnabled: true, fullAccessAcknowledged: true });
  };
  const chooseSkillSuggestion = (skill: SkillSummary) => {
    if (!slashQuery) return;
    const next = applySkillSlashSelection(input, slashQuery, skill.name);
    setInput(next.text);
    setComposerCursor(next.cursor);
    setSkillSuggestionsDismissed(true);
    requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(next.cursor, next.cursor); });
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
    followOutputRef.current = true;
    decision.resolve(approved);
  };
  const reviewDraft = (nextDraft: AgentDraft, signal: AbortSignal) => {
    if (fullAccessEnabled) {
      applyDraft(nextDraft);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve, reject) => {
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
  };

  const askUser = (question: AgentUserQuestion, signal: AbortSignal) => new Promise<AgentUserQuestionAnswer>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      if (questionDecisionRef.current?.resolve === resolve) questionDecisionRef.current = null;
      setUserQuestion(null);
      reject(new DOMException("Agent 任务已取消", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    questionDecisionRef.current = { resolve, cleanup };
    signal.addEventListener("abort", onAbort, { once: true });
    setQuestionChoice("A");
    setCustomAnswer("");
    setUserQuestion(question);
    setRunStatus("waiting_user");
  });

  const submitUserAnswer = () => {
    const decision = questionDecisionRef.current;
    if (!decision || (questionChoice === "D" && !customAnswer.trim())) return;
    const selected = userQuestion?.options.find(option => option.choice === questionChoice);
    decision.cleanup();
    questionDecisionRef.current = null;
    setUserQuestion(null);
    setRunStatus("running");
    decision.resolve({ choice: questionChoice, answer: questionChoice === "D" ? customAnswer.trim() : selected?.overview ?? "" });
  };

  const reviewGitOperation = (request: AgentGitApprovalRequest, signal: AbortSignal) => new Promise<boolean>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      if (gitDecisionRef.current?.resolve === resolve) gitDecisionRef.current = null;
      setGitApproval(null);
      reject(new DOMException("Agent 任务已取消", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    gitDecisionRef.current = { resolve, cleanup };
    signal.addEventListener("abort", onAbort, { once: true });
    setGitApproval(request);
    setRunStatus("waiting_approval");
  });

  const settleGitApproval = (approved: boolean) => {
    const decision = gitDecisionRef.current;
    if (!decision) return;
    decision.cleanup();
    gitDecisionRef.current = null;
    setGitApproval(null);
    setRunStatus("running");
    decision.resolve(approved);
  };

  const rejectDraft = () => { setReviewOpen(false); setDraft(null); settleDraft(false); };
  const acceptDraft = () => {
    if (!draft) return;
    try {
      applyDraft(draft);
      setReviewOpen(false);
      setDraft(null);
      settleDraft(true);
      notify("Agent 编辑提案已应用");
    } catch (error) {
      setReviewOpen(false);
      setDraft(null);
      settleDraft(false);
      notify(error instanceof Error ? error.message : "提案应用失败");
    }
  };


  const send = async () => {
    const task = input.trim();
    if (!task || !active) return;
    const capturedSelection = editorSelection;
    let chain: ResolvedModelConfig[] = [];
    if (!localAgent) {
      try {
        chain = resolveModelConfigChain(project.providers ?? [], selectedModel, project.fallbackModels, { aiEnabled });
      } catch (e: any) {
        notify(e?.message ?? "模型未配置");
        return;
      }
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
    setConversations(current => {
      const remaining = current.filter(item => item.id !== pendingConversation.id);
      return [pendingConversation, ...remaining];
    });
    try {
    const gitRuntime: AgentGitRuntime | undefined = workspaceRoot ? {
      status: () => getGitStatus(workspaceRoot),
      diff: (path, staged) => getGitDiff(workspaceRoot, path, staged),
      log: limit => getGitLog(workspaceRoot, limit),
      showCommit: commit => getGitCommitDiff(workspaceRoot, commit),
      branches: () => getGitBranches(workspaceRoot),
      stage: path => path ? stageGitFile(workspaceRoot, path) : stageAllGitFiles(workspaceRoot),
      unstage: path => path ? unstageGitFile(workspaceRoot, path) : unstageAllGitFiles(workspaceRoot),
      commit: message => commitGitChanges(workspaceRoot, message),
      createBranch: branch => createGitBranch(workspaceRoot, branch),
      switchBranch: branch => switchGitBranch(workspaceRoot, branch),
      stashPush: () => stashGitChanges(workspaceRoot),
      stashPop: () => popGitStash(workspaceRoot),
      fetch: () => fetchGitRepository(workspaceRoot),
      pull: () => pullGitRepository(workspaceRoot),
      push: () => pushGitRepository(workspaceRoot),
      changed: () => window.dispatchEvent(new CustomEvent(AGENT_GIT_CHANGED, { detail: { root: workspaceRoot } })),
    } : undefined;
    const promptParts = buildAgentSystemPromptParts({
      agentSettings,
      enabledSkills,
      webSearchEnabled,
      knowledgeSearchEnabled,
      memorySearchEnabled,
      pinnedContextOnly,
      fullAccessEnabled,
      mode: agentMode,
      capturedSelection,
    });
    const memories = memorySearchEnabled ? await listProjectMemories(project, false) : [];
    const requestMessages = buildProposalAgentMessages({
      systemPrompt: promptParts.join("\n\n"),
      conversation: active,
      pinnedContext,
      pinnedContextChars: agentSettings.pinnedContextChars,
      memoryEnabled: memorySearchEnabled,
      memories,
      memoryIndexLimit: agentSettings.memoryIndexLimit,
    });
    const localCompletion = localAgent
      ? createCliAgentCompletion(localAgent.connection, workspaceRoot || ".", fullAccessEnabled, { currentBlock: block, selection: capturedSelection })
      : undefined;
    const runWithConfig = async (activeConfig: ResolvedModelConfig) => {
      const registry = createProposalToolRegistry({ project, modelConfig: activeConfig, block, selection: capturedSelection, reviewDraft, askUser, fullAccess: fullAccessEnabled, workspaceRuntime, gitRuntime, reviewGitOperation, onDocumentSearch, completion: localCompletion, onTodos: nextTodos => { setTodos(nextTodos); setTodosCollapsed(false); } });
      registerSkillTools(registry, {
        skills: enabledSkills,
        workspaceRoot,
        fullAccess: fullAccessEnabled,
        networkAccess: webSearchEnabled,
      });
      for (const toolName of agentSettings.disabledTools) {
        if (agentMode !== "plan" || toolName !== "write_todo") registry.unregister(toolName);
      }
      if (!webSearchEnabled) registry.unregister("web_search").unregister("read_web_page");
      if (pinnedContextOnly || !knowledgeSearchEnabled) registry.unregister("search_knowledge").unregister("read_knowledge");
      if (!memorySearchEnabled) registry.unregister("search_memory").unregister("read_memory").unregister("remember_project_fact");
      else if (!agentSettings.autoRemember) registry.unregister("remember_project_fact");
      applyAgentModeTools(registry, agentMode);
      if (localAgent) {
        // 本地 CLI 只负责提出一次修改提案；应用 Runner 负责校验、预览和写入。
        // 这样既保留文档编写能力，也避免不稳定的 CLI 反复读取、搜索或执行系统工具。
        for (const definition of registry.definitions()) {
          if (!definition.function.name.startsWith("propose_")) registry.unregister(definition.function.name);
        }
      }
      return await runProposalAgent({
        task,
        messages: requestMessages,
        config: activeConfig,
        registry,
        signal: controller.signal,
        onEvent: event => setEvents(current => [...current, event]),
        contextCompressionTokens: agentSettings.contextCompressionTokens,
        temperature: agentSettings.temperature,
        reasoningEffort: reasoningEffortOverride === "inherit" ? undefined : reasoningEffortOverride,
        maxRounds: agentSettings.maxRounds,
        maxToolCalls: localAgent ? 1 : undefined,
        stopOnUnavailableTools: Boolean(localAgent),
        completion: localCompletion,
      });
    };
    const result = localAgent
      ? await runWithConfig({ providerId: `local-${localAgent.connection.provider}`, providerName: cliAgentProviderMeta[localAgent.connection.provider].label, protocol: "openai-completions", baseUrl: "", apiKey: "", model: localAgent.connection.model || `${localAgent.connection.provider}:default`, timeoutMs: 300_000, headers: {}, enabled: true })
      : await runWithModelFallback(chain, runWithConfig, {
        onSwitch: (_, from, to) => {
          notify(`主模型 ${from.model} 不可用，已自动切换到 ${to.model}`);
        },
      });
      const runtimeMessages = result.messages.slice(1);
      const completedConversation = { ...pendingConversation, messages: runtimeMessages };
      setConversations(current => applyAgentConversationChange(current, {
        projectId: project.id,
        type: "saved",
        conversation: completedConversation,
      }));
      setEvents([]);
      setRunStatus(result.status);
      setTodosCollapsed(result.status === "completed");
      if (result.status === "round_limit_reached") notify(`Agent 已达到 ${agentSettings.maxRounds} 轮执行上限`);
      try {
        await commitConversation(completedConversation);
      } catch (saveError) {
        notify(`AI 回复已保留在当前会话，但写入会话文件失败：${saveError instanceof Error ? saveError.message : String(saveError)}`);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") setRunStatus("cancelled");
      else { setRunStatus("failed"); notify(error instanceof Error ? error.message : "Agent 执行失败"); }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  return <div className="inspector-content agent-chat-panel">
    <header className="agent-chat-head">
      <select value={active?.id ?? ""} onChange={event => { const next = conversations.find(item => item.id === event.target.value); if (next) void activateConversation(next); }} disabled={running} aria-label="Agent 会话">
        {conversations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <button type="button" title="新建会话" onClick={createConversation} disabled={running}><MessageSquarePlus size={15} /></button>
      <button type="button" title="删除当前会话" onClick={removeConversation} disabled={running}><Trash2 size={14} /></button>
    </header>

    {localAgent ? <>
      <div className="agent-local-runtime-head">
        <label className="agent-local-provider-select">
          <span>引擎</span>
          <select value={localAgent.connection.provider} onChange={event => localAgent.onConnectionChange({ ...localAgent.connection, provider: event.target.value as CliAgentProvider })} disabled={running || localAgent.runtimeBusy}>
            {(Object.keys(cliAgentProviderMeta) as CliAgentProvider[]).map(provider => <option key={provider} value={provider}>{cliAgentProviderMeta[provider].label}</option>)}
          </select>
        </label>
        <div className="agent-runtime-actions" aria-label="本地 Agent 状态控制">
          <span className={`agent-runtime-dot ${localAgent.runtimeStatus?.phase ?? "unknown"}`} />
          <span>{cliAgentRuntimeLabel(localAgent.runtimeStatus?.phase ?? "unknown")}</span>
          <button type="button" onClick={localAgent.onRefreshRuntime} disabled={running || localAgent.runtimeBusy} title="重新检测">重新检测</button>
        </div>
      </div>
      <label className="agent-model-select">
        <span>模型</span>
        <OpenCodeModelSelect
          models={localAgent.models ?? defaultCliAgentModels[localAgent.connection.provider]}
          value={((): OpenCodeModelRef | null => {
            const selected = resolveCliAgentModelOption(localAgent.models ?? defaultCliAgentModels[localAgent.connection.provider], localAgent.connection.model);
            return selected ? { providerId: selected.providerId, modelId: selected.modelId } : null;
          })()}
          onChange={(model: OpenCodeModelRef | null) => {
            const nextModel = !model || model.modelId === "__default__"
              ? ""
              : localAgent.connection.provider === "opencode"
                ? `${model.providerId}/${model.modelId}`
                : model.modelId;
            localAgent.onConnectionChange({ ...localAgent.connection, model: nextModel });
          }}
          disabled={running || localAgent.runtimeBusy}
        />
      </label>
    </> : <>
      <label className="agent-model-select">
        <span>模型</span>
        <ModelSelect providers={project.providers ?? []} value={selectedModel} onChange={setSelectedModel} disabled={running || !aiEnabled} />
      </label>
      {!aiEnabled && <small className="model-list-error">联网模型已关闭，请先在设置中启用。</small>}
    </>}

    <AgentTodoPlan todos={todos} collapsed={todosCollapsed} toggle={() => setTodosCollapsed(value => !value)} />

    <div ref={historyRef} className="agent-chat-history" aria-live="polite" onScroll={event => {
      const element = event.currentTarget;
      followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    }}>
      {!messages.length && <div className="agent-chat-empty"><Bot size={24} /><b>开始方案对话</b><span>{pinnedContext.length ? `已附加 ${pinnedContext.length} 份上下文` : "可直接提问，也可先在资料页加入上下文"}</span></div>}
      <AgentConversationTimeline messages={messages} events={events} running={running} />
    </div>

    {draft && <section className="agent-draft">
      <header><div><FileSearch size={15} /><span>{pendingDraftCopy?.title}</span></div><small>{draft.instruction}</small></header>
      <div className="agent-diff-stats"><span className="removed">原文 {draft.before.length.toLocaleString()} 字</span><span className="added">修改后 {pendingRevisedContent.length.toLocaleString()} 字</span></div>
      <div className="agent-draft-compare">
        <section className="original">
          <div><b>{pendingDraftCopy?.before}</b><span>{draft.before.length.toLocaleString()} 字</span></div>
          <pre>{draft.before || (draft.operation === "insert_section" ? `将在「${draft.target.sectionTitle ?? "目标章节"}」${draft.target.position === "before" ? "之前" : "之后"}插入` : "（当前内容为空）")}</pre>
        </section>
        <section className="revised">
          <div><b>{pendingDraftCopy?.after}</b><span>{pendingRevisedContent.length.toLocaleString()} 字</span></div>
          <pre>{pendingRevisedContent || "（整个章节将被删除）"}</pre>
        </section>
      </div>
      <div><button type="button" onClick={() => setReviewOpen(true)}><Maximize2 size={13} />放大审核</button><button type="button" onClick={rejectDraft}>拒绝</button><button type="button" className="primary" onClick={acceptDraft}><Check size={13} />接受修改</button></div>
    </section>}

    {userQuestion && <section className="agent-user-question" aria-label="Agent 向用户提问">
      <header><b>需要你补充上下文</b><span>{userQuestion.question}</span></header>
      <div className="agent-question-options">
        {userQuestion.options.map(option => <label key={option.choice} className={questionChoice === option.choice ? "selected" : ""}>
          <input type="radio" name="agent-user-question" checked={questionChoice === option.choice} onChange={() => setQuestionChoice(option.choice)} />
          <strong><i>{option.choice}</i>{option.title}{option.recommended && <small>推荐</small>}</strong>
          <span>{option.overview}</span>
        </label>)}
        <label className={questionChoice === "D" ? "selected custom" : "custom"}>
          <input type="radio" name="agent-user-question" checked={questionChoice === "D"} onChange={() => setQuestionChoice("D")} />
          <strong><i>D</i>用户输入</strong>
          <textarea value={customAnswer} onFocus={() => setQuestionChoice("D")} onChange={event => setCustomAnswer(event.target.value)} placeholder="输入你的方案或补充说明" />
        </label>
      </div>
      <button type="button" className="primary" onClick={submitUserAnswer} disabled={questionChoice === "D" && !customAnswer.trim()}><Check size={13} />提交选择</button>
    </section>}

    {gitApproval && <section className="agent-git-approval" aria-label="Git 操作审批">
      <header><GitBranch size={15} /><div><b>{gitApproval.title}</b><span>{gitApproval.description}</span></div></header>
      {gitApproval.details.length > 0 && <dl>{gitApproval.details.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
      <p>该操作将改变当前工作区或远程仓库状态。</p>
      <div><button type="button" onClick={() => settleGitApproval(false)}>拒绝</button><button type="button" className="primary" onClick={() => settleGitApproval(true)}><Check size={13} />批准执行</button></div>
    </section>}

    <div className="agent-tool-toggles">
      {!localAgent && <div className="agent-mode-switch" role="group" aria-label="Agent 模式">
        <button type="button" className={agentMode === "plan" ? "active" : ""} disabled={running} onClick={() => setAgentMode("plan")} title="Plan：只读分析并强制先制定计划"><ListTree size={13} />Plan</button>
        <button type="button" className={agentMode === "build" ? "active" : ""} disabled={running} onClick={() => setAgentMode("build")} title="Build：直接执行，不调用任务规划"><Hammer size={13} />Build</button>
      </div>}
      <button
        type="button"
        className={`agent-compact-toggle agent-reasoning-effort effort-${reasoningEffortOverride}`}
        disabled={running}
        onClick={() => setReasoningEffortOverride(current => nextAgentReasoningEffort(current))}
        title={`思考等级：${agentReasoningEffortLabel(reasoningEffortOverride)}。点击切换为 ${agentReasoningEffortLabel(nextAgentReasoningEffort(reasoningEffortOverride))}`}
        aria-label={`思考等级：${agentReasoningEffortLabel(reasoningEffortOverride)}，点击切换`}
      >
        <BrainCircuit size={14} />
        <small>{AGENT_REASONING_EFFORT_SHORT_LABELS[reasoningEffortOverride]}</small>
      </button>
      {!localAgent && <label className={`agent-compact-toggle ${memorySearchEnabled ? "active" : ""}`} title={memorySearchEnabled ? "引用记忆：已启用（点击关闭）" : "引用记忆：已关闭（点击启用）"} aria-label="引用记忆">
        <input type="checkbox" checked={memorySearchEnabled} disabled={running} onChange={event => setMemorySearchEnabled(event.target.checked)} />
        <Brain size={14} />
      </label>}
      {!localAgent && <label className={`agent-compact-toggle ${knowledgeSearchEnabled ? "active" : ""}`} title={knowledgeSearchEnabled ? "知识检索：已启用（点击关闭）" : "知识检索：已关闭（点击启用）"} aria-label="知识检索">
        <input type="checkbox" checked={knowledgeSearchEnabled} disabled={running || pinnedContextOnly} onChange={event => setKnowledgeSearchEnabled(event.target.checked)} />
        <Database size={14} />
      </label>}
      {!localAgent && <label className={`agent-compact-toggle ${webSearchEnabled ? "active" : ""}`} title={webSearchEnabled ? "联网搜索：已启用（点击关闭）" : "联网搜索：已关闭（点击启用）"} aria-label="联网搜索">
        <input type="checkbox" checked={webSearchEnabled} disabled={running} onChange={event => setWebSearchEnabled(event.target.checked)} />
        <Globe2 size={14} />
      </label>}
      <label className={`agent-compact-toggle ${pinnedContextOnly ? "active" : ""}`} title={`仅使用已引用资料，共 ${pinnedContext.length} 条`} aria-label={`仅使用已引用资料，共 ${pinnedContext.length} 条`}>
        <input type="checkbox" checked={pinnedContextOnly} disabled={!pinnedContext.length || running} onChange={event => setPinnedContextOnly(event.target.checked)} />
        <BookOpen size={14} /><small>{pinnedContext.length}</small>
      </label>
      {!localAgent && <label className={`agent-compact-toggle agent-full-access ${fullAccessEnabled ? "active" : ""}`} title={agentMode === "plan" ? "Plan 模式始终只读" : "完全访问：允许 Agent 无需逐项确认执行文档、文件和系统命令操作"} aria-label="完全访问">
        <input type="checkbox" checked={fullAccessEnabled} disabled={running || agentMode === "plan"} onChange={event => setFullAccessEnabled(event.target.checked)} />
        <ShieldAlert size={14} />
      </label>}
    </div>
    {fullAccessEnabled && <div className="agent-full-access-status" role="status">
      <ShieldAlert size={15} />
      <span><b>完全访问已开启</b><small>修改将直接执行，并在对话中显示修改前后对比</small></span>
    </div>}
    {editorSelection && <div className="agent-selection-capture" title={editorSelection.text}>
      <span><FileSearch size={13} /><b>已捕获选区</b><small>{editorSelection.text.length.toLocaleString()} 字 · {editorSelection.sectionTitle ?? (editorSelection.scope === "document" ? "全文" : "当前章节")}</small></span>
      <button type="button" title="清除已捕获选区" onClick={clearEditorSelection} disabled={running}><X size={13} /></button>
    </div>}
    <div className="agent-chat-composer">
      {slashQuery && skillSuggestions.length > 0 && <div className="agent-skill-suggestions" role="listbox" aria-label="Skill 建议">
        {skillSuggestions.map((skill, index) => <button type="button" role="option" aria-selected={index === skillSuggestionIndex} className={index === skillSuggestionIndex ? "selected" : ""} key={`${skill.scope}:${skill.name}`} onMouseDown={event => { event.preventDefault(); chooseSkillSuggestion(skill); }}>
          <Sparkles size={14} /><span><b>/{skill.name}</b><small>{skill.description}</small></span>{enabledSkills.some(item => item.name === skill.name && item.scope === skill.scope) && <Check size={13} />}
        </button>)}
        <footer><span>↑↓ 选择</span><span>Enter 插入</span><span>Esc 关闭</span></footer>
      </div>}
      <textarea ref={composerRef} value={input} onSelect={event => setComposerCursor(event.currentTarget.selectionStart)} onChange={event => { setInput(event.target.value); setComposerCursor(event.target.selectionStart); setSkillSuggestionsDismissed(false); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (skillSuggestions.length) {
          if (event.key === "ArrowDown") { event.preventDefault(); setSkillSuggestionIndex(index => (index + 1) % skillSuggestions.length); return; }
          if (event.key === "ArrowUp") { event.preventDefault(); setSkillSuggestionIndex(index => (index - 1 + skillSuggestions.length) % skillSuggestions.length); return; }
          if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); chooseSkillSuggestion(skillSuggestions[skillSuggestionIndex] ?? skillSuggestions[0]); return; }
          if (event.key === "Escape") { event.preventDefault(); setSkillSuggestionsDismissed(true); return; }
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
      }} placeholder="输入消息，Enter 发送，Shift+Enter 换行" disabled={running} />
      {running
        ? <button type="button" title="停止" className="agent-stop" onClick={stopRun}><Square size={14} /></button>
        : <button type="button" title="发送" className="primary" onClick={() => void send()} disabled={!input.trim()}><Send size={15} /></button>}
    </div>
    <button type="button" className={`agent-context-meter ${contextPct >= 85 ? "critical" : contextPct >= 60 ? "warning" : ""} ${canCompact ? "compactable" : ""}`} onClick={manualCompact} disabled={!canCompact} title={canCompact ? `当前累计上下文约 ${contextTokens.toLocaleString()} tokens（压缩阈值 ${contextThreshold.toLocaleString()}）。点击主动压缩：将较早消息汇总为结构化检查点，按 token 预算保留近期消息，使总量回落到阈值以内` : `当前累计上下文较短（约 ${contextTokens.toLocaleString()} tokens），暂无需压缩`}>
      <Gauge size={13} />
      <span className="agent-context-meter-value">{contextTokens >= 1000 ? `${(contextTokens / 1000).toFixed(1)}k` : contextTokens} tokens</span>
      <small>{contextMessageCount} 条</small>
      <span className="agent-context-meter-bar" aria-hidden="true"><i style={{ width: `${contextPct}%` }} /></span>
      {canCompact && <Archive size={13} className="agent-context-meter-action" />}
    </button>
    {draft && reviewOpen && <AgentDraftReviewModal draft={draft} close={() => setReviewOpen(false)} reject={rejectDraft} accept={acceptDraft} />}
  </div>;
}
