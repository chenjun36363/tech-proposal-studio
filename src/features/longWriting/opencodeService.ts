import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isDesktop } from "../../services/runtime";

export type OpenCodeServerPhase = "stopped" | "starting" | "healthy" | "unhealthy" | "stopping";

export interface OpenCodeServerStatus {
  phase: OpenCodeServerPhase;
  pid?: number | null;
  port?: number | null;
  version?: string | null;
  startedAt?: string | null;
  activeSessions: number;
  lastError?: string | null;
  recentLogs: string[];
}

export interface OpenCodeModelRef {
  providerId: string;
  modelId: string;
}

export interface OpenCodeModelOption extends OpenCodeModelRef {
  providerName: string;
  modelName: string;
  isDefault: boolean;
}

export interface CreateOpenCodeSessionRequest {
  directory: string;
  title: string;
  parentId?: string | null;
  model: OpenCodeModelRef;
  filePath: string;
}

export interface PromptOpenCodeSessionRequest {
  directory: string;
  sessionId: string;
  system: string;
  text: string;
  phase: "analysis" | "write";
}

export interface OpenCodePromptResult {
  text: string;
  raw: unknown;
}

function requireDesktop() {
  if (!isDesktop()) throw new Error("OpenCode 长任务仅支持桌面端");
}

export async function getOpenCodeServerStatus(): Promise<OpenCodeServerStatus> {
  requireDesktop();
  return invoke("get_open_code_server_status");
}

export async function startOpenCodeServer(): Promise<OpenCodeServerStatus> {
  requireDesktop();
  return invoke("start_open_code_server");
}

export async function stopOpenCodeServer(): Promise<OpenCodeServerStatus> {
  requireDesktop();
  return invoke("stop_open_code_server");
}

export async function listOpenCodeModels(directory: string): Promise<OpenCodeModelOption[]> {
  requireDesktop();
  return invoke("list_open_code_models", { directory });
}

export async function createOpenCodeSession(request: CreateOpenCodeSessionRequest): Promise<string> {
  requireDesktop();
  const result = await invoke<{ sessionId: string }>("create_open_code_session", { request });
  return result.sessionId;
}

export async function promptOpenCodeSession(request: PromptOpenCodeSessionRequest): Promise<OpenCodePromptResult> {
  requireDesktop();
  return invoke("prompt_open_code_session", { request });
}

export async function abortOpenCodeSession(directory: string, sessionId: string): Promise<boolean> {
  requireDesktop();
  return invoke("abort_open_code_session", { directory, sessionId });
}

export async function getOpenCodeSessionStatus(directory: string): Promise<Record<string, unknown>> {
  requireDesktop();
  return invoke("get_open_code_session_status", { directory });
}

export async function getOpenCodeSessionMessages(directory: string, sessionId: string): Promise<unknown> {
  requireDesktop();
  return invoke("get_open_code_session_messages", { directory, sessionId });
}

export function listenOpenCodeServerStatus(listener: (status: OpenCodeServerStatus) => void): Promise<UnlistenFn> {
  return listen<OpenCodeServerStatus>("opencode://server-status", event => listener(event.payload));
}

export function listenOpenCodeEvents(listener: (event: unknown) => void): Promise<UnlistenFn> {
  return listen("opencode://event", event => listener(event.payload));
}
