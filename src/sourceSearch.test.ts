import { describe, expect, it } from "vitest";
import { matchesSource, sourceMatchExcerpt } from "./sourceSearch";
import type { SourceRecord } from "./types";

const source: SourceRecord = {
  id: "local-1",
  kind: "local",
  title: "支付平台方案",
  location: "D:\\history\\payment.md",
  excerpt: "架构设计摘要",
  fingerprint: "payment",
  accessedAt: "2026-07-21T00:00:00.000Z",
};

describe("local source search", () => {
  it("matches every query token across metadata and full content", () => {
    expect(matchesSource(source, "支付 幂等", "接口通过幂等键避免重复扣款")).toBe(true);
    expect(matchesSource(source, "支付 审批", "接口通过幂等键避免重复扣款")).toBe(false);
  });

  it("builds an excerpt around a full-text hit", () => {
    expect(sourceMatchExcerpt(source, "幂等", "前言。接口通过幂等键避免重复扣款。结尾。", 20)).toContain("幂等");
  });
});
