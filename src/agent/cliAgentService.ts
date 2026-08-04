import type { AgentCompletion } from "./runner";
import type { AgentDraft, AgentEditorSelection, AgentMessage, AgentModelResponse, AgentToolDefinition } from "./protocol";
import type { DocumentBlock, Project } from "../core/types";
import { isDesktop } from "../services/runtime";
import { detectTools, runCommand } from "../services/system";
import type { OpenCodeModelOption } from "../features/longWriting/opencodeService";
import { agentTools } from "./presets";

export type CliAgentProvider = "opencode" | "codex" | "claude";

export interface CliAgentConnection {
  provider: CliAgentProvider;
  model: string;
}

export interface CliAgentRequest {
  connection: CliAgentConnection;
  project: Project;
  block: DocumentBlock;
  messages: AgentMessage[];
  pinnedContext: string[];
  /** 仅控制应用侧工具权限；本地 CLI 始终作为无状态、只读的模型适配器运行。 */
  fullAccess?: boolean;
  signal?: AbortSignal;
}

export interface CliAgentResult {
  reply: string;
  draft?: AgentDraft;
  raw?: unknown;
}

/** 应用已经掌握的编辑器快照，避免本地 CLI 为获取上下文反复调用读取工具。 */
export interface CliAgentPromptContext {
  currentBlock?: DocumentBlock;
  selection?: AgentEditorSelection;
}

export const cliAgentProviderMeta: Record<CliAgentProvider, { label: string; description: string }> = {
  opencode: { label: "OpenCode", description: "按消息启动无状态的本地 OpenCode 模型适配器" },
  codex: { label: "Codex", description: "按消息启动本机 Codex Agent" },
  claude: { label: "Claude", description: "按消息启动本机 Claude Agent" },
};

const defaultLocalModel = (providerId: string, providerName: string): OpenCodeModelOption => ({
  providerId,
  providerName,
  modelId: "__default__",
  modelName: "自动（使用默认模型）",
  isDefault: true,
});

/** Codex/Claude CLI 没有用于枚举模型的本地 HTTP 接口，因此提供 CLI 支持的常用别名。 */
export const defaultCliAgentModels: Record<CliAgentProvider, OpenCodeModelOption[]> = {
  opencode: [defaultLocalModel("opencode", "OpenCode")],
  codex: [
    defaultLocalModel("codex", "Codex"),
    { providerId: "codex", providerName: "Codex", modelId: "gpt-5.2-codex", modelName: "GPT-5.2 Codex", isDefault: false },
    { providerId: "codex", providerName: "Codex", modelId: "gpt-5.1-codex", modelName: "GPT-5.1 Codex", isDefault: false },
    { providerId: "codex", providerName: "Codex", modelId: "gpt-5-codex", modelName: "GPT-5 Codex", isDefault: false },
  ],
  claude: [
    { providerId: "claude", providerName: "Claude Code", modelId: "sonnet", modelName: "Sonnet", isDefault: true },
    { providerId: "claude", providerName: "Claude Code", modelId: "opus", modelName: "Opus", isDefault: false },
    { providerId: "claude", providerName: "Claude Code", modelId: "haiku", modelName: "Haiku", isDefault: false },
  ],
};

export const defaultCliAgentConnections: Record<CliAgentProvider, CliAgentConnection> = {
  opencode: { provider: "opencode", model: "" },
  codex: { provider: "codex", model: "" },
  claude: { provider: "claude", model: "sonnet" },
};

export function normalizeCliAgentConnection(provider: CliAgentProvider, value?: Partial<CliAgentConnection> & { baseUrl?: string }): CliAgentConnection {
  const configured = typeof value?.model === "string" ? value.model.trim() : "";
  // 清理上一版写入的 HTTP 网关和占位模型，避免旧配置继续让发送逻辑走远程接口。
  const model = provider === "codex" && configured === "codex"
    ? ""
    : provider === "claude" && configured === "claude"
      ? "sonnet"
      : configured;
  return { provider, model };
}

export type CliAgentRuntimePhase = "unknown" | "stopped" | "healthy" | "unhealthy" | "starting" | "stopping";

export interface CliAgentRuntimeStatus {
  provider: CliAgentProvider;
  phase: CliAgentRuntimePhase;
  detail?: string;
  /** 保留字段以兼容旧 UI；模式一不维护服务端 session。 */
  port?: number | null;
  activeSessions?: number;
  version?: string | null;
}

export function cliAgentRuntimeLabel(phase: CliAgentRuntimePhase) {
  return ({ unknown: "未检测", stopped: "已停止", starting: "检测中", healthy: "正常", unhealthy: "异常", stopping: "检测中" } satisfies Record<CliAgentRuntimePhase, string>)[phase];
}

async function inspectLocalCli(provider: CliAgentProvider): Promise<CliAgentRuntimeStatus> {
  if (!isDesktop()) return { provider, phase: "unhealthy", detail: "本地 Agent 需要在 Tauri 桌面端运行" };
  try {
    const tools = await detectTools();
    const executable = tools[provider];
    return executable
      ? { provider, phase: "healthy", detail: `已检测到本机 ${cliAgentProviderMeta[provider].label}：${executable}；每轮调用均为新进程，不复用 CLI 会话` }
      : { provider, phase: "stopped", detail: `未检测到 ${cliAgentProviderMeta[provider].label} 命令，请先安装并确保它位于 PATH` };
  } catch (error) {
    return { provider, phase: "unhealthy", detail: error instanceof Error ? error.message : `检测 ${cliAgentProviderMeta[provider].label} 失败` };
  }
}

export async function inspectCliAgent(connection: CliAgentConnection): Promise<CliAgentRuntimeStatus> {
  return inspectLocalCli(connection.provider);
}

export async function startCliAgent(connection: CliAgentConnection): Promise<CliAgentRuntimeStatus> {
  const status = await inspectLocalCli(connection.provider);
  return status.phase === "healthy"
    ? { ...status, detail: `${status.detail}；本地 Agent 上下文由构案应用管理，不启动常驻 session` }
    : status;
}

export async function stopCliAgent(connection: CliAgentConnection): Promise<CliAgentRuntimeStatus> {
  const status = await inspectLocalCli(connection.provider);
  return status.phase === "healthy"
    ? { ...status, detail: `${status.detail}；本地 Agent 按消息启动，无需停止常驻 session` }
    : status;
}

const DEFAULT_OPENCODE_MODEL = "opencode/deepseek-v4-flash-free";

/** 将 `opencode models --pure` 的 provider/model 行转换为模型选择器所需的数据。 */
export function parseOpenCodeModelCatalog(stdout: string): OpenCodeModelOption[] {
  const seen = new Set<string>();
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      const separator = line.lastIndexOf("/");
      if (separator <= 0 || separator === line.length - 1 || seen.has(line)) return [];
      seen.add(line);
      const providerId = line.slice(0, separator);
      const modelId = line.slice(separator + 1);
      const providerName = providerId
        .split("/")
        .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
        .join(" / ");
      return [{
        providerId,
        providerName,
        modelId,
        modelName: modelId,
        isDefault: line === DEFAULT_OPENCODE_MODEL,
      }];
    });
}

export async function listCliAgentModels(provider: CliAgentProvider, directory = "."): Promise<OpenCodeModelOption[]> {
  if (provider !== "opencode") return defaultCliAgentModels[provider];
  if (!isDesktop()) return defaultCliAgentModels.opencode;
  try {
    const result = await runCommand({
      id: crypto.randomUUID(),
      name: "读取 OpenCode 模型列表",
      program: "opencode",
      args: ["models", "--pure"],
      cwd: directory || ".",
      timeoutMs: 30_000,
      allowShell: false,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "OpenCode 模型列表读取失败");
    const models = parseOpenCodeModelCatalog(result.stdout);
    if (models.length) return models;
  } catch {
    // 模型枚举失败时保留占位项，不阻断本地 Agent 运行时检测。
  }
  return defaultCliAgentModels.opencode;
}

export function resolveCliAgentModelOption(models: OpenCodeModelOption[], configured: string): OpenCodeModelOption | undefined {
  const value = configured.trim();
  if (value) {
    const exact = models.find(item => item.modelId === value || `${item.providerId}/${item.modelId}` === value);
    if (exact) return exact;
  }
  return models.find(item => item.isDefault) ?? models[0];
}

export function cliAgentModelValue(model: OpenCodeModelOption | null, provider: CliAgentProvider): string {
  if (!model || model.modelId === "__default__") return "";
  return provider === "opencode" ? `${model.providerId}/${model.modelId}` : model.modelId;
}

function stringifyMessage(message: AgentMessage): string {
  if (message.role === "tool") {
    return `工具结果（${message.tool_call_id ?? "unknown"}）：\n${compact(message.content || "")}`;
  }
  const label = message.role === "system" ? "系统" : message.role === "assistant" ? "助手" : "用户";
  const calls = message.tool_calls?.length ? `\n工具调用：${JSON.stringify(message.tool_calls)}` : "";
  return `${label}：\n${compact(message.content || "")}${calls}`;
}

const ANSI_ESCAPE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

type LocalJsonRecord = Record<string, unknown>;
type LocalToolCall = NonNullable<AgentMessage["tool_calls"]>[number];

function stripAnsi(text: string) {
  return text.replace(ANSI_ESCAPE, "");
}

function parseJsonRecords(text: string): LocalJsonRecord[] {
  const cleaned = stripCodeFence(stripAnsi(text));
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as LocalJsonRecord] : [];
  } catch {
    // Codex/Claude/OpenCode 的 JSON/stream-json 输出可能是逐行事件。
  }
  const records: LocalJsonRecord[] = [];
  for (const line of cleaned.split(/\r?\n/)) {
    const candidate = line.trim().replace(/^data:\s*/i, "");
    if (!candidate || candidate === "[DONE]") continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed as LocalJsonRecord);
    } catch {
      // 忽略 CLI 的进度行，最终交给 parseJsonObject 处理内嵌 JSON。
    }
  }
  return records;
}

function textFromValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(item => textFromValue(item)).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") return "";
  const record = value as LocalJsonRecord;
  if (typeof record.text === "string") return record.text;
  if (typeof record.output_text === "string") return record.output_text;
  if (typeof record.content === "string" || Array.isArray(record.content)) return textFromValue(record.content);
  if (typeof record.result === "string") return record.result;
  if (typeof record.reply === "string") return record.reply;
  return "";
}

function rawToolCalls(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(item => rawToolCalls(item));
  if (!value || typeof value !== "object") return [];
  const record = value as LocalJsonRecord;
  const calls: unknown[] = [];
  if (["tool_use", "tool_call", "function_call"].includes(String(record.type || ""))) calls.push(record);
  for (const key of ["tool_calls", "toolCalls", "calls"]) {
    if (Array.isArray(record[key])) calls.push(...record[key]);
  }
  if (record.message && typeof record.message === "object") calls.push(...rawToolCalls(record.message));
  if (record.item && typeof record.item === "object") calls.push(...rawToolCalls(record.item));
  if (record.choices && Array.isArray(record.choices)) calls.push(...rawToolCalls(record.choices));
  if (record.content && Array.isArray(record.content)) {
    for (const item of record.content) {
      if (item && typeof item === "object") {
        const block = item as LocalJsonRecord;
        if (["tool_use", "tool_call", "function_call"].includes(String(block.type || ""))) calls.push(block);
      }
    }
  }
  return calls;
}

function normalizeToolCalls(records: LocalJsonRecord[]): LocalToolCall[] {
  const seen = new Set<string>();
  return rawToolCalls(records).flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as LocalJsonRecord;
    const fn = record.function && typeof record.function === "object" && !Array.isArray(record.function)
      ? record.function as LocalJsonRecord
      : record;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) return [];
    const rawArguments = fn.arguments ?? fn.input ?? record.input ?? record.parameters ?? {};
    const args = typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments);
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : `local-call-${index + 1}`;
    const key = `${id}:${name}:${args}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id, type: "function" as const, function: { name, arguments: args } }];
  });
}

function responseContentCandidates(record: LocalJsonRecord): string[] {
  const candidates: string[] = [];
  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      if (choice && typeof choice === "object") {
        const message = (choice as LocalJsonRecord).message;
        if (message && typeof message === "object") candidates.push(textFromValue((message as LocalJsonRecord).content));
        candidates.push(textFromValue((choice as LocalJsonRecord).content));
      }
    }
  }
  for (const key of ["reply", "result", "output_text", "content", "text"]) {
    if (record[key] !== undefined) candidates.push(textFromValue(record[key]));
  }
  for (const key of ["message", "item", "part", "data"]) {
    if (record[key] && typeof record[key] === "object") candidates.push(textFromValue(record[key]));
  }
  return candidates.map(value => value.trim()).filter(Boolean);
}

function uniqueContent(parts: string[]) {
  const result: string[] = [];
  for (const part of parts) {
    if (!part || result.includes(part)) continue;
    if (result.some(existing => existing.includes(part))) continue;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (part.includes(result[index])) result.splice(index, 1);
    }
    result.push(part);
  }
  return result;
}

export function parseLocalModelResponse(text: string): AgentModelResponse {
  const cleaned = stripAnsi(text).trim();
  const parsed = parseJsonObject(cleaned);
  const records = parseJsonRecords(cleaned);
  const source = records.length ? records : parsed ? [parsed] : [];
  if (!source.length) return { choices: [{ message: { role: "assistant", content: cleaned } }] };
  if (source.length === 1 && Array.isArray(source[0].choices)) return source[0] as AgentModelResponse;

  const calls = normalizeToolCalls(source);
  const candidates = source.flatMap(responseContentCandidates);
  // Claude --output-format json 常把应用要求的 JSON 放在 result 字符串内；这里解一层，避免 Runner 把工具调用当普通文本。
  const nested = candidates.length === 1 ? parseJsonObject(candidates[0]) : null;
  if (nested && (nested.content !== undefined || nested.tool_calls !== undefined || nested.toolCalls !== undefined)) {
    return parseLocalModelResponse(candidates[0]);
  }
  const content = uniqueContent(candidates).join("\n\n");
  return { choices: [{ message: { role: "assistant", content: content || null, tool_calls: calls.length ? calls : undefined } }] };
}

function buildLocalRunnerPrompt(payload: Record<string, unknown>, connection: CliAgentConnection, context?: CliAgentPromptContext): string {
  const messages = Array.isArray(payload.messages) ? payload.messages as AgentMessage[] : [];
  const tools = Array.isArray(payload.tools) ? payload.tools as AgentToolDefinition[] : [];
  const toolText = tools.length ? `\n\n## 可用应用工具\n${JSON.stringify(tools, null, 2)}` : "";
  const snapshotText = context?.currentBlock
    ? `## 应用已提供的当前章节\n章节 ID：${context.currentBlock.sectionId}\n以下内容是当前编辑器快照，不需要调用读取工具：\n${compact(context.currentBlock.content)}`
    : "";
  const selectionText = context?.selection?.text
    ? `## 应用已提供的用户选区\n以下内容是用户发送任务时的选区快照，不需要调用读取工具：\n${compact(context.selection.text)}`
    : "";
  return [
    "你是构案中的本地 Agent 模型适配器。构案应用是唯一的 Agent Runner，负责执行工具、保存会话、压缩上下文和审核文档修改。",
    "本次 CLI 调用是无状态的一轮模型请求：不得读取、写入或复用任何 CLI 历史/会话，不得调用 CLI 自带工具；只能根据下面提供的应用上下文生成一条模型消息。",
    "请严格按照下面的 JSON 格式返回，不要输出 Markdown 围栏、解释文字或额外内容：",
    '{"content":"给用户的回复","tool_calls":[{"id":"唯一 ID","name":"工具名","arguments":{}}]}',
    "没有工具调用时 tool_calls 必须是空数组。需要调用应用工具时，只能调用可用工具，并把 arguments 写成 JSON 对象。",
    `当前本地 Agent：${cliAgentProviderMeta[connection.provider].label}；当前模型：${connection.model || "使用默认模型"}`,
    snapshotText,
    selectionText,
    "本地 CLI 采用低工具模式：回答问题时不要调用工具；修改文档时只调用一个最贴近目标的 propose_* 提案工具。不要调用读取、搜索、记忆、计划、终端或文件系统工具；应用会负责校验、弹框预览和写入。一次任务最多提交一个工具调用。",
    toolText,
    "## 对话上下文",
    messages.map(stringifyMessage).join("\n\n"),
  ].filter(Boolean).join("\n");
}

function localResolvedModelName(connection: CliAgentConnection) {
  return connection.model || `${connection.provider}:default`;
}

function applyStatelessCliArgs(args: string[], provider: CliAgentProvider, model: string) {
  // 应用 Runner 控制工具循环和会话；外部 CLI 只负责返回一轮模型消息。
  // Codex/Claude 明确关闭会话持久化；OpenCode 不传 --continue/--session，默认每次创建独立调用。
  if (provider === "codex") {
    const sandboxIndex = args.indexOf("--ephemeral");
    args.splice(sandboxIndex >= 0 ? sandboxIndex + 2 : 2, 0, "--sandbox", "read-only");
    if (model && model !== "__default__") args.splice(Math.max(args.length - 1, 0), 0, "--model", model);
  }
  if (provider === "claude") {
    if (!args.includes("--permission-mode")) args.splice(1, 0, "--permission-mode", "plan");
    if (model && model !== "__default__") args.push("--model", model);
  }
  if (provider === "opencode" && model && model !== "__default__") {
    const modelIndex = args.indexOf("--model");
    if (modelIndex >= 0 && modelIndex + 1 < args.length) args[modelIndex + 1] = model;
  }
  return args;
}

/**
 * 将本地 Codex/Claude/OpenCode 适配成内置 Agent Runner 所需的模型完成器。
 * Runner 负责工具循环、审批、会话和修改提案；本地 CLI 只负责返回一轮模型消息。
 */
export function createCliAgentCompletion(
  connection: CliAgentConnection,
  cwd = ".",
  fullAccess = false,
  context?: CliAgentPromptContext,
): AgentCompletion {
  return async (payload, _config, signal) => {
    if (!isDesktop()) throw new Error("本地 Agent 需要在 Tauri 桌面端运行");
    if (signal?.aborted) throw new DOMException("本地 Agent 请求已取消", "AbortError");
    const tool = agentTools.find(item => item.id === connection.provider);
    if (!tool) throw new Error(`未配置 ${connection.provider} 本地 Agent`);
    const prompt = buildLocalRunnerPrompt(payload, connection, context);
    const args = applyStatelessCliArgs(tool.buildArgs(prompt), connection.provider, connection.model.trim());
    // fullAccess 只影响应用 ToolRegistry；不能把写入权限下放给外部 CLI。
    void fullAccess;
    const command = {
      name: `${tool.name} 本地 Agent 模型轮次`,
      program: tool.program,
      args,
      cwd,
      timeoutMs: tool.timeoutMs,
      allowShell: false,
      stdin: tool.promptViaStdin ? prompt : undefined,
    };
    const result = await runLocalCommandWithRetry(
      () => ({ ...command, id: crypto.randomUUID() }),
      connection.provider,
      signal,
    );
    if (result.exitCode !== 0) throw new Error(localCliFailureMessage(connection.provider, result));
    // 某些 CLI 会把 token 刷新警告写入 stderr，但 stdout 仍然是有效模型输出；stderr 不能覆盖成功结果。
    const output = stripAnsi(result.stdout).trim();
    if (!output) {
      const diagnostics = stripAnsi(result.stderr).trim();
      if (diagnostics) throw new Error(localCliFailureMessage(connection.provider, result, "返回内容"));
      throw new Error(`${cliAgentProviderMeta[connection.provider].label} 本地 Agent 未返回内容`);
    }
    return parseLocalModelResponse(output);
  };
}

export function localAgentModelLabel(connection: CliAgentConnection) {
  return `${cliAgentProviderMeta[connection.provider].label} · ${localResolvedModelName(connection)}`;
}

function compact(value: string, max = 60000) {
  return value.length > max ? `${value.slice(0, max)}\n\n[内容已截断]` : value;
}

function isTransientCliMessage(value: string) {
  return /unexpected server error|temporar(?:y|ily)|econnreset|econnrefused|etimedout|fetch failed|timed out|timeout|(?:^|\D)5\d{2}(?:\D|$)/i.test(value);
}

function isTransientCliFailure(provider: CliAgentProvider, result: { exitCode: number; stdout: string; stderr: string }) {
  if (result.exitCode === 0) return false;
  const details = stripAnsi(`${result.stderr}\n${result.stdout}`);
  // 认证失效不能靠重试解决，否则只会重复刷错误日志。
  if (/invalid_refresh_token|could not validate your refresh token|unauthorized/i.test(details)) return false;
  return provider === "opencode" || isTransientCliMessage(details);
}

function localCliFailureMessage(provider: CliAgentProvider, result: { exitCode: number; stdout: string; stderr: string }, action = "执行") {
  const details = stripAnsi(`${result.stderr}\n${result.stdout}`).trim();
  if (provider === "codex" && /invalid_refresh_token|could not validate your refresh token/i.test(details)) {
    return "Codex 登录凭证已失效，请在应用终端执行 `codex logout` 后再执行 `codex login`，然后重新检测本地 Agent。";
  }
  if (provider === "opencode" && /unexpected server error/i.test(details)) {
    return "OpenCode 返回了临时服务错误。应用已自动重试一次；如果仍失败，请重启 OpenCode 服务并检查其服务日志。";
  }
  if (/enoent|not found|无法找到|不是内部或外部命令/i.test(details)) {
    return `${cliAgentProviderMeta[provider].label} CLI 未找到，请先安装或在环境设置中重新检测 PATH。`;
  }
  return `${cliAgentProviderMeta[provider].label} 本地 Agent ${action}失败（退出码 ${result.exitCode}）：${compact(details || "没有错误详情", 1200)}`;
}

async function waitBeforeCliRetry(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("本地 Agent 请求已取消", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, 700);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("本地 Agent 请求已取消", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type LocalCommand = Parameters<typeof runCommand>[0];

async function runLocalCommandWithRetry(
  createCommand: () => LocalCommand,
  provider: CliAgentProvider,
  signal?: AbortSignal,
) {
  let result = await runCommand(createCommand());
  if (isTransientCliFailure(provider, result)) {
    await waitBeforeCliRetry(signal);
    result = await runCommand(createCommand());
  }
  return result;
}

function buildSystemPrompt(project: Project, block: DocumentBlock, pinnedContext: string[], fullAccess = false) {
  const context = pinnedContext.length ? `\n\n## 已引用资料\n${pinnedContext.map((item, index) => `### 资料 ${index + 1}\n${compact(item, 12000)}`).join("\n\n")}` : "";
  return `你是“构案”中的本地 Agent。你直接运行在本机的 ${project.name || "技术方案"} 工作区，负责以对话方式协助编辑软件技术方案。\n\n当前章节 ID：${block.sectionId}\n当前章节内容：\n${compact(block.content)}${context}\n\n当前权限模式：${fullAccess ? "完全访问（允许在当前工作区内读取、创建和修改文件；不提供系统命令和联网能力）" : "只读（只能读取上下文并生成建议，不能修改文件）"}。\n\n请遵守：\n1. 先回答用户问题；如果用户要求修改文档，生成完整的当前章节替换稿。\n2. 只允许修改当前章节，不要改动其他章节，不要输出完整全文。\n3. 默认不要直接写入文件；即使开启完全访问，也优先返回结构化修改建议，只有用户明确要求时才使用工作区写入能力。\n4. 最终必须只返回 JSON，不要 Markdown 围栏：{"reply":"给用户的简短说明","edit":null 或 {"after":"完整章节替换稿","instruction":"修改说明"}}。\n5. edit.after 必须包含当前章节标题（如果当前内容包含标题），并保留 Markdown 结构。没有明确修改要求时 edit 必须为 null。` ;
}

function stripCodeFence(text: string) {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = stripCodeFence(stripAnsi(text));
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  }
}

export function parseCliAgentResponse(text: string, block: DocumentBlock): { reply: string; draft?: AgentDraft } {
  const parsed = parseJsonObject(text);
  const reply = typeof parsed?.reply === "string" ? parsed.reply.trim() : text.trim();
  const edit = parsed?.edit && typeof parsed.edit === "object" && !Array.isArray(parsed.edit) ? parsed.edit as Record<string, unknown> : null;
  const after = typeof edit?.after === "string" ? edit.after.trim() : "";
  if (!after || after === block.content.trim()) return { reply: reply || "本轮没有返回可展示内容。" };
  return {
    reply: reply || "已生成当前章节修改稿，请确认后应用。",
    draft: {
      callId: crypto.randomUUID(),
      operation: "replace_section",
      before: block.content,
      after,
      instruction: typeof edit?.instruction === "string" && edit.instruction.trim() ? edit.instruction.trim() : "本地 Agent 修改当前章节",
      target: { sectionId: block.sectionId, snapshot: block.content },
    },
  };
}

function conversationPrompt(request: CliAgentRequest) {
  const history = request.messages
    .filter(message => message.role === "user" || message.role === "assistant")
    .slice(-20)
    .map(message => `${message.role === "user" ? "用户" : "助手"}：${compact(message.content || "", 12000)}`)
    .join("\n\n");
  return `${buildSystemPrompt(request.project, request.block, request.pinnedContext, request.fullAccess === true)}\n\n## 当前对话\n${history || "用户：请说明当前文档状态。"}`;
}

export function buildLocalCliCommand(request: CliAgentRequest) {
  const tool = agentTools.find(item => item.id === request.connection.provider);
  if (!tool) throw new Error(`未配置 ${request.connection.provider} 本地 Agent`);
  const prompt = conversationPrompt(request);
  const args = tool.buildArgs(prompt);
  const model = request.connection.model.trim();
  applyStatelessCliArgs(args, request.connection.provider, model);
  return {
    id: crypto.randomUUID(),
    name: `${tool.name} 本地 Agent`,
    program: tool.program,
    args,
    cwd: request.project.workspace?.root || ".",
    timeoutMs: tool.timeoutMs,
    allowShell: false,
    stdin: tool.promptViaStdin ? prompt : undefined,
  };
}

async function callLocalCli(request: CliAgentRequest): Promise<CliAgentResult> {
  if (!isDesktop()) throw new Error("本地 Agent 需要在 Tauri 桌面端运行");
  if (request.signal?.aborted) throw new Error("本地 Agent 请求已取消");
  const command = buildLocalCliCommand(request);
  const result = await runLocalCommandWithRetry(
    () => ({ ...command, id: crypto.randomUUID() }),
    request.connection.provider,
    request.signal,
  );
  if (result.exitCode !== 0) throw new Error(localCliFailureMessage(request.connection.provider, result, "启动"));
  const output = stripAnsi(result.stdout).trim();
  if (!output) {
    const diagnostics = stripAnsi(result.stderr).trim();
    if (diagnostics) throw new Error(localCliFailureMessage(request.connection.provider, result, "返回内容"));
    throw new Error(`${cliAgentProviderMeta[request.connection.provider].label} 本地 Agent 未返回文本内容`);
  }
  return { ...parseCliAgentResponse(output, request.block), raw: result };
}

/**
 * 模式一：应用控制上下文。所有本地供应商都通过一次性 CLI 调用返回一轮消息，
 * 不创建、恢复或复用 OpenCode/Claude/Codex 的会话。
 */
export async function sendCliAgentMessage(request: CliAgentRequest): Promise<CliAgentResult> {
  return callLocalCli(request);
}

