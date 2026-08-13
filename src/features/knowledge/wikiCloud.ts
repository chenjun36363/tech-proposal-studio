import { invoke } from "@tauri-apps/api/core";
import type { SourceRecord, WikiCloudConfig } from "../../core/types";
import { isDesktop } from "../../services/runtime";

export interface WikiCloudRetrievalHit {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  chunkId: string;
  versionNo: number;
  title: string;
  headingPath: string;
  content: string;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  fusionScore: number;
  rerankScore?: number | null;
  quality: string;
  matchedFields: string[];
  fusionMethod: string;
  sourceUri?: string | null;
  locator?: string | null;
}

export interface WikiCloudConnectionTest {
  ok: boolean;
  hitCount: number;
  message: string;
}

function desktopOnly() {
  if (!isDesktop()) throw new Error("wiki-cloud 检索仅在构案桌面端可用");
}

export function wikiCloudReady(config: WikiCloudConfig | null | undefined): boolean {
  return Boolean(config?.enabled && config.baseUrl.trim() && config.workspaceId.trim());
}

export async function searchWikiCloud(
  config: WikiCloudConfig,
  query: string,
): Promise<WikiCloudRetrievalHit[]> {
  desktopOnly();
  if (!wikiCloudReady(config)) throw new Error("请先在设置中启用并完善 wiki-cloud 连接");
  if (!query.trim()) return [];
  return invoke<WikiCloudRetrievalHit[]>("wiki_cloud_search", { query: query.trim(), config });
}

export async function testWikiCloudConnection(
  config: WikiCloudConfig,
): Promise<WikiCloudConnectionTest> {
  desktopOnly();
  if (!wikiCloudReady(config)) throw new Error("请先启用连接，并填写服务地址与 Workspace ID");
  return invoke<WikiCloudConnectionTest>("wiki_cloud_test_connection", { config });
}

export function wikiCloudHitSourceId(workspaceId: string, hit: WikiCloudRetrievalHit): string {
  return `wiki-cloud:${workspaceId}:${hit.chunkId}`;
}

export function wikiCloudHitToSource(
  workspaceId: string,
  hit: WikiCloudRetrievalHit,
): SourceRecord {
  const sourceUri = hit.sourceUri?.trim() || undefined;
  const locator = hit.locator?.trim() || undefined;
  const id = wikiCloudHitSourceId(workspaceId, hit);
  return {
    id,
    kind: "cloud",
    title: hit.title || hit.knowledgeBaseName || "wiki-cloud 资料",
    heading: hit.headingPath || undefined,
    location: sourceUri || locator || `wiki-cloud:${hit.documentId}`,
    excerpt: hit.content.replace(/\s+/g, " ").slice(0, 280),
    content: hit.content,
    fingerprint: `${hit.documentId}:${hit.chunkId}:${hit.versionNo}`,
    accessedAt: new Date().toISOString(),
    citation: {
      provider: "wiki-cloud",
      workspaceId,
      knowledgeBaseId: hit.knowledgeBaseId || undefined,
      knowledgeBaseName: hit.knowledgeBaseName || undefined,
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      locator,
      sourceUri,
      versionNo: hit.versionNo,
    },
  };
}
