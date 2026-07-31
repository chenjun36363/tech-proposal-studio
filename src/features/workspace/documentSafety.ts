import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "../../services/runtime";
import type { WorkspaceMarkdownFile } from "../../core/types";

export interface TextFileSnapshot {
  path: string;
  content: string;
  sha256: string;
  updatedAt: string;
}

export type CheckedWriteResult =
  | { outcome: "saved"; snapshot: TextFileSnapshot }
  | { outcome: "conflict"; snapshot: TextFileSnapshot | null };

export interface WorkspaceDocumentDraft {
  draftId: string;
  workspaceRoot: string;
  filePath: string | null;
  projectId: string;
  projectName: string;
  markdown: string;
  baseHash: string | null;
  runtimeLabel: string;
  updatedAt: string;
}

export type DocumentStatus = "checking" | "saved" | "dirty" | "recovered" | "conflict";


export type DocumentGuardChoice = "save" | "discard" | "cancel";

export interface DocumentChangeGuardOptions {
  isDirty: boolean;
  flushDraft: () => Promise<void>;
  choose: () => Promise<DocumentGuardChoice>;
  save: () => Promise<boolean>;
  discard: () => void;
  clearHandledDrafts: () => Promise<void>;
}

export async function runDocumentChangeGuard({
  isDirty,
  flushDraft,
  choose,
  save,
  discard,
  clearHandledDrafts,
}: DocumentChangeGuardOptions): Promise<boolean> {
  // A draft flush is best-effort: the explicit save/discard/cancel decision remains
  // authoritative even if SQLite is temporarily unavailable.
  await flushDraft().catch(() => undefined);
  if (!isDirty) return true;
  const choice = await choose();
  if (choice === "cancel") return false;
  if (choice === "save") return save();
  discard();
  await clearHandledDrafts();
  return true;
}

export interface DraftRecoveryDecision {
  draft: WorkspaceDocumentDraft | null;
  status: Exclude<DocumentStatus, "checking" | "saved"> | "saved";
  staleDraftIds: string[];
  otherDraftCount: number;
}

export function deriveDocumentStatus(
  markdown: string,
  baseline: TextFileSnapshot | null,
  checking: boolean,
  recoveryKind: "none" | "recovered" | "conflict",
  forceConflictDirty = false,
): { isDirty: boolean; status: DocumentStatus } {
  const isDirty = forceConflictDirty || (baseline ? markdown !== baseline.content : true);
  const status: DocumentStatus = checking
    ? "checking"
    : recoveryKind === "conflict" && isDirty
      ? "conflict"
      : recoveryKind === "recovered" && isDirty
        ? "recovered"
        : isDirty
          ? "dirty"
          : "saved";
  return { isDirty, status };
}

export function sameDocumentPath(left?: string | null, right?: string | null): boolean {
  if (!left || !right) return !left && !right;
  return left.replace(/\//g, "\\").replace(/[\\]+$/, "").toLocaleLowerCase()
    === right.replace(/\//g, "\\").replace(/[\\]+$/, "").toLocaleLowerCase();
}

export function firstWorkspaceDocumentAfterDelete(
  documents: WorkspaceMarkdownFile[],
  deletedPath: string,
): WorkspaceMarkdownFile | null {
  return documents.find(document => !sameDocumentPath(document.path, deletedPath)) ?? null;
}

export function chooseDraftRecovery(
  drafts: WorkspaceDocumentDraft[],
  snapshot: TextFileSnapshot | null,
  filePath: string | null,
  projectId: string,
): DraftRecoveryDecision {
  const matching = drafts
    .filter(draft => filePath ? sameDocumentPath(draft.filePath, filePath) : (!draft.filePath && draft.projectId === projectId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const staleDraftIds = snapshot
    ? matching.filter(draft => draft.markdown === snapshot.content).map(draft => draft.draftId)
    : [];
  const candidates = matching.filter(draft => !staleDraftIds.includes(draft.draftId));
  const draft = candidates[0] ?? null;
  if (!draft) return { draft: null, status: snapshot ? "saved" : "dirty", staleDraftIds, otherDraftCount: 0 };
  const status = !snapshot ? "dirty" : draft.baseHash === snapshot.sha256 ? "recovered" : "conflict";
  return { draft, status, staleDraftIds, otherDraftCount: Math.max(0, candidates.length - 1) };
}

export async function readTextFileSnapshot(path: string): Promise<TextFileSnapshot> {
  if (!isDesktop()) throw new Error("文件快照仅在桌面端可用");
  return invoke<TextFileSnapshot>("read_text_file_snapshot", { path });
}

export async function writeTextFileChecked(
  path: string,
  content: string,
  expectedSha256: string | null,
  force = false,
): Promise<CheckedWriteResult> {
  if (!isDesktop()) throw new Error("安全保存仅在桌面端可用");
  return invoke<CheckedWriteResult>("write_text_file_checked", {
    path,
    content,
    expectedSha256,
    force,
  });
}

export async function saveTextFileAs(
  defaultName: string,
  content: string,
  defaultDirectory?: string,
): Promise<TextFileSnapshot | null> {
  if (!isDesktop()) return null;
  return invoke<TextFileSnapshot | null>("save_text_file_as", {
    defaultName,
    content,
    defaultDirectory: defaultDirectory || null,
  });
}

export async function saveWorkspaceDocumentDraft(draft: WorkspaceDocumentDraft): Promise<void> {
  if (!isDesktop()) return;
  await invoke("save_workspace_document_draft", { draft });
}

export async function listWorkspaceDocumentDrafts(workspaceRoot: string): Promise<WorkspaceDocumentDraft[]> {
  if (!isDesktop() || !workspaceRoot) return [];
  return invoke<WorkspaceDocumentDraft[]>("list_workspace_document_drafts", { workspaceRoot });
}

export async function deleteWorkspaceDocumentDraft(draftId: string): Promise<void> {
  if (!isDesktop() || !draftId) return;
  await invoke("delete_workspace_document_draft", { draftId });
}
