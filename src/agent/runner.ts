import type { OpenAICompatibleConfig, ResolvedModelConfig } from "../core/types";
import { agentCompletion } from "../services/model";
import { resolvedFromLegacy } from "../services/llm/resolve";
import type { AgentEvent, AgentMessage, AgentModelResponse, AgentToolCall } from "./protocol";
import { AgentToolRegistry } from "./toolRegistry";
import { compactAgentRunContext } from "./contextCompaction";
import { persistentAgentMessages } from "./messageUtils";

const makeEventId = () => crypto.randomUUID();
function parseArguments(value: string): { arguments: Record<string, unknown>; error?: string } {
  if (!value.trim()) return { arguments: {} };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { arguments: parsed }
      : { arguments: {}, error: "工具参数必须是 JSON 对象。" };
  } catch (error) {
    return { arguments: {}, error: `工具参数不是有效 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseDsmlToolCalls(content: string): { content: string; calls: AgentToolCall[] } {
  const calls: AgentToolCall[] = [];
  const invokePattern = /<\|\s*DSML\s*\|\s*invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/\|\s*DSML\s*\|\s*invoke\s*>|<\|\s*DSML\s*\|\s*\/invoke\s*>|(?=<\|\s*DSML\s*\|\s*invoke\b)|$)/gi;
  for (const invoke of content.matchAll(invokePattern)) {
    const args: Record<string, unknown> = {};
    const parameterPattern = /<\|\s*DSML\s*\|\s*parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/\|\s*DSML\s*\|\s*parameter\s*>|<\|\s*DSML\s*\|\s*\/parameter\s*>|(?=<\|\s*DSML\s*\|\s*parameter\b)|$)/gi;
    for (const parameter of invoke[2].matchAll(parameterPattern)) args[parameter[1]] = parameter[2].trim();
    calls.push({ id: makeEventId(), name: invoke[1], arguments: args });
  }
  if (!calls.length) return { content, calls };
  const markerStart = content.search(/<\|\s*DSML\s*\|\s*(?:tool_calls|invoke)\b/i);
  return { content: (markerStart >= 0 ? content.slice(0, markerStart) : content).trim(), calls };
}

function normalizedAssistant(message: AgentMessage) {
  const content = typeof message.content === "string" ? message.content : "";
  const dsml = message.tool_calls?.length ? { content, calls: [] } : parseDsmlToolCalls(content);
  if (!dsml.calls.length) return { message, content: content.trim(), calls: message.tool_calls ?? [] };
  const toolCalls = dsml.calls.map(call => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
  return { message: { ...message, content: dsml.content || null, tool_calls: toolCalls }, content: dsml.content, calls: toolCalls };
}

type AgentEventInput = AgentEvent extends infer Event ? Event extends AgentEvent ? Omit<Event, "id" | "at"> : never : never;

function messagesForAvailableTools(messages: AgentMessage[], registry: AgentToolRegistry): AgentMessage[] {
  const removedCallIds = new Set<string>();
  return messages.flatMap(message => {
    if (message.role === "assistant" && message.tool_calls?.length) {
      const toolCalls = message.tool_calls.filter(call => {
        const available = registry.has(call.function.name);
        if (!available) removedCallIds.add(call.id);
        return available;
      });
      if (!toolCalls.length && !message.content) return [];
      return [{ ...message, tool_calls: toolCalls.length ? toolCalls : undefined }];
    }
    if (message.role === "tool" && message.tool_call_id && removedCallIds.has(message.tool_call_id)) return [];
    return [message];
  });
}

function messagesForModel(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(({ tool_result_data: _data, tool_result_is_error: _isError, transient: _transient, ...message }) => message);
}

function completedMessages(messages: AgentMessage[]): AgentMessage[] {
  const completedCallIds = new Set(messages.flatMap(message => message.role === "tool" && message.tool_call_id ? [message.tool_call_id] : []));
  return messages.flatMap(message => {
    if (!message.tool_calls?.length) return [message];
    const tool_calls = message.tool_calls.filter(call => completedCallIds.has(call.id));
    if (!tool_calls.length && !message.content) return [];
    return [{ ...message, tool_calls: tool_calls.length ? tool_calls : undefined }];
  });
}

function isForcedToolChoiceRejected(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  const message = error instanceof Error ? error.message : String(error);
  return /tool[_\s-]*choice|ToolChoiceFunction|field\s+function|invalid_request_error/i.test(message);
}

type TrackedTodo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string };

function trackedTodos(call: AgentToolCall): TrackedTodo[] | null {
  if (call.name !== "write_todo" || !Array.isArray(call.arguments.todos)) return null;
  const todos = call.arguments.todos.filter((item): item is TrackedTodo => {
    if (!item || typeof item !== "object") return false;
    const todo = item as Record<string, unknown>;
    return typeof todo.content === "string"
      && (todo.status === "pending" || todo.status === "in_progress" || todo.status === "completed")
      && typeof todo.activeForm === "string";
  });
  return todos.length === call.arguments.todos.length ? todos : null;
}

export async function runProposalAgent(params: {
  task: string;
  messages?: AgentMessage[];
  systemPrompt?: string;
  config: ResolvedModelConfig | OpenAICompatibleConfig;
  registry: AgentToolRegistry;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  contextCompressionTokens?: number;
  temperature?: number;
  firstRoundToolName?: string;
  maxRounds?: number;
}) {
  const config: ResolvedModelConfig = "protocol" in params.config && "providerId" in params.config
    ? params.config
    : resolvedFromLegacy(params.config);
  const { registry, signal, onEvent } = params;
  const contextCompressionTokens = params.contextCompressionTokens ?? 98000;
  const maxRounds = Math.max(1, Math.round(params.maxRounds ?? 20));
  const emit = (event: AgentEventInput) => onEvent({ ...event, id: makeEventId(), at: Date.now() } as AgentEvent);
  const baseMessages = messagesForAvailableTools(params.messages ?? [{ role: "system" as const, content: params.systemPrompt ?? "" }], registry);
  let messages: AgentMessage[] = [...baseMessages, { role: "user", content: params.task }];
  let requiredFirstTool = params.firstRoundToolName && registry.has(params.firstRoundToolName)
    ? params.firstRoundToolName
    : null;
  let latestTodos: TrackedTodo[] = [];
  const finalizeTodos = async (round: number) => {
    if (!registry.has("write_todo") || !latestTodos.some(todo => todo.status !== "completed")) return;
    const call: AgentToolCall = {
      id: makeEventId(),
      name: "write_todo",
      arguments: { todos: latestTodos.map(todo => ({ ...todo, status: "completed" as const })) },
    };
    emit({ type: "tool_call", round, call });
    emit({ type: "tool_started", round, callId: call.id });
    const result = await registry.execute(call, signal);
    emit({ type: "tool_result", round, call, result });
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
    messages.push({ role: "tool", tool_call_id: call.id, content: result.content, tool_result_data: result.data, tool_result_is_error: result.isError });
    if (!result.isError) latestTodos = call.arguments.todos as TrackedTodo[];
  };
  emit({ type: "run_started", model: config.model });
  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      if (signal.aborted) throw new DOMException("Agent 任务已取消", "AbortError");
      emit({ type: "round_started", round });
      const availableDefinitions = registry.definitions();
      const roundDefinitions = requiredFirstTool
        ? availableDefinitions.filter(tool => tool.function.name === requiredFirstTool)
        : availableDefinitions;
      const compaction = compactAgentRunContext(messages, roundDefinitions, contextCompressionTokens);
      if (compaction.compacted) {
        messages = compaction.messages;
        emit({ type: "context_compacted", round, beforeTokens: compaction.beforeTokens, afterTokens: compaction.afterTokens, removedMessages: compaction.removedMessages });
      }
      if (!compaction.fitsBudget) {
        throw new Error(`Agent 上下文压缩后仍超出预算 ${compaction.overflowTokens.toLocaleString()} tokens；请减少本轮超长输入、附加资料或工具定义，或提高上下文压缩阈值。`);
      }
      const toolChoice = requiredFirstTool
        ? { type: "function" as const, function: { name: requiredFirstTool } }
        : "auto" as const;
      const request = { model: config.model, messages: messagesForModel(messages), tools: roundDefinitions, tool_choice: toolChoice, stream: false, temperature: params.temperature };
      let response: AgentModelResponse;
      try {
        response = await agentCompletion(request, config, signal) as AgentModelResponse;
      } catch (error) {
        // Some OpenAI-compatible gateways support tools but reject a forced tool_choice.
        // Keep the native forced request as the default, then fall back to the prompt-enforced auto mode.
        if (!requiredFirstTool || !isForcedToolChoiceRejected(error)) throw error;
        response = await agentCompletion({ ...request, tool_choice: "auto" }, config, signal) as AgentModelResponse;
      }
      const assistant = response.choices?.[0]?.message;
      if (!assistant) throw new Error("模型未返回有效消息");
      const normalized = normalizedAssistant(assistant);
      const availableCalls = normalized.calls.filter(raw => registry.has(raw.function.name));
      const unavailableCalls = normalized.calls.filter(raw => !registry.has(raw.function.name));
      const normalizedMessage = availableCalls.length === normalized.calls.length ? normalized.message : {
        ...normalized.message,
        tool_calls: availableCalls.length ? availableCalls : undefined,
      };
      if (normalizedMessage.content || normalizedMessage.tool_calls?.length) messages.push(normalizedMessage);
      const content = normalized.content;
      if (content) emit({ type: "text", round, content });
      const rawCalls = availableCalls;
      if (unavailableCalls.length) {
        messages.push({ role: "user", content: `以下工具当前不可用，不得再次调用：${[...new Set(unavailableCalls.map(call => call.function.name))].join("、")}。请使用当前提供的工具继续，或直接完成任务。`, transient: true });
      }
      if (!rawCalls.length) {
        if (requiredFirstTool) {
          messages.push({ role: "user", content: `执行任务前必须先调用 ${requiredFirstTool} 创建计划。不要输出说明，立即调用该工具。`, transient: true });
          continue;
        }
        if (unavailableCalls.length) continue;
        await finalizeTodos(round);
        emit({ type: "run_completed", summary: content || "Agent 已完成任务" });
        return { messages: persistentAgentMessages(messages), summary: content, status: "completed" as const };
      }
      for (const raw of rawCalls) {
        const parsed = parseArguments(raw.function.arguments);
        const call: AgentToolCall = { id: raw.id || makeEventId(), name: raw.function.name, arguments: parsed.arguments };
        emit({ type: "tool_call", round, call });
        emit({ type: "tool_started", round, callId: call.id });
        const result = parsed.error
          ? { content: parsed.error, data: { invalidArguments: raw.function.arguments }, isError: true }
          : await registry.execute(call, signal);
        emit({ type: "tool_result", round, call, result });
        messages.push({ role: "tool", tool_call_id: call.id, content: result.content, tool_result_data: result.data, tool_result_is_error: result.isError });
        if (call.name === requiredFirstTool && !result.isError) requiredFirstTool = null;
        const nextTodos = !result.isError ? trackedTodos(call) : null;
        if (nextTodos) latestTodos = nextTodos;
      }
    }
    await finalizeTodos(maxRounds);
    emit({ type: "round_limit_reached", maxRounds });
    return { messages: persistentAgentMessages(messages), summary: `已达到 ${maxRounds} 轮执行上限`, status: "round_limit_reached" as const };
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      emit({ type: "run_cancelled" });
      return {
        messages: persistentAgentMessages(completedMessages(messages)),
        summary: "Agent 已停止",
        status: "cancelled" as const,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "run_failed", error: message });
    throw error;
  }
}
