// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { improveBlockStream } from "./model";
import type { DocumentBlock, OpenAICompatibleConfig } from "../types";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

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
    vi.mocked(invoke).mockResolvedValue({ blockId: block.id, before: block.content, after: "新正文", instruction: "优化" });

    await expect(improveBlockStream(block, "优化", [], config, vi.fn())).resolves.toMatchObject({ after: "新正文" });
    expect(invoke).toHaveBeenCalledWith("generate_text_stream", expect.objectContaining({ config }));
  });
});
