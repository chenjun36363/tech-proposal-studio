import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { HeadingDetectionResult, HeadingReviewDecision, KnowledgeBackup, KnowledgeChunk, KnowledgeChunkQuality, KnowledgeDocument, KnowledgeProgress, KnowledgeScanItem, KnowledgeSearchField, KnowledgeSearchResult, KnowledgeSection, KnowledgeSectionScope, OpenAICompatibleConfig, WorkspacePaths } from "./types";
import { isDesktop } from "./services";

function desktopOnly() {
  if (!isDesktop()) throw new Error("知识库仅在桌面端可用");
}

export async function scanKnowledge(workspace: WorkspacePaths): Promise<KnowledgeScanItem[]> {
  desktopOnly(); return invoke("knowledge_scan", { workspace });
}
export async function importKnowledgeMarkdown(workspace: WorkspacePaths, sourcePath: string): Promise<KnowledgeDocument> {
  desktopOnly(); return invoke("knowledge_import_markdown", { workspace, sourcePath });
}
export async function moveWorkspaceMarkdownToKnowledge(workspace: WorkspacePaths, sourcePath: string): Promise<KnowledgeDocument> {
  desktopOnly(); return invoke("knowledge_move_workspace_markdown", { workspace, sourcePath });
}
export async function indexPendingKnowledge(workspace: WorkspacePaths, paths: string[]): Promise<KnowledgeDocument[]> {
  desktopOnly(); return invoke("knowledge_index_pending", { workspace, paths });
}
export async function listKnowledge(workspace: WorkspacePaths): Promise<KnowledgeDocument[]> {
  desktopOnly(); return invoke("knowledge_list", { workspace });
}
export async function listKnowledgeSections(workspace: WorkspacePaths, documentId: string): Promise<KnowledgeSection[]> {
  desktopOnly(); return invoke("knowledge_sections", { workspace, documentId });
}
export async function searchKnowledge(workspace: WorkspacePaths, query: string, qualities: KnowledgeChunkQuality[] = ["good", "normal"], fields?: KnowledgeSearchField[], limit = 30): Promise<KnowledgeSearchResult[]> {
  desktopOnly(); return invoke("knowledge_search", { workspace, query, qualities, fields, limit });
}
export async function getKnowledgeSectionScope(workspace: WorkspacePaths, sectionId: string): Promise<KnowledgeSectionScope> {
  desktopOnly(); return invoke("knowledge_section_scope", { workspace, sectionId });
}
export async function getKnowledgeChunk(workspace: WorkspacePaths, chunkId: string): Promise<KnowledgeChunk> {
  desktopOnly(); return invoke("knowledge_chunk", { workspace, chunkId });
}
export async function setKnowledgeChunkQuality(workspace: WorkspacePaths, chunkId: string, quality: KnowledgeChunkQuality): Promise<KnowledgeChunk> {
  desktopOnly(); return invoke("knowledge_set_chunk_quality", { workspace, chunkId, quality });
}
export async function setKnowledgeSectionQuality(workspace: WorkspacePaths, sectionId: string, quality: KnowledgeChunkQuality): Promise<KnowledgeChunkQuality> {
  desktopOnly(); return invoke("knowledge_set_section_quality", { workspace, sectionId, quality });
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
export async function importKnowledgeWeb(workspace: WorkspacePaths, url: string): Promise<KnowledgeDocument> {
  desktopOnly(); return invoke("knowledge_import_web", { workspace, url });
}
export async function onKnowledgeProgress(handler: (progress: KnowledgeProgress) => void): Promise<UnlistenFn> {
  desktopOnly(); return listen<KnowledgeProgress>("knowledge://progress", event => handler(event.payload));
}
export async function analyzeKnowledgeMarkdown(workspace: WorkspacePaths, sourcePath: string, config: OpenAICompatibleConfig): Promise<HeadingDetectionResult> {
  desktopOnly(); return invoke("knowledge_analyze_markdown", { workspace, sourcePath, config });
}
export async function applyKnowledgeHeadings(workspace: WorkspacePaths, result: HeadingDetectionResult, decisions: HeadingReviewDecision[]): Promise<KnowledgeDocument> {
  desktopOnly(); return invoke("knowledge_apply_headings", { workspace, path: result.path, decisions, tocStart: result.tocStart ?? null, tocEnd: result.tocEnd ?? null });
}
export async function listKnowledgeBackups(workspace: WorkspacePaths, documentId: string): Promise<KnowledgeBackup[]> {
  desktopOnly(); return invoke("knowledge_backups", { workspace, documentId });
}
export async function restoreKnowledgeBackup(workspace: WorkspacePaths, documentId: string, backupPath: string): Promise<KnowledgeDocument> {
  desktopOnly(); return invoke("knowledge_restore_backup", { workspace, documentId, backupPath });
}
