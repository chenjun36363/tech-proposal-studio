import type { AgentMessage } from "./protocol";
import { persistentAgentMessages, safeTurnSplitIndex, summarizeAgentMessage } from "./messageUtils";

const KEY = "tech-proposal-studio.agent-conversations.v1";

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

function readAll(): AgentConversation[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(conversations: AgentConversation[]) {
  localStorage.setItem(KEY, JSON.stringify(conversations));
}

export function listAgentConversations(projectId: string): AgentConversation[] {
  return readAll().filter(item => item.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createAgentConversation(projectId: string, pinnedContextOnly = false): AgentConversation {
  const now = Date.now();
  return { id: crypto.randomUUID(), projectId, title: "新会话", messages: [], summary: "", pinnedContextOnly, webSearchEnabled: false, knowledgeSearchEnabled: true, createdAt: now, updatedAt: now };
}

export function saveAgentConversation(conversation: AgentConversation): AgentConversation {
  const next = { ...conversation, messages: persistentAgentMessages(conversation.messages), updatedAt: Date.now() };
  const all = readAll();
  const index = all.findIndex(item => item.id === next.id);
  if (index >= 0) all[index] = next;
  else all.push(next);
  writeAll(all);
  return next;
}

export function deleteAgentConversation(conversationId: string) {
  writeAll(readAll().filter(item => item.id !== conversationId));
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

