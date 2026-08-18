import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isDesktop } from "../services/runtime";
import type { AgentMessage } from "./protocol";
import { persistentAgentMessages, safeTurnSplitIndex } from "./messageUtils";
import { buildAgentCheckpoint, estimateAgentContextTokens, estimateAgentTextTokens } from "./contextCompaction";

const KEY = "tech-proposal-studio.agent-conversations.v1";
const TAURI_CHANGE_EVENT = "agent-conversations:changed";
export const AGENT_CONVERSATIONS_CHANGED = "tech-proposal-studio:agent-conversations-changed";

const browserWriteQueues = new Map<string, Promise<void>>();
let desktopBridge: Promise<() => void> | null = null;

export interface AgentConversation {
  id: string;
  projectId: string;
  title: string;
  messages: AgentMessage[];
  summary: string;
  /** Agent execution policy for this conversation. Legacy conversations default to build. */
  mode?: AgentMode;
  pinnedContextOnly?: boolean;
  webSearchEnabled?: boolean;
  knowledgeSearchEnabled?: boolean;
  /** 本会话是否引用长期记忆（发送框上方的开关）；默认由 agent.memoryEnabled 决定。 */
  memorySearchEnabled?: boolean;
  fullAccessEnabled?: boolean;
  fullAccessAcknowledged?: boolean;
  createdAt: number;
  updatedAt: number;
  revision?: number;
  messagesLoaded?: boolean;
  messageCount?: number;
  lastMessagePreview?: string;
}

export type AgentMode = "plan" | "build";

export type AgentConversationPatch = Partial<Pick<AgentConversation, "title" | "mode" | "pinnedContextOnly" | "webSearchEnabled" | "knowledgeSearchEnabled" | "memorySearchEnabled" | "fullAccessEnabled" | "fullAccessAcknowledged">>;

export type AgentConversationChange =
  | { projectId: string; type: "saved"; conversation: AgentConversation }
  | { projectId: string; type: "deleted"; conversationId: string }
  | { projectId: string; type: "cleared" };

export function applyAgentConversationChange(current: AgentConversation[], change: AgentConversationChange): AgentConversation[] {
  if (change.type === "cleared") return current.filter(item => item.projectId !== change.projectId);
  if (change.type === "deleted") return current.filter(item => item.id !== change.conversationId);
  const existing = current.find(item => item.id === change.conversation.id);
  const conversation = !change.conversation.messagesLoaded && existing?.messagesLoaded
    ? { ...change.conversation, messages: existing.messages, messagesLoaded: true }
    : change.conversation;
  return [conversation, ...current.filter(item => item.id !== conversation.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function notifyChanged(change: AgentConversationChange) {
  window.dispatchEvent(new CustomEvent(AGENT_CONVERSATIONS_CHANGED, { detail: change }));
}

function ensureDesktopBridge() {
  if (!isDesktop() || desktopBridge) return;
  desktopBridge = listen<AgentConversationChange>(TAURI_CHANGE_EVENT, event => notifyChanged(event.payload));
  void desktopBridge.catch(() => { desktopBridge = null; });
}

function parseConversations(raw: string | null): AgentConversation[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed
      .filter(item => item && typeof item.id === "string" && typeof item.projectId === "string")
      .map(item => ({ ...item, mode: item.mode === "plan" ? "plan" : "build" })) : [];
  } catch {
    return [];
  }
}

function readLocal(): AgentConversation[] {
  return parseConversations(localStorage.getItem(KEY));
}

function writeLocal(conversations: AgentConversation[]) {
  localStorage.setItem(KEY, JSON.stringify(conversations));
}

function withBrowserWriteLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = browserWriteQueues.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const tail = next.then(() => undefined, () => undefined);
  browserWriteQueues.set(projectId, tail);
  return next.finally(() => {
    if (browserWriteQueues.get(projectId) === tail) browserWriteQueues.delete(projectId);
  });
}

async function resolveDesktopWorkspaceRoot(workspaceRoot?: string): Promise<string> {
  const root = workspaceRoot?.trim();
  if (root) return root;
  // 工作目录尚未就绪时，回退到应用默认工作目录，避免“每次打开都丢失历史会话”。
  try {
    const { getDefaultWorkspaceRoot } = await import("../features/workspace/workspace");
    const fallback = await getDefaultWorkspaceRoot();
    const trimmed = fallback?.trim();
    if (trimmed) return trimmed;
  } catch {
    // 忽略，落到下面的错误
  }
  throw new Error("工作目录不能为空");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

async function upsertDesktopConversation(conversation: AgentConversation, workspaceRoot?: string): Promise<AgentConversation> {
  const root = await resolveDesktopWorkspaceRoot(workspaceRoot);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await invoke<AgentConversation>("agent_conversation_upsert", { workspaceRoot: root, conversation });
    } catch (error) {
      const message = errorText(error);
      if ((message.includes("database is locked") || message.includes("database is busy")) && attempt < 2) {
        await wait(75 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw new Error("保存会话失败");
}

export async function listAgentConversations(projectId: string, workspaceRoot?: string): Promise<AgentConversation[]> {
  if (isDesktop()) {
    ensureDesktopBridge();
    const root = await resolveDesktopWorkspaceRoot(workspaceRoot);
    return invoke<AgentConversation[]>("agent_conversation_list", { workspaceRoot: root, projectId });
  }
  return readLocal().filter(item => item.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getAgentConversation(conversationId: string, workspaceRoot?: string): Promise<AgentConversation> {
  if (isDesktop()) {
    ensureDesktopBridge();
    const root = await resolveDesktopWorkspaceRoot(workspaceRoot);
    return invoke<AgentConversation>("agent_conversation_get", { workspaceRoot: root, id: conversationId });
  }
  const conversation = readLocal().find(item => item.id === conversationId);
  if (!conversation) throw new Error("会话不存在");
  return { ...conversation, messagesLoaded: true };
}

export function agentConversationMessageCount(conversation: AgentConversation | null | undefined): number {
  if (!conversation) return 0;
  return conversation.messageCount ?? conversation.messages.filter(item => item.role === "user" || item.role === "assistant").length;
}

export interface ConversationDefaults {
  /** 新会话默认仅使用已引用资料。 */
  pinnedContextOnly?: boolean;
  /** 新会话默认是否启用联网搜索。 */
  webSearchEnabled?: boolean;
  /** 新会话默认是否启用知识库检索。 */
  knowledgeSearchEnabled?: boolean;
  /** 新会话默认是否引用长期记忆。 */
  memorySearchEnabled?: boolean;
}

export function createAgentConversation(projectId: string, defaults: ConversationDefaults = {}): AgentConversation {
  const {
    pinnedContextOnly = false,
    webSearchEnabled = false,
    knowledgeSearchEnabled = false,
    memorySearchEnabled = false,
  } = defaults;
  const now = Date.now();
  return { id: crypto.randomUUID(), projectId, title: "新会话", messages: [], summary: "", mode: "build", pinnedContextOnly, webSearchEnabled, knowledgeSearchEnabled, memorySearchEnabled, fullAccessEnabled: false, fullAccessAcknowledged: false, createdAt: now, updatedAt: now, revision: 0, messagesLoaded: true };
}

export async function saveAgentConversation(conversation: AgentConversation, workspaceRoot?: string): Promise<AgentConversation> {
  const next = { ...conversation, messages: persistentAgentMessages(conversation.messages), updatedAt: Date.now(), messagesLoaded: true };
  if (isDesktop()) {
    ensureDesktopBridge();
    const saved = await upsertDesktopConversation(next, workspaceRoot);
    return saved;
  }
  return withBrowserWriteLock(conversation.projectId, async () => {
    const all = readLocal();
    writeLocal([next, ...all.filter(item => item.id !== next.id)]);
    notifyChanged({ projectId: next.projectId, type: "saved", conversation: next });
    return next;
  });
}

export async function patchAgentConversation(conversation: AgentConversation, patch: AgentConversationPatch, workspaceRoot?: string): Promise<AgentConversation> {
  if (isDesktop()) {
    ensureDesktopBridge();
    const root = await resolveDesktopWorkspaceRoot(workspaceRoot);
    const saved = await invoke<AgentConversation>("agent_conversation_patch", {
      workspaceRoot: root,
      patch: { id: conversation.id, projectId: conversation.projectId, ...patch },
    });
    return saved;
  }
  return saveAgentConversation({ ...conversation, ...patch }, workspaceRoot);
}

export async function deleteAgentConversation(conversationId: string, projectId: string, workspaceRoot?: string) {
  if (isDesktop()) {
    ensureDesktopBridge();
    const root = await resolveDesktopWorkspaceRoot(workspaceRoot);
    await invoke("agent_conversation_delete", { workspaceRoot: root, projectId, id: conversationId });
  } else {
    await withBrowserWriteLock(projectId, async () => writeLocal(readLocal().filter(item => item.id !== conversationId)));
  }
  if (!isDesktop()) notifyChanged({ projectId, type: "deleted", conversationId });
}

export async function clearAgentConversations(projectId: string, workspaceRoot?: string): Promise<number> {
  let count: number;
  if (isDesktop()) {
    ensureDesktopBridge();
    const root = await resolveDesktopWorkspaceRoot(workspaceRoot);
    count = await invoke<number>("agent_conversation_clear_project", { workspaceRoot: root, projectId });
  } else {
    const all = readLocal();
    count = all.filter(item => item.projectId === projectId).length;
    await withBrowserWriteLock(projectId, async () => writeLocal(readLocal().filter(item => item.projectId !== projectId)));
  }
  if (!isDesktop()) notifyChanged({ projectId, type: "cleared" });
  return count;
}

export function compactAgentConversation(conversation: AgentConversation, recentMessages = 20): AgentConversation {
  const keep = Math.max(4, Math.round(recentMessages));
  if (conversation.messages.length <= keep) return conversation;
  const splitAt = safeTurnSplitIndex(conversation.messages, conversation.messages.length - keep);
  if (splitAt <= 0) return conversation;
  const compacted = buildAgentCheckpoint(conversation.messages.slice(0, splitAt), conversation.summary, 2400);
  return {
    ...conversation,
    summary: compacted,
    messages: conversation.messages.slice(splitAt),
  };
}

export interface AgentConversationCompactOptions {
  /** 保留的最近消息条数下限（默认 20，最低 4）。 */
  keepRecent?: number;
  /** 预算感知：压缩后（固定开销 + 摘要 + 保留消息）需落入该阈值内。 */
  thresholdTokens?: number;
  /** 不随对话增长的固定 token 开销：system prompt（不含摘要） + 工具定义 + 钉住资料，约等于常量。 */
  fixedOverheadTokens?: number;
}

/**
 * 预算感知的会话级压缩：保留最近 keepRecent 条消息，将更早的消息汇总为结构化检查点写入 summary。
 * 与运行期自动压缩（compactAgentRunContext）保持同一策略口径——若提供 thresholdTokens，
 * 会逐步减少保留条数（最低 4 条）直到估算总上下文落入预算，确保手动压缩后真正回到阈值以内，
 * 而不是像普通 compactAgentConversation 那样只按消息条数裁剪（可能仍超阈值）。
 * 检查点由本地 buildAgentCheckpoint 生成，不调用 LLM，免费且即时。
 */
export function compactAgentConversationToBudget(
  conversation: AgentConversation,
  options: AgentConversationCompactOptions = {},
): AgentConversation {
  const keepRecent = Math.max(4, Math.round(options.keepRecent ?? 20));
  if (conversation.messages.length <= keepRecent) return conversation;
  const threshold = options.thresholdTokens && options.thresholdTokens > 0 ? Math.floor(options.thresholdTokens) : 0;
  const overhead = Math.max(0, Math.floor(options.fixedOverheadTokens ?? 0));

  const splitAndBuild = (keep: number) => {
    const splitAt = safeTurnSplitIndex(conversation.messages, conversation.messages.length - keep);
    const summary = buildAgentCheckpoint(conversation.messages.slice(0, splitAt), conversation.summary, 2400);
    return { splitAt, summary, messages: conversation.messages.slice(splitAt) };
  };

  let keep = keepRecent;
  let state = splitAndBuild(keep);
  if (state.splitAt <= 0) return conversation;
  if (!threshold) {
    return { ...conversation, summary: state.summary, messages: state.messages };
  }

  const totalTokens = (snapshot: { summary: string; messages: AgentMessage[] }) =>
    overhead + estimateAgentContextTokens(snapshot.messages, []) + estimateAgentTextTokens(snapshot.summary);

  while (totalTokens(state) > threshold && keep > 4) {
    keep = Math.max(4, keep - 2);
    const next = splitAndBuild(keep);
    if (next.splitAt <= 0) break;
    state = next;
  }
  return { ...conversation, summary: state.summary, messages: state.messages };
}
