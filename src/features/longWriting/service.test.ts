// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  commitLongTaskChapter,
  createProposalBackup,
  deleteLongWritingTask,
  listLongWritingChapters,
  listLongWritingTasks,
  listProposalBackups,
  loadLongWritingTask,
  recoverLongWritingTask,
  restoreProposalBackup,
  saveLongWritingChapter,
  saveLongWritingTask,
} from "./service";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const workspaceRoot = "D:\\workspace";
const filePath = "D:\\workspace\\proposal.md";

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.clearAllMocks();
});

describe("long writing Tauri service seam", () => {
  it("wraps backup creation, listing and restore commands", async () => {
    const backup = {
      path: "D:\\workspace\\.gouan\\backups\\proposal.md",
      filePath,
      sha256: "old-hash",
      createdAt: "2026-07-31T00:00:00Z",
      kind: "original" as const,
      taskId: "task-1",
    };
    vi.mocked(invoke)
      .mockResolvedValueOnce(backup)
      .mockResolvedValueOnce([backup])
      .mockResolvedValueOnce({ filePath, sha256: "old-hash", content: "# 原文", restoredFrom: backup.path });

    await expect(createProposalBackup({
      workspaceRoot,
      filePath,
      taskId: "task-1",
      kind: "original",
    })).resolves.toEqual(backup);
    expect(invoke).toHaveBeenNthCalledWith(1, "create_proposal_backup", {
      request: { workspaceRoot, filePath, taskId: "task-1", kind: "original" },
    });

    await expect(listProposalBackups({ workspaceRoot, taskId: "task-1" })).resolves.toEqual([backup]);
    expect(invoke).toHaveBeenNthCalledWith(2, "list_proposal_backups", {
      request: { workspaceRoot, taskId: "task-1" },
    });

    await restoreProposalBackup({
      workspaceRoot,
      filePath,
      backupPath: backup.path,
      expectedDocumentHash: "current-hash",
      taskId: "task-1",
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "restore_proposal_backup", {
      request: {
        workspaceRoot,
        filePath,
        backupPath: backup.path,
        expectedDocumentHash: "current-hash",
        taskId: "task-1",
      },
    });
  });

  it("passes every CAS field to commit_long_task_chapter", async () => {
    const request = {
      workspaceRoot,
      taskId: "task-1",
      chapterId: "chapter-2",
      filePath,
      expectedDocumentHash: "document-before",
      expectedChapterHash: "chapter-before",
      replacementMarkdown: "## 第二章\n\n新正文",
      targetDocumentHash: "document-after",
    };
    vi.mocked(invoke).mockResolvedValue({
      outcome: "committed",
      filePath,
      documentHash: "document-after",
      chapterHash: "chapter-after",
      content: "# 方案\n\n## 第二章\n\n新正文",
    });

    await commitLongTaskChapter(request);

    expect(invoke).toHaveBeenCalledWith("commit_long_task_chapter", { request });
  });

  it("wraps task and chapter persistence commands", async () => {
    const task = { id: "task-1", status: "running" };
    const chapter = { id: "chapter-1", taskId: "task-1", status: "queued" };
    vi.mocked(invoke)
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce(chapter)
      .mockResolvedValueOnce([chapter])
      .mockResolvedValueOnce({ task, chapters: [chapter], diskHash: "hash", recovery: "requeued" })
      .mockResolvedValueOnce(undefined);

    await saveLongWritingTask(workspaceRoot, task);
    expect(invoke).toHaveBeenNthCalledWith(1, "save_proposal_long_task", { workspaceRoot, task });

    await loadLongWritingTask(workspaceRoot, "task-1");
    expect(invoke).toHaveBeenNthCalledWith(2, "get_proposal_long_task", { workspaceRoot, taskId: "task-1" });

    await listLongWritingTasks(workspaceRoot, filePath);
    expect(invoke).toHaveBeenNthCalledWith(3, "list_proposal_long_tasks", { workspaceRoot, filePath });

    await saveLongWritingChapter(workspaceRoot, "task-1", chapter);
    expect(invoke).toHaveBeenNthCalledWith(4, "save_proposal_long_task_chapter", { workspaceRoot, taskId: "task-1", chapter });

    await listLongWritingChapters(workspaceRoot, "task-1");
    expect(invoke).toHaveBeenNthCalledWith(5, "list_proposal_long_task_chapters", { workspaceRoot, taskId: "task-1" });

    await recoverLongWritingTask(workspaceRoot, "task-1");
    expect(invoke).toHaveBeenNthCalledWith(6, "recover_proposal_long_task", { workspaceRoot, taskId: "task-1" });

    await deleteLongWritingTask(workspaceRoot, "task-1");
    expect(invoke).toHaveBeenNthCalledWith(7, "delete_proposal_long_task", { workspaceRoot, taskId: "task-1" });
  });

  it("rejects use outside Tauri without invoking the backend", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

    await expect(listProposalBackups({ workspaceRoot })).rejects.toThrow("仅在桌面端可用");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects incomplete CAS requests before invoking Rust", async () => {
    await expect(commitLongTaskChapter({
      workspaceRoot,
      taskId: "task-1",
      chapterId: "chapter-1",
      filePath,
      expectedDocumentHash: "",
      expectedChapterHash: "chapter-before",
      replacementMarkdown: "## 第一章\n\n正文",
      targetDocumentHash: "document-after",
    })).rejects.toThrow("expectedDocumentHash不能为空");
    expect(invoke).not.toHaveBeenCalled();
  });
});
