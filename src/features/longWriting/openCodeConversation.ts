export type OpenCodeConversationRole = "user" | "assistant" | "system" | "unknown";

export interface OpenCodeConversationPart {
  id: string;
  kind: "text" | "reasoning" | "tool" | "error" | "unknown";
  text?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  rawType?: string;
  streaming?: boolean;
}

export interface OpenCodeConversationMessage {
  id: string;
  role: OpenCodeConversationRole;
  createdAt?: string;
  completedAt?: string;
  model?: string;
  system?: string;
  error?: string;
  parts: OpenCodeConversationPart[];
  streaming?: boolean;
  phase?: "analysis" | "write";
  local?: boolean;
}

export type OpenCodeConversationMap = Record<string, OpenCodeConversationMessage[]>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(...values: unknown[]) {
  return values.find(value => typeof value === "string" && value.trim()) as string | undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "number") return undefined;
  const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  const item = record(value);
  if (!item) return undefined;
  const data = record(item.data);
  return stringValue(item.message, data?.message, item.name, item.code, data?.code);
}

function normalizeRole(value: unknown): OpenCodeConversationRole {
  return value === "user" || value === "assistant" || value === "system" ? value : "unknown";
}

export function normalizeOpenCodeConversationPart(value: unknown, index: number): OpenCodeConversationPart {
  const part = record(value);
  if (!part) return { id: `part-${index}`, kind: "unknown", rawType: typeof value };
  const type = stringValue(part.type) ?? "unknown";
  const id = stringValue(part.id, part.callID, part.callId) ?? `part-${index}`;
  if (type === "reasoning") {
    const text = stringValue(part.text, part.content, part.reasoning);
    return { id, kind: "reasoning", text: text ?? "", rawType: type };
  }
  if (type === "text") {
    const text = stringValue(part.text, part.content);
    return { id, kind: "text", text: text ?? "", rawType: type };
  }
  if (type === "tool" || type === "tool-call" || type === "tool_result" || type === "tool-result") {
    const state = record(part.state);
    const status = stringValue(state?.status, part.status) ?? "unknown";
    return {
      id,
      kind: "tool",
      tool: stringValue(part.tool, part.name, state?.title) ?? "未知工具",
      status,
      input: state?.input ?? part.input ?? part.arguments,
      output: state?.output ?? part.output ?? part.result,
      error: errorText(state?.error ?? part.error),
      rawType: type,
    };
  }
  if (type === "error") {
    return { id, kind: "error", error: errorText(part.error ?? part) ?? "OpenCode 返回错误", rawType: type };
  }
  return {
    id,
    kind: "unknown",
    text: stringValue(part.text, part.content),
    rawType: type,
  };
}

export function normalizeOpenCodeConversation(value: unknown): OpenCodeConversationMessage[] {
  const root = record(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(root?.messages)
      ? root.messages
      : Array.isArray(root?.data)
        ? root.data
        : [];
  return rows.map((row, index) => {
    const message = record(row);
    const info = record(message?.info) ?? message;
    const time = record(info?.time);
    const model = record(info?.model);
    const parts = Array.isArray(message?.parts) ? message.parts : Array.isArray(info?.parts) ? info.parts : [];
    const system = stringValue(info?.system, message?.system);
    return {
      id: stringValue(info?.id, message?.id) ?? `message-${index}`,
      role: normalizeRole(info?.role),
      createdAt: timestamp(time?.created ?? info?.createdAt ?? info?.created_at),
      completedAt: timestamp(time?.completed ?? info?.completedAt ?? info?.completed_at),
      model: stringValue(model?.modelID, model?.modelId, info?.modelID, info?.modelId),
      system,
      error: errorText(info?.error),
      parts: [
        ...(system ? [{ id: `system-${index}`, kind: "text" as const, text: system, rawType: "system" }] : []),
        ...parts.map(normalizeOpenCodeConversationPart),
      ],
    };
  });
}

export function formatConversationValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}


function eventRecord(value: unknown): { event: Record<string, unknown>; properties: Record<string, unknown> } | null {
  const envelope = record(value);
  if (!envelope) return null;
  // OpenCode /global/event wraps the normal event as { directory, payload }.
  // Accept both forms so browser tests and older desktop backends remain compatible.
  const event = record(envelope.payload) ?? envelope;
  const properties = record(event.properties) ?? record(event.data) ?? event;
  return properties ? { event, properties } : null;
}

function eventSessionId(properties: Record<string, unknown>) {
  const part = record(properties.part);
  return stringValue(properties.sessionID, properties.sessionId, part?.sessionID, part?.sessionId);
}

function eventTimestamp(properties: Record<string, unknown>) {
  const time = record(properties.time);
  return timestamp(properties.timestamp ?? properties.created ?? time?.created);
}

function setMessagePart(message: OpenCodeConversationMessage, nextPart: OpenCodeConversationPart) {
  const index = message.parts.findIndex(part => part.id === nextPart.id);
  const parts = index < 0
    ? [...message.parts, nextPart]
    : message.parts.map((part, partIndex) => partIndex === index ? { ...part, ...nextPart } : part);
  return { ...message, parts };
}

function updateLiveMessage(
  current: OpenCodeConversationMap,
  sessionId: string,
  messageId: string,
  updater: (message: OpenCodeConversationMessage) => OpenCodeConversationMessage,
  at?: string,
): OpenCodeConversationMap {
  const existing = current[sessionId] ?? [];
  const index = existing.findIndex(message => message.id === messageId);
  const previous = index < 0
    ? { id: messageId, role: "assistant" as const, createdAt: at, parts: [] }
    : existing[index];
  const nextMessage = updater(previous);
  const messages = index < 0 ? [...existing, nextMessage] : existing.map((message, messageIndex) => messageIndex === index ? nextMessage : message);
  return { ...current, [sessionId]: messages.slice(-120) };
}

function latestAssistantMessage(messages: OpenCodeConversationMessage[]) {
  return [...messages].reverse().find(message => message.role === "assistant");
}

export function appendOpenCodeConversationInput(
  current: OpenCodeConversationMap,
  input: { sessionId: string; text: string; phase: "analysis" | "write"; id?: string; at?: string },
): OpenCodeConversationMap {
  const text = input.text.trim();
  if (!input.sessionId || !text) return current;
  const createdAt = input.at ?? new Date().toISOString();
  const id = input.id ?? `local-user-${input.phase}-${createdAt}`;
  const existing = current[input.sessionId] ?? [];
  if (existing.some(message => message.id === id)) return current;
  const message: OpenCodeConversationMessage = {
    id,
    role: "user",
    createdAt,
    completedAt: createdAt,
    phase: input.phase,
    local: true,
    parts: [{ id: `${id}:text`, kind: "text", text, rawType: "text" }],
  };
  return { ...current, [input.sessionId]: [...existing, message].slice(-120) };
}

function resolveAssistantMessageId(
  current: OpenCodeConversationMap,
  sessionId: string,
  properties: Record<string, unknown>,
) {
  return stringValue(
    properties.assistantMessageID,
    properties.assistantMessageId,
    properties.messageID,
    properties.messageId,
  ) ?? latestAssistantMessage(current[sessionId] ?? [])?.id ?? `live-${sessionId}`;
}

function updateLatestAssistant(
  current: OpenCodeConversationMap,
  sessionId: string,
  updater: (message: OpenCodeConversationMessage) => OpenCodeConversationMessage,
) {
  const messages = current[sessionId] ?? [];
  const latest = latestAssistantMessage(messages);
  if (!latest) return current;
  return updateLiveMessage(current, sessionId, latest.id, updater, latest.createdAt);
}

function eventPartId(properties: Record<string, unknown>, fallback: string) {
  return stringValue(properties.partID, properties.partId, properties.callID, properties.callId, properties.ordinal) ?? fallback;
}

function applyTextDelta(
  current: OpenCodeConversationMap,
  sessionId: string,
  messageId: string,
  partId: string,
  delta: string,
  at?: string,
  ended = false,
  kind?: "text" | "reasoning",
) {
  return updateLiveMessage(current, sessionId, messageId, message => {
    const previous = message.parts.find(part => part.id === partId);
    const resolvedKind = kind ?? (previous?.kind === "reasoning" ? "reasoning" : "text");
    const text = `${previous?.text ?? ""}${delta}`;
    return {
      ...setMessagePart(message, { id: partId, kind: resolvedKind, text, rawType: resolvedKind, streaming: !ended }),
      streaming: !ended,
    };
  }, at);
}

/**
 * Projects OpenCode's SSE events into the same message/part shape used by the
 * conversation modal. Reasoning is retained only when OpenCode explicitly emits
 * it as a visible part/event; model-internal hidden reasoning is not available.
 * The projection stays in memory until the durable session endpoint catches up.
 */
export function applyOpenCodeConversationEvent(current: OpenCodeConversationMap, value: unknown): OpenCodeConversationMap | null {
  const envelope = eventRecord(value);
  if (!envelope) return null;
  const { event, properties } = envelope;
  const type = typeof event.type === "string" ? event.type : "";
  const sessionId = eventSessionId(properties);
  if (!sessionId || !type) return null;
  const at = eventTimestamp(properties) ?? new Date().toISOString();

  if (type === "message.part.updated") {
    const part = record(properties.part);
    if (!part) return current;
    const messageId = stringValue(part.messageID, part.messageId, properties.messageID, properties.messageId);
    if (!messageId) return current;
    const normalized = normalizeOpenCodeConversationPart(part, 0);
    const time = record(part.time);
    return updateLiveMessage(current, sessionId, messageId, message => ({
      ...setMessagePart(message, { ...normalized, streaming: !time?.end && (normalized.kind === "text" || normalized.kind === "reasoning") }),
      createdAt: message.createdAt ?? at,
      completedAt: timestamp(time?.end),
      streaming: !time?.end && (normalized.kind === "text" || normalized.kind === "reasoning" || normalized.kind === "tool"),
    }), at);
  }

  if (type === "message.part.delta") {
    const field = stringValue(properties.field);
    const delta = typeof properties.delta === "string" ? properties.delta : "";
    const messageId = stringValue(properties.messageID, properties.messageId);
    const partId = eventPartId(properties, "live-part");
    if (!messageId || !delta) return current;
    if (field === "reasoning" || field === "text.reasoning") {
      return applyTextDelta(current, sessionId, messageId, partId, delta, at, false, "reasoning");
    }
    if (field === "text" || field === "content" || field === "text.text") {
      return applyTextDelta(current, sessionId, messageId, partId, delta, at);
    }
    if (field?.includes("input")) {
      return updateLiveMessage(current, sessionId, messageId, message => {
        const previous = message.parts.find(part => part.id === partId);
        return {
          ...setMessagePart(message, { id: partId, kind: "tool", tool: previous?.tool ?? "未知工具", status: "streaming", input: `${formatConversationValue(previous?.input)}${delta}`, rawType: "tool", streaming: true }),
          streaming: true,
        };
      }, at);
    }
    return current;
  }

  const messageId = stringValue(properties.assistantMessageID, properties.assistantMessageId, properties.messageID, properties.messageId);
  const ordinal = stringValue(properties.ordinal) ?? "0";
  if (type === "session.reasoning.started") {
    if (!messageId) return current;
    return updateLiveMessage(current, sessionId, messageId, message => ({
      ...setMessagePart(message, { id: `reasoning:${ordinal}`, kind: "reasoning", text: "", rawType: "reasoning", streaming: true }),
      createdAt: message.createdAt ?? at,
      streaming: true,
    }), at);
  }
  if (type === "session.reasoning.delta") {
    if (!messageId || typeof properties.delta !== "string") return current;
    return applyTextDelta(current, sessionId, messageId, `reasoning:${ordinal}`, properties.delta, at, false, "reasoning");
  }
  if (type === "session.reasoning.ended") {
    if (!messageId) return current;
    const text = typeof properties.text === "string" ? properties.text : undefined;
    return updateLiveMessage(current, sessionId, messageId, message => {
      const partId = `reasoning:${ordinal}`;
      const previous = message.parts.find(part => part.id === partId);
      return {
        ...setMessagePart(message, { id: partId, kind: "reasoning", text: text ?? previous?.text ?? "", rawType: "reasoning", streaming: false }),
        streaming: message.parts.some(part => part.id !== partId && part.streaming),
      };
    }, at);
  }
  if (type === "session.text.started") {
    if (!messageId) return current;
    return updateLiveMessage(current, sessionId, messageId, message => ({
      ...setMessagePart(message, { id: `text:${ordinal}`, kind: "text", text: "", rawType: "text", streaming: true }),
      createdAt: message.createdAt ?? at,
      streaming: true,
    }), at);
  }
  if (type === "session.text.delta") {
    if (!messageId || typeof properties.delta !== "string") return current;
    return applyTextDelta(current, sessionId, messageId, `text:${ordinal}`, properties.delta, at);
  }
  if (type === "session.text.ended") {
    if (!messageId) return current;
    const text = typeof properties.text === "string" ? properties.text : "";
    return updateLiveMessage(current, sessionId, messageId, message => ({
      ...setMessagePart(message, { id: `text:${ordinal}`, kind: "text", text, rawType: "text", streaming: false }),
      streaming: false,
    }), at);
  }
  if (type === "session.tool.input.started" || type === "session.next.tool.called") {
    const id = resolveAssistantMessageId(current, sessionId, properties);
    const partId = eventPartId(properties, `tool:${ordinal}`);
    const tool = stringValue(properties.name, properties.tool) ?? "未知工具";
    return updateLiveMessage(current, sessionId, id, message => ({
      ...setMessagePart(message, { id: partId, kind: "tool", tool, status: "streaming", input: properties.input, rawType: "tool", streaming: true }),
      createdAt: message.createdAt ?? at,
      streaming: true,
    }), at);
  }
  if (type === "session.tool.input.delta") {
    if (typeof properties.delta !== "string") return current;
    const id = resolveAssistantMessageId(current, sessionId, properties);
    const partId = eventPartId(properties, `tool:${ordinal}`);
    return updateLiveMessage(current, sessionId, id, message => {
      const previous = message.parts.find(part => part.id === partId);
      return {
        ...setMessagePart(message, { id: partId, kind: "tool", tool: previous?.tool ?? "未知工具", status: "streaming", input: `${formatConversationValue(previous?.input)}${properties.delta}`, rawType: "tool", streaming: true }),
        streaming: true,
      };
    }, at);
  }
  if (type === "session.tool.called") {
    const id = resolveAssistantMessageId(current, sessionId, properties);
    const partId = eventPartId(properties, `tool:${ordinal}`);
    return updateLiveMessage(current, sessionId, id, message => {
      const previous = message.parts.find(part => part.id === partId);
      return {
        ...setMessagePart(message, {
          id: partId,
          kind: "tool",
          tool: stringValue(properties.name, properties.tool, previous?.tool) ?? "未知工具",
          status: "running",
          input: properties.input ?? previous?.input,
          rawType: "tool",
          streaming: true,
        }),
        streaming: true,
      };
    }, at);
  }
  if (type === "session.tool.success" || type === "session.next.tool.success" || type === "session.tool.failed" || type === "session.next.tool.failed") {
    const id = resolveAssistantMessageId(current, sessionId, properties);
    const partId = eventPartId(properties, `tool:${ordinal}`);
    return updateLiveMessage(current, sessionId, id, message => {
      const previous = message.parts.find(part => part.id === partId);
      const failed = type.includes("failed");
      return {
        ...setMessagePart(message, { id: partId, kind: "tool", tool: stringValue(properties.name, properties.tool, previous?.tool) ?? "未知工具", status: failed ? "error" : "completed", input: previous?.input, output: properties.output ?? properties.result, error: failed ? formatConversationValue(properties.error) : undefined, rawType: "tool", streaming: false }),
        streaming: message.parts.some(part => part.id !== partId && part.streaming),
      };
    }, at);
  }
  if (type === "session.next.reasoning.delta") {
    if (typeof properties.delta !== "string") return current;
    return applyTextDelta(current, sessionId, `live-${sessionId}`, "live-reasoning", properties.delta, at, false, "reasoning");
  }
  if (type === "session.next.text.delta") {
    if (typeof properties.delta !== "string") return current;
    return applyTextDelta(current, sessionId, `live-${sessionId}`, "live-text", properties.delta, at);
  }
  if (type === "session.status") {
    const status = record(properties.status);
    const running = stringValue(status?.type) !== "idle";
    return updateLatestAssistant(current, sessionId, message => ({
      ...message,
      streaming: running,
      parts: running ? message.parts : message.parts.map(part => ({ ...part, streaming: false })),
    }));
  }
  if (type === "session.idle" || type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") {
    return updateLatestAssistant(current, sessionId, message => ({ ...message, parts: message.parts.map(part => ({ ...part, streaming: false })), streaming: false, completedAt: message.completedAt ?? at }));
  }
  if (type === "session.error") {
    return updateLatestAssistant(current, sessionId, message => ({ ...message, parts: message.parts.map(part => ({ ...part, streaming: false })), error: errorText(properties.error) ?? "OpenCode 返回错误", streaming: false }));
  }
  return null;
}

function mergeConversationPart(base: OpenCodeConversationPart, incoming: OpenCodeConversationPart): OpenCodeConversationPart {
  const text = base.text !== undefined && incoming.text !== undefined
    ? (incoming.text.length >= base.text.length ? incoming.text : base.text)
    : incoming.text ?? base.text;
  return { ...base, ...incoming, ...(text === undefined ? {} : { text }), streaming: incoming.streaming ?? base.streaming };
}

function mergeConversationMessage(base: OpenCodeConversationMessage, incoming: OpenCodeConversationMessage): OpenCodeConversationMessage {
  const parts = [...base.parts];
  incoming.parts.forEach(part => {
    const index = parts.findIndex(item => item.id === part.id);
    if (index < 0) parts.push(part);
    else parts[index] = mergeConversationPart(parts[index], part);
  });
  return {
    ...base,
    ...incoming,
    createdAt: base.createdAt ?? incoming.createdAt,
    completedAt: incoming.completedAt ?? base.completedAt,
    error: incoming.error ?? base.error,
    parts,
    streaming: incoming.streaming ?? base.streaming,
  };
}

/** Combines the durable session snapshot with the in-memory SSE projection. */
export function mergeOpenCodeConversations(
  durable: OpenCodeConversationMessage[],
  live: OpenCodeConversationMessage[] = [],
): OpenCodeConversationMessage[] {
  const result = durable.map(message => ({ ...message, parts: [...message.parts] }));
  for (const incoming of live) {
    const exactIndex = result.findIndex(message => message.id === incoming.id);
    if (exactIndex >= 0) {
      result[exactIndex] = mergeConversationMessage(result[exactIndex], incoming);
      continue;
    }
    const incomingText = incoming.parts.find(part => part.kind === "text")?.text?.trim();
    if (incoming.local && incoming.role === "user" && incomingText) {
      let durableInputIndex = -1;
      for (let index = result.length - 1; index >= 0; index -= 1) {
        const message = result[index];
        if (message.role === "user" && message.parts.some(part => part.kind === "text" && part.text?.trim() === incomingText)) {
          durableInputIndex = index;
          break;
        }
      }
      if (durableInputIndex >= 0) {
        result[durableInputIndex] = { ...result[durableInputIndex], phase: incoming.phase, local: false };
        continue;
      }
    }
    const synthetic = incoming.id.startsWith("live-") && incoming.role === "assistant";
    let matchingIndex = -1;
    if (synthetic) {
      const incomingPartIds = new Set(incoming.parts.map(part => part.id));
      for (let index = result.length - 1; index >= 0; index -= 1) {
        const message = result[index];
        if (message.role !== "assistant") continue;
        const matchingText = incomingText && message.parts.some(part => {
          const text = part.text?.trim() ?? "";
          return text === incomingText || text.startsWith(incomingText) || incomingText.startsWith(text);
        });
        if (matchingText || message.parts.some(part => incomingPartIds.has(part.id))) {
          matchingIndex = index;
          break;
        }
      }
    }
    if (matchingIndex >= 0) result[matchingIndex] = mergeConversationMessage(result[matchingIndex], incoming);
    else result.push(incoming);
  }
  return result;
}
