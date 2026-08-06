// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clearToolQualityMetrics, listToolQualityMetrics, recordToolQualityMetric } from "./toolQualityMetrics";

describe("tool quality metrics", () => {
  beforeEach(async () => { await clearToolQualityMetrics(); });

  it("aggregates only anonymous dimensions in browser storage", async () => {
    await recordToolQualityMetric({ protocol: "openai", model: "test-model", toolName: "read_proposal_section", resultKind: "validation_failure", errorCode: "INVALID_ARGUMENTS", round: 1, repaired: false, durationMs: 12 });
    await recordToolQualityMetric({ protocol: "openai", model: "test-model", toolName: "read_proposal_section", resultKind: "validation_failure", errorCode: "INVALID_ARGUMENTS", round: 1, repaired: false, durationMs: 20 });
    const rows = await listToolQualityMetrics();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ toolName: "read_proposal_section", resultKind: "validation_failure", errorCode: "INVALID_ARGUMENTS", count: 2, roundBucket: "1", durationBucket: "<100ms" }));
    const raw = localStorage.getItem("tech-proposal-studio.agent-tool-metrics.v1") ?? "";
    expect(raw).not.toContain("proposal body");
    expect(raw).not.toContain("apiKey");
  });

  it("records repair-success and clear operations", async () => {
    await recordToolQualityMetric({ protocol: "anthropic", model: "test-model", toolName: "web_search", resultKind: "execution_success", round: 2, repaired: true, durationMs: 600 });
    expect((await listToolQualityMetrics())[0]).toEqual(expect.objectContaining({ repaired: true, durationBucket: "500ms-2s" }));
    await clearToolQualityMetrics();
    expect(await listToolQualityMetrics()).toEqual([]);
  });
});
