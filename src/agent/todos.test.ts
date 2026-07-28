import { describe, expect, it } from "vitest";
import { latestTodosFromMessages } from "./todos";
import type { AgentMessage } from "./protocol";

describe("latestTodosFromMessages", () => {
  it("restores the latest successful complete snapshot", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "one", type: "function", function: { name: "write_todo", arguments: JSON.stringify({ todos: [{ content: "读取", status: "in_progress", activeForm: "正在读取" }] }) } }] },
      { role: "tool", tool_call_id: "one", content: "ok", tool_result_is_error: false },
      { role: "assistant", content: null, tool_calls: [{ id: "two", type: "function", function: { name: "write_todo", arguments: JSON.stringify({ todos: [{ content: "读取", status: "completed", activeForm: "正在读取" }, { content: "写作", status: "in_progress", activeForm: "正在写作" }] }) } }] },
      { role: "tool", tool_call_id: "two", content: "ok", tool_result_data: [{ content: "读取", status: "completed", activeForm: "正在读取" }, { content: "写作", status: "in_progress", activeForm: "正在写作" }], tool_result_is_error: false },
    ];
    expect(latestTodosFromMessages(messages)).toEqual([
      { content: "读取", status: "completed", activeForm: "正在读取" },
      { content: "写作", status: "in_progress", activeForm: "正在写作" },
    ]);
  });

  it("ignores failed updates", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "bad", type: "function", function: { name: "write_todo", arguments: JSON.stringify({ todos: [{ content: "错误计划", status: "pending", activeForm: "错误计划" }] }) } }] },
      { role: "tool", tool_call_id: "bad", content: "invalid", tool_result_is_error: true },
    ];
    expect(latestTodosFromMessages(messages)).toEqual([]);
  });
});
