import { describe, expect, it } from "vitest";
import type { ResolvedModelConfig } from "../../types";
import type { CanonicalChatRequest } from "./types";
import { protocolAdapter } from "./index";
import {
  deriveModelSnapshot,
  encodeModelValue,
  parseModelValue,
  repairSelectionForProviders,
  resolveActiveModelConfig,
} from "./resolve";
import { createDefaultProvider } from "./defaults";

const baseConfig = (protocol: ResolvedModelConfig["protocol"], extra: Partial<ResolvedModelConfig> = {}): ResolvedModelConfig => ({
  providerId: "p1",
  providerName: "Test",
  protocol,
  baseUrl: protocol === "google-generative-ai"
    ? "https://generativelanguage.googleapis.com/v1beta"
    : protocol === "anthropic-messages"
      ? "https://api.anthropic.com/v1"
      : "https://api.openai.com/v1",
  apiKey: "test-key",
  model: protocol === "google-generative-ai" ? "gemini-2.0-flash" : protocol === "anthropic-messages" ? "claude-sonnet-4-5" : "gpt-4.1-mini",
  timeoutMs: 60000,
  headers: {},
  enabled: true,
  ...extra,
});

const toolsRequest = (): CanonicalChatRequest => ({
  model: "",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ],
  tools: [{
    type: "function",
    function: {
      name: "write_todo",
      description: "plan",
      parameters: { type: "object", properties: { items: { type: "array" } } },
    },
  }],
  tool_choice: "auto",
  stream: false,
});
const forcedToolsRequest = (): CanonicalChatRequest => ({ ...toolsRequest(), tool_choice: { type: "function", function: { name: "write_todo" } } });

describe("encode/parse model value", () => {
  it("round-trips providerId::model", () => {
    expect(encodeModelValue("abc", "gpt")).toBe("abc::gpt");
    expect(parseModelValue("abc::gpt")).toEqual({ providerId: "abc", model: "gpt" });
    expect(parseModelValue("bad")).toBeNull();
  });
});

describe("resolveActiveModelConfig", () => {
  it("throws Chinese errors for missing selection", () => {
    expect(() => resolveActiveModelConfig([], null)).toThrow(/请先在设置中选择模型/);
  });

  it("resolves enabled provider + model", () => {
    const provider = { ...createDefaultProvider(), id: "p1", activeModels: ["m1"], apiKey: "k" };
    const resolved = resolveActiveModelConfig([provider], { providerId: "p1", model: "m1" });
    expect(resolved.model).toBe("m1");
    expect(resolved.protocol).toBe("openai-completions");
  });

  it("rejects calls when project AI master switch is off", () => {
    const provider = { ...createDefaultProvider(), id: "p1", activeModels: ["m1"], apiKey: "k" };
    expect(() => resolveActiveModelConfig(
      [provider],
      { providerId: "p1", model: "m1" },
      { aiEnabled: false },
    )).toThrow(/已禁用联网 AI/);
  });
});

describe("repairSelectionForProviders", () => {
  it("keeps selection on an enabled provider", () => {
    const a = { ...createDefaultProvider(), id: "a", enabled: true, activeModels: ["m1", "m2"] };
    const b = { ...createDefaultProvider(), id: "b", enabled: true, activeModels: ["x"] };
    expect(repairSelectionForProviders([a, b], { providerId: "a", model: "m2" }))
      .toEqual({ providerId: "a", model: "m2" });
  });

  it("falls back when the selected provider is disabled", () => {
    const a = { ...createDefaultProvider(), id: "a", enabled: false, activeModels: ["m1"] };
    const b = { ...createDefaultProvider(), id: "b", enabled: true, activeModels: ["x"] };
    expect(repairSelectionForProviders([a, b], { providerId: "a", model: "m1" }))
      .toEqual({ providerId: "b", model: "x" });
  });

  it("returns null when no provider is enabled", () => {
    const a = { ...createDefaultProvider(), id: "a", enabled: false, activeModels: ["m1"] };
    expect(repairSelectionForProviders([a], { providerId: "a", model: "m1" })).toBeNull();
  });
});

describe("deriveModelSnapshot", () => {
  it("preserves project AI master switch when providers change", () => {
    const provider = { ...createDefaultProvider(), id: "p1", enabled: true, activeModels: ["m1"], apiKey: "k" };
    const snap = deriveModelSnapshot(
      [provider],
      { providerId: "p1", model: "m1" },
      { baseUrl: "", apiKey: "", model: "", timeoutMs: 60000, headers: {}, enabled: false },
    );
    expect(snap.enabled).toBe(false);
    expect(snap.model).toBe("m1");
  });
});

describe("openai-completions adapter", () => {
  const adapter = protocolAdapter("openai-completions");
  const config = baseConfig("openai-completions");

  it("builds chat/completions request", () => {
    const wire = adapter.buildChatRequest(config, toolsRequest());
    expect(wire.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(wire.method).toBe("POST");
    expect(wire.headers.Authorization).toBe("Bearer test-key");
    expect((wire.body as any).tools).toHaveLength(1);
  });

  it("forces a named function", () => {
    const body = protocolAdapter("openai-completions").buildChatRequest(config, forcedToolsRequest()).body as any;
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "write_todo" } });
  });

  it("parses tool_calls response", () => {
    const parsed = adapter.parseChatResponse({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "write_todo", arguments: "{\"a\":1}" } }],
        },
        finish_reason: "tool_calls",
      }],
    });
    expect(parsed.choices?.[0]?.message?.tool_calls?.[0]?.function.name).toBe("write_todo");
  });

  it("parses SSE text delta", () => {
    expect(adapter.parseTextSseData('{"choices":[{"delta":{"content":"你好"}}]}')).toBe("你好");
    expect(adapter.parseTextSseData("[DONE]")).toBeNull();
  });
});

describe("openai-responses adapter", () => {
  const adapter = protocolAdapter("openai-responses");
  const config = baseConfig("openai-responses");

  it("builds /responses with input array", () => {
    const wire = adapter.buildChatRequest(config, toolsRequest());
    expect(wire.url).toBe("https://api.openai.com/v1/responses");
    expect(Array.isArray((wire.body as any).input)).toBe(true);
  });

  it("forces a named function", () => {
    const body = adapter.buildChatRequest(config, forcedToolsRequest()).body as any;
    expect(body.tool_choice).toEqual({ type: "function", name: "write_todo" });
  });

  it("parses output_text and function_call", () => {
    const raw = {
      output: [
        { type: "message", content: [{ type: "output_text", text: "done" }] },
        { type: "function_call", call_id: "fc1", name: "write_todo", arguments: "{}" },
      ],
    };
    const parsed = adapter.parseChatResponse(raw);
    expect(adapter.extractText(raw)).toBe("done");
    expect(parsed.choices?.[0]?.message?.content).toBe("done");
    expect(parsed.choices?.[0]?.message?.tool_calls?.[0]?.function.name).toBe("write_todo");
  });

  it("streams only output text and ignores reasoning deltas", () => {
    expect(adapter.parseTextSseData(JSON.stringify({
      type: "response.reasoning_summary_text.delta",
      delta: "内部推理",
    }))).toBeNull();
    expect(adapter.parseTextSseData(JSON.stringify({
      type: "response.output_text.delta",
      delta: "修改后的正文",
    }))).toBe("修改后的正文");
  });
});

describe("anthropic-messages adapter", () => {
  const adapter = protocolAdapter("anthropic-messages");
  const config = baseConfig("anthropic-messages");

  it("builds /messages with system top-level and x-api-key", () => {
    const wire = adapter.buildChatRequest(config, toolsRequest());
    expect(wire.url).toBe("https://api.anthropic.com/v1/messages");
    expect(wire.headers["x-api-key"]).toBe("test-key");
    expect(wire.headers["anthropic-version"]).toBe("2023-06-01");
    expect((wire.body as any).system).toBe("sys");
    expect((wire.body as any).tools[0].name).toBe("write_todo");
  });

  it("forces a named tool", () => {
    const body = adapter.buildChatRequest(config, forcedToolsRequest()).body as any;
    expect(body.tool_choice).toEqual({ type: "tool", name: "write_todo" });
  });

  it("maps tool_use blocks back to tool_calls", () => {
    const parsed = adapter.parseChatResponse({
      content: [
        { type: "text", text: "plan" },
        { type: "tool_use", id: "tu1", name: "write_todo", input: { items: [] } },
      ],
    });
    expect(parsed.choices?.[0]?.message?.content).toBe("plan");
    expect(parsed.choices?.[0]?.message?.tool_calls?.[0]).toMatchObject({
      id: "tu1",
      function: { name: "write_todo", arguments: "{\"items\":[]}" },
    });
  });

  it("parses content_block_delta SSE", () => {
    expect(adapter.parseTextSseData(JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "段" },
    }))).toBe("段");
  });
});

describe("google-generative-ai adapter", () => {
  const adapter = protocolAdapter("google-generative-ai");
  const config = baseConfig("google-generative-ai");

  it("builds generateContent URL with x-goog-api-key", () => {
    const wire = adapter.buildChatRequest(config, toolsRequest());
    expect(wire.url).toContain("/models/gemini-2.0-flash:generateContent");
    expect(wire.headers["x-goog-api-key"]).toBe("test-key");
    expect((wire.body as any).systemInstruction).toBeTruthy();
  });

  it("forces a named function", () => {
    const body = adapter.buildChatRequest(config, forcedToolsRequest()).body as any;
    expect(body.toolConfig.functionCallingConfig).toEqual({ mode: "ANY", allowedFunctionNames: ["write_todo"] });
  });

  it("builds stream URL with alt=sse", () => {
    const wire = adapter.buildChatRequest(config, { ...toolsRequest(), stream: true });
    expect(wire.url).toContain("streamGenerateContent?alt=sse");
  });

  it("maps functionCall to tool_calls", () => {
    const parsed = adapter.parseChatResponse({
      candidates: [{
        content: {
          parts: [
            { text: "ok" },
            { functionCall: { name: "write_todo", args: { items: [1] } } },
          ],
        },
      }],
    });
    expect(parsed.choices?.[0]?.message?.content).toBe("ok");
    expect(parsed.choices?.[0]?.message?.tool_calls?.[0]?.function.name).toBe("write_todo");
  });
});
