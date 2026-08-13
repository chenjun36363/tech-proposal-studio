import { describe, expect, it } from "vitest";
import { wikiCloudHitSourceId, wikiCloudHitToSource, wikiCloudReady, type WikiCloudRetrievalHit } from "./wikiCloud";

const hit: WikiCloudRetrievalHit = {
  knowledgeBaseId: "kb-1", knowledgeBaseName: "标准库", documentId: "doc-1", chunkId: "chunk-1", versionNo: 3,
  title: "验收标准", headingPath: "交付 > 验收", content: "必须保留原始来源。", score: 0.91, lexicalScore: 0.8,
  semanticScore: 0.9, fusionScore: 0.91, rerankScore: null, quality: "HIGH", matchedFields: ["content"],
  fusionMethod: "RRF", sourceUri: "s3://bucket/spec.md", locator: "section:acceptance",
};

describe("wikiCloud provider", () => {
  it("requires enabled endpoint and workspace", () => {
    expect(wikiCloudReady({ enabled: true, baseUrl: "http://localhost", workspaceId: "ws", apiKey: "", knowledgeBaseIds: [], retrievalMode: "HYBRID", limit: 8 })).toBe(true);
    expect(wikiCloudReady({ enabled: false, baseUrl: "http://localhost", workspaceId: "ws", apiKey: "", knowledgeBaseIds: [], retrievalMode: "HYBRID", limit: 8 })).toBe(false);
  });

  it("creates a stable traceable cloud source", () => {
    expect(wikiCloudHitSourceId("ws-1", hit)).toBe("wiki-cloud:ws-1:chunk-1");
    const source = wikiCloudHitToSource("ws-1", hit);
    expect(source.kind).toBe("cloud");
    expect(source.location).toBe("s3://bucket/spec.md");
    expect(source.citation).toMatchObject({ workspaceId: "ws-1", documentId: "doc-1", chunkId: "chunk-1", locator: "section:acceptance" });
  });
});
