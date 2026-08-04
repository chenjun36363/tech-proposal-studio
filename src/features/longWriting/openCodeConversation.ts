export type OpenCodeConversationRole = "user" | "assistant" | "system" | "unknown";

export interface OpenCodeConversationPart {
  id: string;
  kind: "text" | "tool" | "error" | "unknown";
  text?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  rawType?: string;
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
}

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

function normalizePart(value: unknown, index: number): OpenCodeConversationPart {
  const part = record(value);
  if (!part) return { id: `part-${index}`, kind: "unknown", rawType: typeof value };
  const type = stringValue(part.type) ?? "unknown";
  const id = stringValue(part.id, part.callID, part.callId) ?? `part-${index}`;
  if (type === "reasoning") return { id, kind: "unknown", rawType: type };
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
        ...parts.map(normalizePart),
      ],
    };
  });
}

export function formatConversationValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
