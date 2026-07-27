// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchWeb } from "./search";

describe("browser search adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the Brave default endpoint when no endpoint is configured", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [{ title: "结果", url: "https://example.com", description: "摘要" }] } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchWeb("技术方案", { provider: "brave", endpoint: "", apiKey: "key" })).resolves.toEqual([
      { title: "结果", url: "https://example.com", excerpt: "摘要" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.search.brave.com/res/v1/web/search?q=%E6%8A%80%E6%9C%AF%E6%96%B9%E6%A1%88",
      expect.any(Object),
    );
  });
});
