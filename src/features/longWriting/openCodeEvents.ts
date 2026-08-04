export type OpenCodeSessionActivityKind = "status" | "text" | "tool" | "error";

export interface OpenCodeSessionActivity {
  id: string;
  sessionId: string;
  kind: OpenCodeSessionActivityKind;
  summary: string;
  at: string;
}

export type OpenCodeSessionActivityMap = Record<string, OpenCodeSessionActivity[]>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function bounded(value: string, limit = 2000) {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function eventTime(properties: Record<string, unknown>) {
  const timestamp = typeof properties.timestamp === "number" ? properties.timestamp : Date.now();
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function errorSummary(value: unknown): string {
  const error = record(value);
  if (!error) return "OpenCode session 出错";
  const data = record(error.data);
  for (const candidate of [error.message, data?.message, error.name, error.code, data?.code]) {
    if (typeof candidate === "string" && candidate.trim()) return bounded(candidate, 500);
  }
  return "OpenCode session 出错";
}

export function normalizeOpenCodeSessionEvent(value: unknown): OpenCodeSessionActivity | null {
  const event = record(value);
  const properties = record(event?.properties);
  const sessionId = typeof properties?.sessionID === "string" ? properties.sessionID : null;
  const type = typeof event?.type === "string" ? event.type : null;
  if (!event || !properties || !sessionId || !type) return null;
  const base = {
    id: typeof event.id === "string" ? event.id : `opencode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId,
    at: eventTime(properties),
  };

  if (type === "session.next.text.delta" && typeof properties.delta === "string") {
    const summary = bounded(properties.delta);
    return summary ? { ...base, kind: "text", summary } : null;
  }
  if (type === "session.next.tool.called" && typeof properties.tool === "string") {
    return { ...base, kind: "tool", summary: `调用工具：${bounded(properties.tool, 120)}` };
  }
  if (type === "session.next.tool.success") {
    return { ...base, kind: "tool", summary: "工具执行完成" };
  }
  if (type === "session.next.tool.failed") {
    return { ...base, kind: "error", summary: `工具执行失败：${errorSummary(properties.error)}` };
  }
  if (type === "session.status") {
    const status = record(properties.status);
    const statusType = typeof status?.type === "string" ? status.type : "状态更新";
    return { ...base, kind: "status", summary: `状态：${bounded(statusType, 120)}` };
  }
  if (type === "session.idle") {
    return { ...base, kind: "status", summary: "会话空闲" };
  }
  if (type === "session.error") {
    return { ...base, kind: "error", summary: errorSummary(properties.error) };
  }
  return null;
}

export function appendOpenCodeSessionActivity(
  current: OpenCodeSessionActivityMap,
  activity: OpenCodeSessionActivity,
  perSessionLimit = 120,
  sessionLimit = 64,
): OpenCodeSessionActivityMap {
  const existing = current[activity.sessionId] ?? [];
  const last = existing.at(-1);
  let nextActivities: OpenCodeSessionActivity[];
  if (activity.kind === "text" && last?.kind === "text") {
    nextActivities = [...existing.slice(0, -1), {
      ...last,
      id: activity.id,
      at: activity.at,
      summary: bounded(`${last.summary}${activity.summary}`, 4000),
    }];
  } else if (last?.kind === activity.kind && last.summary === activity.summary) {
    nextActivities = [...existing.slice(0, -1), activity];
  } else {
    nextActivities = [...existing, activity];
  }
  const next = { ...current, [activity.sessionId]: nextActivities.slice(-perSessionLimit) };
  const sessionIds = Object.keys(next);
  if (sessionIds.length > sessionLimit) delete next[sessionIds[0]];
  return next;
}
