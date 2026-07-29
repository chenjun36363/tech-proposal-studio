import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "./runtime";

export interface GitFileStatus { path: string; indexStatus: string; worktreeStatus: string }
export interface GitRepositoryStatus { isRepository: boolean; branch: string; upstream: string | null; ahead: number; behind: number; remoteUrl: string | null; files: GitFileStatus[] }
export interface GitDiffResult { path: string; staged: boolean; patch: string }
export interface GitCommitSummary { hash: string; shortHash: string; subject: string; author: string; authoredAt: string; refs: string[] }

function desktopOnly() {
  if (!isDesktop()) throw new Error("Git 管理仅在桌面端可用");
}

export async function getGitStatus(root: string) { desktopOnly(); return invoke<GitRepositoryStatus>("git_status", { root }); }
export async function initGitRepository(root: string) { desktopOnly(); return invoke<void>("git_init", { root }); }
export async function stageGitFile(root: string, path: string) { desktopOnly(); return invoke<void>("git_stage", { root, path }); }
export async function unstageGitFile(root: string, path: string) { desktopOnly(); return invoke<void>("git_unstage", { root, path }); }
export async function commitGitChanges(root: string, message: string) { desktopOnly(); return invoke<void>("git_commit", { root, message }); }
export async function getGitDiff(root: string, path: string, staged: boolean) { desktopOnly(); return invoke<GitDiffResult>("git_diff", { root, path, staged }); }
export async function setGitRemote(root: string, remoteUrl: string) { desktopOnly(); return invoke<void>("git_set_remote", { root, remoteUrl }); }
export async function pullGitRepository(root: string) { desktopOnly(); return invoke<void>("git_pull", { root }); }
export async function pushGitRepository(root: string) { desktopOnly(); return invoke<void>("git_push", { root }); }
export async function fetchGitRepository(root: string) { desktopOnly(); return invoke<void>("git_fetch", { root }); }
export async function getGitLog(root: string, limit = 50) { desktopOnly(); return invoke<GitCommitSummary[]>("git_log", { root, limit }); }
export async function getGitCommitDiff(root: string, commit: string) { desktopOnly(); return invoke<GitDiffResult>("git_commit_diff", { root, commit }); }
export async function stageAllGitFiles(root: string) { desktopOnly(); return invoke<void>("git_stage_all", { root }); }
export async function unstageAllGitFiles(root: string) { desktopOnly(); return invoke<void>("git_unstage_all", { root }); }
export async function discardGitFile(root: string, path: string, untracked: boolean) { desktopOnly(); return invoke<void>("git_discard", { root, path, untracked }); }
export async function getGitStagedSummary(root: string) { desktopOnly(); return invoke<string>("git_staged_summary", { root }); }
