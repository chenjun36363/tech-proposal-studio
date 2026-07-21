import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { HeadingDetectionResult, HeadingReviewDecision, KnowledgeBackup, KnowledgeChunk, KnowledgeDocument, KnowledgeProgress, KnowledgeScanItem, KnowledgeSearchResult, KnowledgeSection, OpenAICompatibleConfig, WorkspacePaths } from "./types";
import { isDesktop } from "./services";

function desktopOnly() {
  if (!isDesktop()) throw new Error("知识库仅在桌面端可用");
}

export async function scanKnowledge(workspace: WorkspacePaths): Promise<KnowledgeScanItem[]> {
  desktopOnly(); return invoke("knowledge_scan", { workspace });
}
export async function importKnowledgeMarkdown(workspace: WorkspacePaths, sourcePath: string, config: OpenAICompatibleConfig): Promise<KnowledgeDocument> {
  desktopOnly(); return invoke("knowledge_import_markdown", { workspace, sourcePath, config });
}
export async function indexPendingKnowledge(workspace: WorkspacePaths, paths: string[], config: OpenAICompatibleConfig): Promise<KnowledgeDocument[]> {
  desktopOnly(); return invoke("knowledge_index_pending", { workspace, paths, config });
}
export async function listKnowledge(workspace: WorkspacePaths): Promise<KnowledgeDocument[]> {
  desktopOnly(); return invoke("knowledge_list", { workspace });
}
export async function listKnowledgeSections(workspace: WorkspacePaths, documentId: string): Promise<KnowledgeSection[]> {
  desktopOnly(); return invoke("knowledge_sections", { workspace, documentId });
}
export async function searchKnowledge(workspace: WorkspacePaths, query: string, limit = 30): Promise<KnowledgeSearchResult[]> {
  desktopOnly(); return invoke("knowledge_search", { workspace, query, limit });
}
export async function getKnowledgeChunk(workspace: WorkspacePaths, chunkId: string): Promise<KnowledgeChunk> {
  desktopOnly(); return invoke("knowledge_chunk", { workspace, chunkId });
}
export async function listKnowledgeSectionChunks(workspace: WorkspacePaths, sectionId: string): Promise<KnowledgeChunk[]> {
  desktopOnly(); return invoke("knowledge_section_chunks", { workspace, sectionId });
}
export async function removeKnowledgeDocument(workspace: WorkspacePaths, documentId: string): Promise<void> {
  desktopOnly(); await invoke("knowledge_remove", { workspace, documentId });
}
export async function deleteKnowledgeFile(workspace: WorkspacePaths, path: string, documentId?: string): Promise<void> {
  desktopOnly(); await invoke("knowledge_delete_file", { workspace, path, documentId: documentId ?? null });
}
export async function retryKnowledgeEnrichment(workspace: WorkspacePaths, documentId: string, config: OpenAICompatibleConfig): Promise<KnowledgeDocument> {
  desktopOnly(); return invoke("knowledge_retry_enrichment", { workspace, documentId, config });
}
export async function importKnowledgeWeb(workspace: WorkspacePaths, url: string, config: OpenAICompatibleConfig): Promise<KnowledgeDocument> {
  desktopOnly(); return invoke("knowledge_import_web", { workspace, url, config });
}
export async function onKnowledgeProgress(handler: (progress: KnowledgeProgress) => void): Promise<UnlistenFn> {
  desktopOnly(); return listen<KnowledgeProgress>("knowledge://progress", event => handler(event.payload));
}
export async function analyzeKnowledgeMarkdown(workspace: WorkspacePaths, sourcePath: string, config: OpenAICompatibleConfig): Promise<HeadingDetectionResult> {
  desktopOnly(); return invoke("knowledge_analyze_markdown", { workspace, sourcePath, config });
}
export async function applyKnowledgeHeadings(workspace: WorkspacePaths, result: HeadingDetectionResult, decisions: HeadingReviewDecision[], config: OpenAICompatibleConfig): Promise<KnowledgeDocument> {
  desktopOnly(); return invoke("knowledge_apply_headings", { workspace, path: result.path, decisions, tocStart: result.tocStart ?? null, tocEnd: result.tocEnd ?? null, config });
}
export async function listKnowledgeBackups(workspace: WorkspacePaths, documentId: string): Promise<KnowledgeBackup[]> {
  desktopOnly(); return invoke("knowledge_backups", { workspace, documentId });
}
export async function restoreKnowledgeBackup(workspace: WorkspacePaths, documentId: string, backupPath: string, config: OpenAICompatibleConfig): Promise<KnowledgeDocument> {
  desktopOnly(); return invoke("knowledge_restore_backup", { workspace, documentId, backupPath, config });
}
