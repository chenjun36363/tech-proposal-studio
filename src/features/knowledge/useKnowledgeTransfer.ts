import { useState, type Dispatch, type SetStateAction } from "react";
import { moveWorkspaceMarkdownToKnowledge } from "./knowledge";
import type { Project, WorkspaceMarkdownFile, WorkspacePaths } from "../../core/types";
import { sameDocumentPath } from "../workspace/documentSafety";
import { defaultProposalMarkdown } from "../editor/markdownDoc";

interface KnowledgeTransferOptions {
  project: Project;
  desktop: boolean;
  setProject: Dispatch<SetStateAction<Project>>;
  refreshLibrary: (paths?: WorkspacePaths) => Promise<void>;
  refreshWorkspaceDocs: (paths?: WorkspacePaths) => Promise<WorkspaceMarkdownFile[]>;
  openKnowledgeManager: () => void;
  notify: (message: string) => void;
  beforeDocumentChange: () => Promise<boolean>;
  markCurrentUnsaved: () => void;
}

export function useKnowledgeTransfer({
  project,
  desktop,
  setProject,
  refreshLibrary,
  refreshWorkspaceDocs,
  openKnowledgeManager,
  notify,
  beforeDocumentChange,
  markCurrentUnsaved,
}: KnowledgeTransferOptions) {
  const [transferringPath, setTransferringPath] = useState<string | null>(null);

  const transfer = async (document: WorkspaceMarkdownFile) => {
    const workspace = project.workspace;
    if (!desktop || !workspace) {
      notify("知识管理仅在桌面端可用");
      return;
    }
    const isCurrent = sameDocumentPath(project.filePath, document.path);
    if (isCurrent && !(await beforeDocumentChange())) return;
    setTransferringPath(document.path);
    try {
      const imported = await moveWorkspaceMarkdownToKnowledge(workspace, document.path);
      if (isCurrent) {
        markCurrentUnsaved();
        // 转移当前文档后重置为空白新文档：清空内存内容并断开 filePath，
        // 避免保存时按"标题.md"回退路径把已移走的文档重新写回工作区。
        setProject(current => ({
          ...current,
          markdown: defaultProposalMarkdown(),
          name: "未命名技术方案",
          filePath: undefined,
          updatedAt: new Date().toISOString(),
        }));
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
