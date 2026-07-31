import { useState, type Dispatch, type SetStateAction } from "react";
import { moveWorkspaceMarkdownToKnowledge } from "./knowledge";
import { exportMarkdown } from "../workspace/storage";
import type { Project, WorkspaceMarkdownFile, WorkspacePaths } from "../../core/types";
import { writeTextFile } from "../workspace/workspace";

interface KnowledgeTransferOptions {
  project: Project;
  desktop: boolean;
  setProject: Dispatch<SetStateAction<Project>>;
  refreshLibrary: (paths?: WorkspacePaths) => Promise<void>;
  refreshWorkspaceDocs: (paths?: WorkspacePaths) => Promise<void>;
  openKnowledgeManager: () => void;
  notify: (message: string) => void;
}

export function useKnowledgeTransfer({
  project,
  desktop,
  setProject,
  refreshLibrary,
  refreshWorkspaceDocs,
  openKnowledgeManager,
  notify,
}: KnowledgeTransferOptions) {
  const [transferringPath, setTransferringPath] = useState<string | null>(null);

  const transfer = async (document: WorkspaceMarkdownFile) => {
    const workspace = project.workspace;
    if (!desktop || !workspace) {
      notify("知识管理仅在桌面端可用");
      return;
    }
    setTransferringPath(document.path);
    try {
      if (project.filePath === document.path) await writeTextFile(document.path, exportMarkdown(project));
      const imported = await moveWorkspaceMarkdownToKnowledge(workspace, document.path);
      if (project.filePath === document.path) {
        setProject(current => ({ ...current, filePath: undefined, updatedAt: new Date().toISOString() }));
      }
      await refreshWorkspaceDocs(workspace);
      await refreshLibrary(workspace);
      openKnowledgeManager();
      notify(`已移动到知识库：${imported.title}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "转入知识库失败");
    } finally {
      setTransferringPath(null);
    }
  };

  return { transferringPath, transfer };
}
