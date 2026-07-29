import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isDesktop } from "../services/runtime";
import type { AgentMessage } from "./protocol";
import { persistentAgentMessages, safeTurnSplitIndex, summarizeAgentMessage } from "./messageUtils";

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
  pinnedContextOnly?: boolean;
  webSearchEnabled?: boolean;
  knowledgeSearchEnabled?: boolean;
  createdAt: number;
  updatedAt: number;
  revision?: number;
  messagesLoaded?: boolean;
  messageCount?: number;
  lastMessagePreview?: string;
}

export type AgentConversationPatch = Partial<Pick<AgentConversation, "title" | "pinnedContextOnly" | "webSearchEnabled" | "knowledgeSearchEnabled">>;

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
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === "string" && typeof item.projectId === "string") : [];
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

function requireWorkspaceRoot(workspaceRoot?: string): string {
  const root = workspaceRoot?.trim();
  if (!root) throw new Error("工作目录不能为空");
  return root;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

async function upsertDesktopConversation(conversation: AgentConversation, workspaceRoot: string): Promise<AgentConversation> {
  let candidate = conversation;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await invoke<AgentConversation>("agent_conversation_upsert", { workspaceRoot, conversation: candidate });
    } catch (error) {
      const message = errorText(error);
      if (message.includes("会话已在其他位置更新") && attempt === 0) {
        const latest = await invoke<AgentConversation>("agent_conversation_get", { workspaceRoot, id: candidate.id });
        candidate = {
          ...candidate,
          revision: latest.revision,
          pinnedContextOnly: latest.pinnedContextOnly,
          webSearchEnabled: latest.webSearchEnabled,
          knowledgeSearchEnabled: latest.knowledgeSearchEnabled,
        };
        continue;
      }
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
    return invoke<AgentConversation[]>("agent_conversation_list", { workspaceRoot: requireWorkspaceRoot(workspaceRoot), projectId });
  }
  return readLocal().filter(item => item.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getAgentConversation(conversationId: string, workspaceRoot?: string): Promise<AgentConversation> {
  if (isDesktop()) {
    ensureDesktopBridge();
    return invoke<AgentConversation>("agent_conversation_get", { workspaceRoot: requireWorkspaceRoot(workspaceRoot), id: conversationId });
  }
  const conversation = readLocal().find(item => item.id === conversationId);
  if (!conversation) throw new Error("会话不存在");
  return { ...conversation, messagesLoaded: true };
}

export function createAgentConversation(projectId: string, pinnedContextOnly = false): AgentConversation {
  const now = Date.now();
  return { id: crypto.randomUUID(), projectId, title: "新会话", messages: [], summary: "", pinnedContextOnly, webSearchEnabled: false, knowledgeSearchEnabled: true, createdAt: now, updatedAt: now, revision: 0, messagesLoaded: true };
}

export async function saveAgentConversation(conversation: AgentConversation, workspaceRoot?: string): Promise<AgentConversation> {
  const next = { ...conversation, messages: persistentAgentMessages(conversation.messages), updatedAt: Date.now(), messagesLoaded: true };
  if (isDesktop()) {
    ensureDesktopBridge();
    const saved = await upsertDesktopConversation(next, requireWorkspaceRoot(workspaceRoot));
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
    const saved = await invoke<AgentConversation>("agent_conversation_patch", {
      workspaceRoot: requireWorkspaceRoot(workspaceRoot),
      patch: { id: conversation.id, projectId: conversation.projectId, ...patch },
    });
    return saved;
  }
  return saveAgentConversation({ ...conversation, ...patch }, workspaceRoot);
}

export async function deleteAgentConversation(conversationId: string, projectId: string, workspaceRoot?: string) {
  if (isDesktop()) {
    ensureDesktopBridge();
    await invoke("agent_conversation_delete", { workspaceRoot: requireWorkspaceRoot(workspaceRoot), projectId, id: conversationId });
  } else {
    await withBrowserWriteLock(projectId, async () => writeLocal(readLocal().filter(item => item.id !== conversationId)));
  }
  if (!isDesktop()) notifyChanged({ projectId, type: "deleted", conversationId });
}

export async function clearAgentConversations(projectId: string, workspaceRoot?: string): Promise<number> {
  let count: number;
  if (isDesktop()) {
    ensureDesktopBridge();
    count = await invoke<number>("agent_conversation_clear_project", { workspaceRoot: requireWorkspaceRoot(workspaceRoot), projectId });
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
  const compacted = conversation.messages.slice(0, splitAt).filter(message => !message.transient).map(summarizeAgentMessage).join("\n");
  const previous = conversation.summary ? `${conversation.summary}\n` : "";
  return {
    ...conversation,
    summary: `${previous}${compacted}`.slice(-8000),
    messages: conversation.messages.slice(splitAt),
  };
}
