import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../core/types";
import { isDesktop } from "../services/runtime";
import { forgetAgentMemory, listAgentMemories, readAgentMemory, searchAgentMemories, upsertAgentMemory, type AgentMemory } from "./memoryStore";

export type MemoryType = AgentMemory["memoryType"];
export type MemoryStatus = AgentMemory["status"];
export type ProjectMemory = Omit<AgentMemory, "projectId">;
export interface MemoryInput {
  id?: string;
  memoryType: MemoryType;
  title: string;
  content: string;
  confidence?: AgentMemory["confidence"];
  status?: MemoryStatus;
  sourceConversationId?: string;
  sourceMessageId?: string;
}

const workspaceFor = (project: Project) => project.workspace?.root ? project.workspace : null;
const migrationKey = (project: Project) => `tech-proposal-studio.agent-memory-migrated.v1:${project.id}:${project.workspace?.root ?? "browser"}`;
const browserMemory = (memory: AgentMemory): ProjectMemory => {
  const { projectId: _projectId, ...rest } = memory;
  return rest;
};

export async function listProjectMemories(project: Project, includePending = true): Promise<ProjectMemory[]> {
  const workspace = workspaceFor(project);
  if (isDesktop() && workspace) {
    if (!localStorage.getItem(migrationKey(project))) {
      const legacy = listAgentMemories(project.id, true);
      for (const memory of legacy) {
        await invoke("memory_write", { workspace, input: { id: memory.id, memoryType: memory.memoryType, title: memory.title, content: memory.content, confidence: memory.confidence, status: memory.status, sourceConversationId: memory.sourceConversationId, sourceMessageId: memory.sourceMessageId } });
      }
      localStorage.setItem(migrationKey(project), new Date().toISOString());
    }
    return invoke("memory_list", { workspace, includePending });
  }
  return listAgentMemories(project.id, includePending).map(browserMemory);
}

export async function searchProjectMemories(project: Project, query: string, limit = 8): Promise<ProjectMemory[]> {
  const workspace = workspaceFor(project);
  if (isDesktop() && workspace) return invoke("memory_search", { workspace, query, limit });
  return searchAgentMemories(project.id, query, limit).map(browserMemory);
}

export async function readProjectMemory(project: Project, id: string): Promise<ProjectMemory> {
  const workspace = workspaceFor(project);
  if (isDesktop() && workspace) return invoke("memory_read", { workspace, id });
  const memory = readAgentMemory(project.id, id);
  if (!memory) throw new Error(`找不到记忆：${id}`);
  return browserMemory(memory);
}

async function persist(project: Project, input: MemoryInput, proposed: boolean): Promise<ProjectMemory> {
  const workspace = workspaceFor(project);
  if (isDesktop() && workspace) return invoke(proposed ? "memory_propose" : "memory_write", { workspace, input });
  return browserMemory(upsertAgentMemory(project.id, { ...input, confidence: proposed ? "inferred" : input.confidence, status: proposed ? "pending_review" : input.status }));
}

export const writeProjectMemory = (project: Project, input: MemoryInput) => persist(project, input, false);
export const proposeProjectMemory = (project: Project, input: MemoryInput) => persist(project, input, true);

export async function acceptProjectMemory(project: Project, id: string): Promise<ProjectMemory> {
  const workspace = workspaceFor(project);
  if (isDesktop() && workspace) return invoke("memory_accept", { workspace, id });
  const current = readAgentMemory(project.id, id);
  if (!current) throw new Error(`找不到记忆：${id}`);
  return browserMemory(upsertAgentMemory(project.id, { ...current, confidence: "confirmed", status: "active" }));
}

export async function deleteProjectMemory(project: Project, id: string): Promise<void> {
  const workspace = workspaceFor(project);
  if (isDesktop() && workspace) return invoke("memory_delete", { workspace, id });
  forgetAgentMemory(project.id, id);
}

export async function rebuildProjectMemory(project: Project): Promise<ProjectMemory[]> {
  const workspace = workspaceFor(project);
  if (isDesktop() && workspace) return invoke("memory_rebuild", { workspace });
  return listProjectMemories(project);
}
