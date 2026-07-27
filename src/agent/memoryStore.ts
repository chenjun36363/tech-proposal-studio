const KEY = "tech-proposal-studio.agent-memory.v1";

export interface AgentMemory {
  id: string;
  projectId: string;
  memoryType: "decision" | "preference" | "constraint" | "fact" | "reference";
  title: string;
  content: string;
  confidence: "confirmed" | "inferred";
  status: "active" | "pending_review" | "archived";
  sourceConversationId?: string;
  sourceMessageId?: string;
  createdAt: number;
  updatedAt: number;
}

function readAll(): AgentMemory[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item.content === "string").map(item => ({
      ...item,
      memoryType: ["decision", "preference", "constraint", "fact", "reference"].includes(item.memoryType) ? item.memoryType : "fact",
      title: typeof item.title === "string" && item.title.trim() ? item.title : item.content.slice(0, 36),
      confidence: item.confidence === "inferred" ? "inferred" : "confirmed",
      status: ["active", "pending_review", "archived"].includes(item.status) ? item.status : "active",
    }));
  } catch {
    return [];
  }
}

function writeAll(memories: AgentMemory[]) {
  localStorage.setItem(KEY, JSON.stringify(memories));
}

export function listAgentMemories(projectId: string, includePending = true): AgentMemory[] {
  return readAll().filter(item => item.projectId === projectId && item.status !== "archived" && (includePending || item.status === "active")).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function searchAgentMemories(projectId: string, query: string, limit = 8): AgentMemory[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return listAgentMemories(projectId, false).filter(item => tokens.every(token => `${item.title}\n${item.content}`.toLocaleLowerCase().includes(token))).slice(0, limit);
}

export function upsertAgentMemory(projectId: string, input: Partial<AgentMemory> & Pick<AgentMemory, "content">): AgentMemory {
  const all = readAll();
  const existing = input.id ? all.find(item => item.projectId === projectId && item.id === input.id) : undefined;
  const now = Date.now();
  const memory: AgentMemory = {
    id: existing?.id ?? crypto.randomUUID(), projectId,
    memoryType: input.memoryType ?? existing?.memoryType ?? "fact",
    title: (input.title ?? existing?.title ?? input.content.slice(0, 36)).trim(),
    content: input.content.trim(),
    confidence: input.confidence ?? existing?.confidence ?? "confirmed",
    status: input.status ?? existing?.status ?? "active",
    sourceConversationId: input.sourceConversationId ?? existing?.sourceConversationId,
    sourceMessageId: input.sourceMessageId ?? existing?.sourceMessageId,
    createdAt: existing?.createdAt ?? now, updatedAt: now,
  };
  const index = all.findIndex(item => item.projectId === projectId && item.id === memory.id);
  if (index >= 0) all[index] = memory; else all.push(memory);
  writeAll(all);
  return memory;
}

export function rememberAgentFact(projectId: string, content: string): AgentMemory {
  const normalized = content.trim();
  const all = readAll();
  const existing = all.find(item => item.projectId === projectId && item.content.toLocaleLowerCase() === normalized.toLocaleLowerCase());
  if (existing) return existing;
  const now = Date.now();
  const memory: AgentMemory = { id: crypto.randomUUID(), projectId, memoryType: "fact", title: normalized.slice(0, 36), content: normalized, confidence: "confirmed", status: "active", createdAt: now, updatedAt: now };
  all.push(memory);
  writeAll(all);
  return memory;
}

export function readAgentMemory(projectId: string, memoryId: string) {
  return readAll().find(item => item.projectId === projectId && item.id === memoryId);
}

export function forgetAgentMemory(projectId: string, memoryId: string) {
  writeAll(readAll().filter(item => item.projectId !== projectId || item.id !== memoryId));
}
