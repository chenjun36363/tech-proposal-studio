// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCompletion, agentCompletionStream, improveBlockStream } from "./model";
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
