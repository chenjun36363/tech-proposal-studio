import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "../services/runtime";
import type { AgentMessage } from "./protocol";
import { persistentAgentMessages, safeTurnSplitIndex, summarizeAgentMessage } from "./messageUtils";

const KEY = "tech-proposal-studio.agent-conversations.v1";
export const AGENT_CONVERSATIONS_CHANGED = "tech-proposal-studio:agent-conversations-changed";

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

async function readWorkspace(root: string): Promise<AgentConversation[] | null> {
  if (!isDesktop() || !root.trim()) return null;
  const raw = await invoke<string | null>("read_agent_conversations", { workspaceRoot: root });
  return raw === null ? null : parseConversations(raw);
}

async function writeWorkspace(root: string, conversations: AgentConversation[]) {
  if (!isDesktop() || !root.trim()) return;
  await invoke("write_agent_conversations", { workspaceRoot: root, content: JSON.stringify(conversations, null, 2) });
}

async function readAll(projectId: string, workspaceRoot?: string): Promise<AgentConversation[]> {
  if (isDesktop() && workspaceRoot?.trim()) {
    const stored = await readWorkspace(workspaceRoot);
    if (stored !== null) return stored;
    const migrated = readLocal().filter(item => item.projectId === projectId);
    await writeWorkspace(workspaceRoot, migrated);
    return migrated;
  }
  return readLocal();
}

async function writeAll(projectId: string, workspaceRoot: string | undefined, conversations: AgentConversation[]) {
  const local = readLocal().filter(item => item.projectId !== projectId);
  await writeWorkspace(workspaceRoot ?? "", conversations);
  writeLocal([...local, ...conversations.filter(item => item.projectId === projectId)]);
}

function notifyChanged(projectId: string) {
  window.dispatchEvent(new CustomEvent(AGENT_CONVERSATIONS_CHANGED, { detail: { projectId } }));
}

export async function listAgentConversations(projectId: string, workspaceRoot?: string): Promise<AgentConversation[]> {
  const all = await readAll(projectId, workspaceRoot);
  return all.filter(item => item.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createAgentConversation(projectId: string, pinnedContextOnly = false): AgentConversation {
  const now = Date.now();
  return { id: crypto.randomUUID(), projectId, title: "新会话", messages: [], summary: "", pinnedContextOnly, webSearchEnabled: false, knowledgeSearchEnabled: true, createdAt: now, updatedAt: now };
}

export async function saveAgentConversation(conversation: AgentConversation, workspaceRoot?: string): Promise<AgentConversation> {
  const next = { ...conversation, messages: persistentAgentMessages(conversation.messages), updatedAt: Date.now() };
  const all = await readAll(conversation.projectId, workspaceRoot);
  const index = all.findIndex(item => item.id === next.id);
  if (index >= 0) all[index] = next;
  else all.push(next);
  await writeAll(conversation.projectId, workspaceRoot, all);
  return next;
}

export async function deleteAgentConversation(conversationId: string, projectId: string, workspaceRoot?: string) {
  const all = await readAll(projectId, workspaceRoot);
  await writeAll(projectId, workspaceRoot, all.filter(item => item.id !== conversationId));
  notifyChanged(projectId);
}

export async function clearAgentConversations(projectId: string, workspaceRoot?: string): Promise<number> {
  const all = await readAll(projectId, workspaceRoot);
  const count = all.filter(item => item.projectId === projectId).length;
  await writeAll(projectId, workspaceRoot, all.filter(item => item.projectId !== projectId));
  notifyChanged(projectId);
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
