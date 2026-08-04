import { describe, expect, it } from "vitest";
import { appendOpenCodeSessionActivity, normalizeOpenCodeSessionEvent } from "./openCodeEvents";

describe("OpenCode session events", () => {
  it("maps visible text, status, tools, and errors to a session", () => {
    expect(normalizeOpenCodeSessionEvent({
      id: "evt_text",
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", timestamp: 1_700_000_000_000, delta: "正在分析章节" },
    })).toMatchObject({ sessionId: "ses_1", kind: "text", summary: "正在分析章节" });
    expect(normalizeOpenCodeSessionEvent({
      id: "evt_tool",
      type: "session.next.tool.called",
      properties: { sessionID: "ses_1", tool: "read", input: { apiKey: "must-not-leak" } },
    })).toMatchObject({ kind: "tool", summary: "调用工具：read" });
    expect(normalizeOpenCodeSessionEvent({
      id: "evt_status",
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    })).toMatchObject({ kind: "status", summary: "状态：busy" });
    expect(normalizeOpenCodeSessionEvent({
      id: "evt_error",
      type: "session.error",
      properties: { sessionID: "ses_1", error: { data: { message: "provider failed" } } },
    })).toMatchObject({ kind: "error", summary: "provider failed" });
  });

  it("ignores reasoning and events without a session", () => {
    expect(normalizeOpenCodeSessionEvent({
      type: "session.next.reasoning.delta",
      properties: { sessionID: "ses_1", delta: "hidden" },
    })).toBeNull();
    expect(normalizeOpenCodeSessionEvent({ type: "file.edited", properties: { file: "proposal.md" } })).toBeNull();
  });

  it("coalesces text deltas and bounds per-session history", () => {
    const first = { id: "1", sessionId: "ses_1", kind: "text" as const, summary: "hello ", at: new Date(0).toISOString() };
    const second = { id: "2", sessionId: "ses_1", kind: "text" as const, summary: "world", at: new Date(1).toISOString() };
    const status = { id: "3", sessionId: "ses_1", kind: "status" as const, summary: "busy", at: new Date(2).toISOString() };
    let map = appendOpenCodeSessionActivity({}, first, 2);
    map = appendOpenCodeSessionActivity(map, second, 2);
    expect(map.ses_1).toHaveLength(1);
    expect(map.ses_1[0].summary).toBe("hello world");
    map = appendOpenCodeSessionActivity(map, status, 2);
    expect(map.ses_1).toHaveLength(2);
  });
});
