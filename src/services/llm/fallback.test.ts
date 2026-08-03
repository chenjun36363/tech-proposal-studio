import { describe, expect, it } from "vitest";
import type { ResolvedModelConfig } from "../../core/types";
import { isAbortErrorLike, isFallbackableModelError, runWithModelFallback } from "./fallback";

const a: ResolvedModelConfig = { providerId: "p", providerName: "P", protocol: "openai-completions", baseUrl: "x", apiKey: "k", model: "a", timeoutMs: 1, headers: {}, enabled: true };
const b: ResolvedModelConfig = { ...a, model: "b" };

describe("isFallbackableModelError", () => {
  it("treats auth/network/503/429-cooling as fallbackable", () => {
    expect(isFallbackableModelError(new Error("auth_unavailable: no auth available"))).toBe(true);
    expect(isFallbackableModelError(new Error("Error: 503 Service Unavailable"))).toBe(true);
    expect(isFallbackableModelError(new Error("error sending request for url (http://192.168.1.100:8317/v1)"))).toBe(true);
    expect(isFallbackableModelError(new Error("All credentials are cooling down"))).toBe(true);
    expect(isFallbackableModelError(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("does not treat abort/context/structured-output as fallbackable", () => {
    expect(isFallbackableModelError(new DOMException("cancelled", "AbortError"))).toBe(false);
    expect(isFallbackableModelError(new Error("maximum context length exceeded"))).toBe(false);
    expect(isFallbackableModelError(new Error("submit_chapter_draft 返回了无效 JSON"))).toBe(false);
  });
});

describe("runWithModelFallback", () => {
  it("returns the primary result when it succeeds", async () => {
    const result = await runWithModelFallback([a, b], async (cfg) => `ok:${cfg.model}`);
    expect(result).toBe("ok:a");
  });

  it("switches to the next candidate on a fallbackable error and succeeds there", async () => {
    const seen: string[] = [];
    const result = await runWithModelFallback([a, b], async (cfg) => {
      seen.push(cfg.model);
      if (cfg.model === "a") throw new Error("auth_unavailable");
      return `ok:${cfg.model}`;
    });
    expect(seen).toEqual(["a", "b"]);
    expect(result).toBe("ok:b");
  });

  it("throws the last error after exhausting the chain", async () => {
    await expect(runWithModelFallback([a, b], async (cfg) => {
      throw new Error(`auth_unavailable: fail:${cfg.model}`);
    })).rejects.toThrow("fail:b");
  });

  it("rethrows abort errors immediately without switching", async () => {
    await expect(runWithModelFallback([a, b], async () => {
      throw new DOMException("cancelled", "AbortError");
    })).rejects.toBeInstanceOf(DOMException);
  });

  it("does not switch on a non-fallbackable error", async () => {
    await expect(runWithModelFallback([a, b], async () => {
      throw new Error("maximum context length exceeded");
    })).rejects.toThrow("maximum context length exceeded");
  });
});

describe("isAbortErrorLike", () => {
  it("detects AbortError DOMExceptions", () => {
    expect(isAbortErrorLike(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortErrorLike(new Error("x"))).toBe(false);
  });
});
