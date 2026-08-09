import { describe, expect, it } from "vitest";
import { appendOpenCodeConversationInput, applyOpenCodeConversationEvent, mergeOpenCodeConversations, normalizeOpenCodeConversation, type OpenCodeConversationMap } from "./openCodeConversation";

describe("normalizeOpenCodeConversation", () => {
  it("normalizes visible prompts, replies, tools and results", () => {
    const messages = normalizeOpenCodeConversation([
      {
        info: {
          id: "user-1",
          role: "user",
          system: "只读取目标章节",
          time: { created: 1_700_000_000_000 },
        },
        parts: [{ id: "text-1", type: "text", text: "请优化部署章节" }],
      },
      {
        info: { id: "assistant-1", role: "assistant", modelID: "gpt-5", time: { created: 1_700_000_001_000 } },
        parts: [
          { id: "text-2", type: "text", text: "我先读取文件。" },
          { id: "tool-1", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "proposal.md" }, output: "正文" } },
        ],
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", system: "只读取目标章节" });
    expect(messages[0].parts.map(part => part.text)).toContain("请优化部署章节");
    expect(messages[1].parts[1]).toMatchObject({
      kind: "tool",
      tool: "read",
      status: "completed",
      input: { filePath: "proposal.md" },
      output: "正文",
    });
  });

  it("degrades unknown parts and errors without dropping the message", () => {
    const messages = normalizeOpenCodeConversation({
      messages: [{
        id: "assistant-2",
        role: "assistant",
        error: { message: "模型失败" },
        parts: [{ id: "part-x", type: "future-part", content: "可见内容" }],
      }],
    });

    expect(messages[0].error).toBe("模型失败");
    expect(messages[0].parts[0]).toMatchObject({ kind: "unknown", rawType: "future-part", text: "可见内容" });
  });

  it("preserves reasoning parts explicitly returned by OpenCode", () => {
    const messages = normalizeOpenCodeConversation([{
      id: "assistant-3",
      role: "assistant",
      parts: [{ id: "reasoning-1", type: "reasoning", text: "可见思考内容" }],
    }]);

    expect(messages[0].parts[0]).toEqual({ id: "reasoning-1", kind: "reasoning", text: "可见思考内容", rawType: "reasoning" });
  });
});


describe("OpenCode streaming conversation projection", () => {
  it("shows the worker input immediately before OpenCode responds", () => {
    const live = appendOpenCodeConversationInput({}, {
      sessionId: "ses-input",
      text: "请分析部署章节",
      phase: "analysis",
      id: "prompt-1",
      at: "2026-08-09T08:00:00.000Z",
    });

    expect(live["ses-input"][0]).toMatchObject({
      id: "prompt-1",
      role: "user",
      phase: "analysis",
      local: true,
      parts: [{ kind: "text", text: "请分析部署章节" }],
    });
  });

  it("projects tool calls even when OpenCode omits the assistant message id", () => {
    let live: OpenCodeConversationMap = appendOpenCodeConversationInput({}, {
      sessionId: "ses-tool",
      text: "读取正式文件",
      phase: "write",
      id: "prompt-tool",
    });
    live = applyOpenCodeConversationEvent(live, {
      type: "session.tool.called",
      data: { sessionID: "ses-tool", callID: "call-1", tool: "read", input: { filePath: "proposal.md" } },
    }) ?? live;
    live = applyOpenCodeConversationEvent(live, {
      type: "session.tool.success",
      data: { sessionID: "ses-tool", callID: "call-1", tool: "read", output: "正文" },
    }) ?? live;

    const tool = live["ses-tool"].flatMap(message => message.parts).find(part => part.id === "call-1");
    expect(tool).toMatchObject({ kind: "tool", tool: "read", status: "completed", input: { filePath: "proposal.md" }, output: "正文", streaming: false });
  });
  it("accumulates message part deltas into an assistant message", () => {
    let live: OpenCodeConversationMap = {};
    live = applyOpenCodeConversationEvent(live, {
      type: "message.part.updated",
      properties: {
        part: { id: "part-1", messageID: "msg-1", sessionID: "ses-1", type: "text", text: "正在" },
      },
    }) ?? live;
    live = applyOpenCodeConversationEvent(live, {
      type: "message.part.delta",
      properties: { sessionID: "ses-1", messageID: "msg-1", partID: "part-1", field: "text", delta: "生成" },
    }) ?? live;

    expect(live["ses-1"][0]).toMatchObject({ id: "msg-1", role: "assistant", streaming: true });
    expect(live["ses-1"][0].parts[0]).toMatchObject({ id: "part-1", kind: "text", text: "正在生成", streaming: true });
  });

  it("unwraps global event envelopes before projecting streamed parts", () => {
    const live = applyOpenCodeConversationEvent({}, {
      directory: "D:\\workspace",
      payload: {
        type: "message.part.updated",
        properties: {
          part: { id: "global-part", messageID: "global-message", sessionID: "global-session", type: "reasoning", text: "检查文件" },
        },
      },
    });

    expect(live?.["global-session"][0].parts[0]).toMatchObject({ kind: "reasoning", text: "检查文件" });
  });

  it("keeps a reasoning part classified when generic text deltas arrive", () => {
    let live: OpenCodeConversationMap = {};
    live = applyOpenCodeConversationEvent(live, {
      type: "message.part.updated",
      properties: { part: { id: "reason-1", messageID: "msg-reason", sessionID: "ses-reason", type: "reasoning", text: "先检查" } },
    }) ?? live;
    live = applyOpenCodeConversationEvent(live, {
      type: "message.part.delta",
      properties: { sessionID: "ses-reason", messageID: "msg-reason", partID: "reason-1", field: "text", delta: "上下文" },
    }) ?? live;

    expect(live["ses-reason"][0].parts[0]).toMatchObject({ kind: "reasoning", text: "先检查上下文", streaming: true });
  });

  it("streams OpenCode v2 text and visible reasoning events together", () => {
    let live: OpenCodeConversationMap = {};
    live = applyOpenCodeConversationEvent(live, {
      type: "session.text.started",
      data: { sessionID: "ses-2", assistantMessageID: "msg-2", ordinal: "0" },
    }) ?? live;
    live = applyOpenCodeConversationEvent(live, {
      type: "session.text.delta",
      data: { sessionID: "ses-2", assistantMessageID: "msg-2", ordinal: "0", delta: "实时输出" },
    }) ?? live;
    live = applyOpenCodeConversationEvent(live, {
      type: "session.reasoning.delta",
      data: { sessionID: "ses-2", assistantMessageID: "msg-2", ordinal: "1", delta: "可见思考" },
    }) ?? live;

    expect(live["ses-2"][0].parts).toEqual([
      { id: "text:0", kind: "text", text: "实时输出", rawType: "text", streaming: true },
      { id: "reasoning:1", kind: "reasoning", text: "可见思考", rawType: "reasoning", streaming: true },
    ]);
  });

  it("settles message and part streaming flags when the session becomes idle", () => {
    let live: OpenCodeConversationMap = {};
    live = applyOpenCodeConversationEvent(live, {
      type: "session.next.text.delta",
      properties: { sessionID: "ses-idle", delta: "正在生成" },
    }) ?? live;
    live = applyOpenCodeConversationEvent(live, {
      type: "session.idle",
      properties: { sessionID: "ses-idle" },
    }) ?? live;

    expect(live["ses-idle"][0].streaming).toBe(false);
    expect(live["ses-idle"][0].parts[0].streaming).toBe(false);
  });

  it("reconciles an optimistic local input with the durable user message", () => {
    const durable = normalizeOpenCodeConversation([{ id: "user-durable", role: "user", parts: [{ id: "text-durable", type: "text", text: "请优化部署章节" }] }]);
    const live = appendOpenCodeConversationInput({}, { sessionId: "ses-merge", text: "请优化部署章节", phase: "write", id: "prompt-local" })["ses-merge"];
    const merged = mergeOpenCodeConversations(durable, live);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "user-durable", role: "user", phase: "write", local: false });
  });

  it("merges live content into the durable conversation snapshot", () => {
    const durable = normalizeOpenCodeConversation([{ id: "msg-3", role: "assistant", parts: [{ id: "part-3", type: "text", text: "正在" }] }]);
    const live = [{ id: "msg-3", role: "assistant" as const, streaming: true, parts: [{ id: "part-3", kind: "text" as const, text: "正在生成", rawType: "text", streaming: true }] }];
    expect(mergeOpenCodeConversations(durable, live)[0]).toMatchObject({ streaming: true, parts: [{ text: "正在生成" }] });
  });
});
