import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "../../services/runtime";

export type ProposalBackupKind = "original" | "consistency" | "pre-restore" | "manual";

export interface ProposalBackup {
  path: string;
  filePath: string;
  sha256: string;
  createdAt: string;
  kind: ProposalBackupKind;
  taskId?: string | null;
}

export interface CreateProposalBackupRequest {
  workspaceRoot: string;
  filePath: string;
  taskId?: string | null;
  kind?: ProposalBackupKind;
}

export interface ListProposalBackupsRequest {
  workspaceRoot: string;
  filePath?: string | null;
  taskId?: string | null;
}

export interface RestoreProposalBackupRequest {
  workspaceRoot: string;
  filePath: string;
  backupPath: string;
  expectedDocumentHash?: string | null;
  taskId?: string | null;
}

export interface RestoreProposalBackupResult {
  filePath: string;
  sha256: string;
  content: string;
  restoredFrom: string;
}

export interface CommitLongTaskChapterRequest {
  workspaceRoot: string;
  taskId: string;
  chapterId: string;
  filePath: string;
  expectedDocumentHash: string;
  expectedChapterHash: string;
  replacementMarkdown: string;
  targetDocumentHash: string;
}

export type CommitLongTaskChapterResult =
  | {
      outcome: "committed";
      filePath: string;
      documentHash: string;
      chapterHash: string;
      content: string;
    }
  | {
      outcome: "conflict";
      filePath: string;
      documentHash: string | null;
      chapterHash: string | null;
      reason: "document_hash" | "chapter_hash" | "missing_chapter" | "unexpected_disk_state";
      content?: string | null;
    };

export interface LongWritingRecoveryResult<TTask = unknown, TChapter = unknown> {
  task: TTask;
  chapters: TChapter[];
  diskHash: string;
  recovery: "ready" | "finalized_commits" | "requeued" | "conflict";
}

function requireDesktop(): void {
  if (!isDesktop()) throw new Error("长任务文件与持久化服务仅在桌面端可用");
}

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name}不能为空`);
}

function requireWorkspaceRoot(workspaceRoot: string): string {
  requireText(workspaceRoot, "workspaceRoot");
  return workspaceRoot;
}

export async function createProposalBackup(request: CreateProposalBackupRequest): Promise<ProposalBackup> {
  requireDesktop();
  requireWorkspaceRoot(request.workspaceRoot);
  requireText(request.filePath, "filePath");
  return invoke<ProposalBackup>("create_proposal_backup", { request });
}

export async function listProposalBackups(request: ListProposalBackupsRequest): Promise<ProposalBackup[]> {
  requireDesktop();
  requireWorkspaceRoot(request.workspaceRoot);
  return invoke<ProposalBackup[]>("list_proposal_backups", { request });
}

export async function restoreProposalBackup(request: RestoreProposalBackupRequest): Promise<RestoreProposalBackupResult> {
  requireDesktop();
  requireWorkspaceRoot(request.workspaceRoot);
  requireText(request.filePath, "filePath");
  requireText(request.backupPath, "backupPath");
  return invoke<RestoreProposalBackupResult>("restore_proposal_backup", { request });
}

export async function commitLongTaskChapter(request: CommitLongTaskChapterRequest): Promise<CommitLongTaskChapterResult> {
  requireDesktop();
  requireWorkspaceRoot(request.workspaceRoot);
  requireText(request.taskId, "taskId");
  requireText(request.chapterId, "chapterId");
  requireText(request.filePath, "filePath");
  requireText(request.expectedDocumentHash, "expectedDocumentHash");
  requireText(request.expectedChapterHash, "expectedChapterHash");
  requireText(request.replacementMarkdown, "replacementMarkdown");
  requireText(request.targetDocumentHash, "targetDocumentHash");
  return invoke<CommitLongTaskChapterResult>("commit_long_task_chapter", { request });
}

export async function saveLongWritingTask<TTask>(workspaceRoot: string, task: TTask): Promise<TTask> {
  requireDesktop();
  return invoke<TTask>("save_proposal_long_task", {
    workspaceRoot: requireWorkspaceRoot(workspaceRoot),
    task,
  });
}

export async function loadLongWritingTask<TTask>(workspaceRoot: string, taskId: string): Promise<TTask | null> {
  requireDesktop();
  requireText(taskId, "taskId");
  return invoke<TTask | null>("get_proposal_long_task", {
    workspaceRoot: requireWorkspaceRoot(workspaceRoot),
    taskId,
  });
}

export async function listLongWritingTasks<TTask>(workspaceRoot: string, filePath?: string | null): Promise<TTask[]> {
  requireDesktop();
  return invoke<TTask[]>("list_proposal_long_tasks", {
    workspaceRoot: requireWorkspaceRoot(workspaceRoot),
    filePath: filePath || null,
  });
}

export async function saveLongWritingChapter<TChapter>(
  workspaceRoot: string,
  taskId: string,
  chapter: TChapter,
): Promise<TChapter> {
  requireDesktop();
  requireText(taskId, "taskId");
  return invoke<TChapter>("save_proposal_long_task_chapter", {
    workspaceRoot: requireWorkspaceRoot(workspaceRoot),
    taskId,
    chapter,
  });
}

export async function listLongWritingChapters<TChapter>(workspaceRoot: string, taskId: string): Promise<TChapter[]> {
  requireDesktop();
  requireText(taskId, "taskId");
  return invoke<TChapter[]>("list_proposal_long_task_chapters", {
    workspaceRoot: requireWorkspaceRoot(workspaceRoot),
    taskId,
  });
}

export async function recoverLongWritingTask<TTask, TChapter>(
  workspaceRoot: string,
  taskId: string,
): Promise<LongWritingRecoveryResult<TTask, TChapter>> {
  requireDesktop();
  requireText(taskId, "taskId");
  return invoke<LongWritingRecoveryResult<TTask, TChapter>>("recover_proposal_long_task", {
    workspaceRoot: requireWorkspaceRoot(workspaceRoot),
    taskId,
  });
}

export async function deleteLongWritingTask(workspaceRoot: string, taskId: string): Promise<void> {
  requireDesktop();
  requireText(taskId, "taskId");
  await invoke("delete_proposal_long_task", {
    workspaceRoot: requireWorkspaceRoot(workspaceRoot),
    taskId,
  });
}
