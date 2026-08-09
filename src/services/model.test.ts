// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCompletion, agentCompletionStream, improveBlockStream, isRetryableStreamError, runStreamAttemptWithRetry } from "./model";
import type { DocumentBlock, OpenAICompatibleConfig, ResolvedModelConfig } from "../core/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const config: OpenAICompatibleConfig = {
  baseUrl: "https://example.com/v1",
  apiKey: "",
  model: "example-model",
  timeoutMs: 1000,
  headers: {},
  enabled: true,
};

const block: DocumentBlock = {
  id: "block-1",
  sectionId: "markdown",
  type: "text",
  content: "原文",
  order: 0,
  status: "draft",
  sourceRefs: [],
};

const responsesConfig: ResolvedModelConfig = {
  ...config,
  providerId: "responses-provider",
  providerName: "Responses",
  protocol: "openai-responses",
};

describe("Tauri model adapter", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  it("lets Rust resolve an empty in-memory API key from keyring", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

    // Mock the listen function to capture the callback and simulate SSE events
    let eventCallback: ((event: { payload: { runId: string; content: string } }) => void) | null = null;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      eventCallback = callback as typeof eventCallback;
      return vi.fn(); // unlisten function
    });

    // Mock invoke to resolve immediately and trigger the event callback
    vi.mocked(invoke).mockImplementation(async (cmd, args: any) => {
      if (cmd === "model_proxy_stream" && eventCallback) {
        // Simulate SSE data events
        eventCallback({ payload: { runId: args.runId, content: '{"choices":[{"delta":{"content":"新"}}]}' } });
        eventCallback({ payload: { runId: args.runId, content: '{"choices":[{"delta":{"content":"正文"}}]}' } });
      }
      return undefined;
    });

    const result = await improveBlockStream(block, "优化", [], config, vi.fn());
    expect(result).toMatchObject({ after: "新正文" });
    expect(invoke).toHaveBeenCalledWith("model_proxy_stream", expect.objectContaining({
      request: expect.objectContaining({
        url: expect.stringContaining("/chat/completions"),
        protocol: "openai-completions",
      }),
    }));
  });

  it("keeps Responses reasoning events out of single AI rewrite output", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    let eventCallback: ((event: { payload: { runId: string; content: string } }) => void) | null = null;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      eventCallback = callback as typeof eventCallback;
      return vi.fn();
    });
    vi.mocked(invoke).mockImplementation(async (cmd, args: any) => {
      if (cmd === "model_proxy_stream" && eventCallback) {
        eventCallback({ payload: { runId: args.runId, content: "event: response.reasoning_summary_text.delta" } });
        eventCallback({ payload: { runId: args.runId, content: JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "内部推理" }) } });
        eventCallback({ payload: { runId: args.runId, content: "event: response.output_text.delta" } });
        eventCallback({ payload: { runId: args.runId, content: JSON.stringify({ type: "response.output_text.delta", delta: "修改后的正文" }) } });
      }
      return undefined;
    });
    const updates: string[] = [];

    const result = await improveBlockStream(block, "优化", [], responsesConfig, chunk => updates.push(chunk));

    expect(updates).toEqual(["修改后的正文"]);
    expect(result.after).toBe("修改后的正文");
  });

  it("streams Agent text while rebuilding the final tool call", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    let eventCallback: ((event: { payload: { runId: string; content: string } }) => void) | null = null;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      eventCallback = callback as typeof eventCallback;
      return vi.fn();
    });
    vi.mocked(invoke).mockImplementation(async (cmd, args: any) => {
      if (cmd === "model_proxy_stream" && eventCallback) {
        eventCallback({ payload: { runId: args.runId, content: '{"choices":[{"delta":{"reasoning_content":"分析约束"}}]}' } });
        eventCallback({ payload: { runId: args.runId, content: '{"choices":[{"delta":{"content":"正在"}}]}' } });
        eventCallback({ payload: { runId: args.runId, content: '{"choices":[{"delta":{"content":"处理","tool_calls":[{"index":0,"id":"call-1","function":{"name":"write_todo","arguments":"{\\"todos\\":[]}"}}]},"finish_reason":"tool_calls"}]}' } });
      }
      return undefined;
    });
    const updates: string[] = [];
    const reasoning: string[] = [];
    const response = await agentCompletionStream({
      model: "example-model",
      messages: [{ role: "user", content: "制定计划" }],
      tools: [{ type: "function", function: { name: "write_todo", description: "plan", parameters: { type: "object" } } }],
      tool_choice: "auto",
    }, config, chunk => updates.push(chunk), undefined, undefined, chunk => reasoning.push(chunk));

    expect(updates).toEqual(["正在", "处理"]);
    expect(reasoning).toEqual(["分析约束"]);
    expect(response.choices?.[0]?.message).toMatchObject({
      content: "正在处理",
      tool_calls: [{ id: "call-1", function: { name: "write_todo", arguments: '{"todos":[]}' } }],
    });
    expect(invoke).toHaveBeenCalledWith("model_proxy_stream", expect.objectContaining({
      request: expect.objectContaining({ body: expect.objectContaining({ stream: true }) }),
    }));
  });

  it("cancels an in-flight desktop JSON proxy request", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    let rejectProxy: ((reason?: unknown) => void) | null = null;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "model_proxy_json") return new Promise((_resolve, reject) => { rejectProxy = reject; });
      if (command === "model_proxy_cancel") {
        rejectProxy?.(new Error("模型请求已取消"));
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });
    const controller = new AbortController();
    const request = agentCompletion({ model: "example-model", messages: [{ role: "user", content: "test" }] }, config, controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    const jsonCall = vi.mocked(invoke).mock.calls.find(([command]) => command === "model_proxy_json");
    const cancelCall = vi.mocked(invoke).mock.calls.find(([command]) => command === "model_proxy_cancel");
    expect(jsonCall?.[1]).toEqual(expect.objectContaining({ runId: expect.any(String) }));
    expect(cancelCall?.[1]).toEqual(expect.objectContaining({ runId: (jsonCall?.[1] as { runId: string }).runId }));
  });
});

describe("stream retry (withStreamRetry semantics)", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  const fast = { maxAttempts: 3, backoffMs: () => 1 };

  it("retries a transient failure before any content commits and discards the failed attempt", async () => {
    let calls = 0;
    const updates: string[] = [];
    const retries: string[] = [];
    const after = await runStreamAttemptWithRetry(async emitter => {
      calls += 1;
      if (calls === 1) {
        emitter.reasoning("内部推理（应被丢弃）");
        throw new Error("模型服务请求失败：temporarily unavailable");
      }
      emitter.reasoning("第二次推理");
      emitter.content("新");
      emitter.content("正文");
    }, {
      ...fast,
      onUpdate: chunk => updates.push(chunk),
      onReasoning: chunk => retries.push(chunk),
      onRetry: () => undefined,
    });

    expect(calls).toBe(2);
    expect(after).toBe("新正文");
    expect(updates).toEqual(["新", "正文"]);
    expect(retries).toEqual(["第二次推理"]);
  });

  it("does not retry once content has committed", async () => {
    let calls = 0;
    await expect(runStreamAttemptWithRetry(async emitter => {
      calls += 1;
      emitter.content("已开始输出");
      throw new Error("模型服务请求失败：temporarily unavailable");
    }, { ...fast, onUpdate: () => undefined })).rejects.toThrow("temporarily unavailable");
    expect(calls).toBe(1);
  });

  it("does not retry non-transient errors", async () => {
    let calls = 0;
    await expect(runStreamAttemptWithRetry(async () => {
      calls += 1;
      throw new Error("模型服务返回 401：Invalid API key");
    }, { ...fast, onUpdate: () => undefined })).rejects.toThrow("Invalid API key");
    expect(calls).toBe(1);
  });

  it("exhausts the retry budget and rethrows the last error", async () => {
    let calls = 0;
    await expect(runStreamAttemptWithRetry(async () => {
      calls += 1;
      throw new Error("fetch failed");
    }, { maxAttempts: 2, backoffMs: () => 1, onUpdate: () => undefined })).rejects.toThrow("fetch failed");
    expect(calls).toBe(2);
  });

  it("isRetryableStreamError rejects abort and auth failures", () => {
    expect(isRetryableStreamError(new DOMException("模型请求已取消", "AbortError"))).toBe(false);
    expect(isRetryableStreamError(new Error("Invalid API key"))).toBe(false);
    expect(isRetryableStreamError(new Error("模型服务返回 500：upstream error"))).toBe(true);
    expect(isRetryableStreamError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableStreamError(new Error("connection reset by peer"))).toBe(true);
  });

  it("retries through agentCompletionStream over the desktop proxy", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    let eventCallback: ((event: { payload: { runId: string; content: string } }) => void) | null = null;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      eventCallback = callback as typeof eventCallback;
      return vi.fn();
    });
    let streamCalls = 0;
    vi.mocked(invoke).mockImplementation(async (cmd, args: any) => {
      if (cmd === "model_proxy_stream") {
        streamCalls += 1;
        if (streamCalls === 1) throw new Error("模型服务请求失败：connection reset");
        eventCallback?.({ payload: { runId: args.runId, content: '{"choices":[{"delta":{"content":"新"}}]}' } });
        eventCallback?.({ payload: { runId: args.runId, content: '{"choices":[{"delta":{"content":"正文"}}]}' } });
      }
      return undefined;
    });
    const updates: string[] = [];

    const response = await agentCompletionStream(
      { model: "example-model", messages: [{ role: "user", content: "x" }] },
      config,
      chunk => updates.push(chunk),
      undefined,
      undefined,
      undefined,
      fast,
    );

    expect(streamCalls).toBe(2);
    expect(updates).toEqual(["新", "正文"]);
    expect(response.choices?.[0]?.message).toMatchObject({ content: "新正文" });
  });

  it("discards partial Responses tool arguments before retrying ask_user", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    let eventCallback: ((event: { payload: { runId: string; content: string } }) => void) | null = null;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      eventCallback = callback as typeof eventCallback;
      return vi.fn();
    });
    let streamCalls = 0;
    vi.mocked(invoke).mockImplementation(async (cmd, args: any) => {
      if (cmd !== "model_proxy_stream") return undefined;
      streamCalls += 1;
      eventCallback?.({ payload: { runId: args.runId, content: JSON.stringify({
        type: "response.output_item.added",
        item: { id: "item-ask", type: "function_call", call_id: "call-ask", name: "ask_user", arguments: "" },
      }) } });
      if (streamCalls === 1) {
        eventCallback?.({ payload: { runId: args.runId, content: JSON.stringify({
          type: "response.function_call_arguments.delta", item_id: "item-ask", delta: '{"question":"第一轮半截',
        }) } });
        throw new Error("模型服务请求失败：connection reset");
      }
      eventCallback?.({ payload: { runId: args.runId, content: JSON.stringify({
        type: "response.function_call_arguments.delta", item_id: "item-ask", delta: '{"question":"请选择方案"}',
      }) } });
      return undefined;
    });

    const response = await agentCompletionStream(
      {
        model: responsesConfig.model,
        messages: [{ role: "user", content: "需要确认范围" }],
        tools: [{ type: "function", function: { name: "ask_user", description: "ask", parameters: { type: "object" } } }],
        tool_choice: "auto",
      },
      responsesConfig,
      () => undefined,
      undefined,
      undefined,
      undefined,
      fast,
    );

    expect(streamCalls).toBe(2);
    const calls = response.choices?.[0]?.message?.tool_calls;
    expect(calls).toHaveLength(1);
    expect(calls?.[0]).toMatchObject({
      id: "call-ask",
      function: { name: "ask_user", arguments: '{"question":"请选择方案"}' },
    });
    expect(() => JSON.parse(calls?.[0].function.arguments ?? "")).not.toThrow();
  });
});
