// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { improveBlockStream } from "./model";
import type { DocumentBlock, OpenAICompatibleConfig } from "../types";
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
});
