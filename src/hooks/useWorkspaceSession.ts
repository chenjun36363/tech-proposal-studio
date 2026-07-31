import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { applyConnections, loadWorkspaceConnections } from "../features/workspace/connections";
import { defaultWorkspaceFromRoot } from "../core/data";
import type { Project, WorkspaceMarkdownFile, WorkspacePaths } from "../core/types";
import {
  ensureWorkspace,
  getDefaultWorkspaceRoot,
  listLibraryFiles,
  listWorkspaceMarkdown,
  loadWorkspaceConfig,
  mergeLibrarySources,
  saveWorkspaceConfig,
  withWorkspace,
} from "../features/workspace/workspace";

interface WorkspaceSessionOptions {
  project: Project;
  desktop: boolean;
  setProject: Dispatch<SetStateAction<Project>>;
  notify: (message: string) => void;
}

export function useWorkspaceSession({ project, desktop, setProject, notify }: WorkspaceSessionOptions) {
  const [workspaceDocs, setWorkspaceDocs] = useState<WorkspaceMarkdownFile[]>([]);
  const workspace = project.workspace;

  useEffect(() => {
    void (async () => {
      try {
        if (!desktop) {
          const browserConnections = await loadWorkspaceConnections();
          if (browserConnections) setProject(current => applyConnections(current, browserConnections));
          return;
        }
        let paths = loadWorkspaceConfig();
        if (!paths?.root) {
          const root = await getDefaultWorkspaceRoot();
          if (root) paths = defaultWorkspaceFromRoot(root);
        }
        if (!paths?.root) return;
        const ensured = await ensureWorkspace(paths);
        const connections = await loadWorkspaceConnections(ensured.root);
        setProject(current => applyConnections(withWorkspace(current, ensured), connections));
        const files = await listLibraryFiles(ensured.historyDir);
        setProject(current => mergeLibrarySources(withWorkspace(current, ensured), files));
        setWorkspaceDocs(await listWorkspaceMarkdown(ensured.root));
      } catch (error) {
        notify(error instanceof Error ? error.message : "工作区初始化失败");
      }
    })();
    // Workspace boot runs once when the runtime is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop]);

  const refreshLibrary = async (paths = workspace) => {
    if (!desktop || !paths?.historyDir) return;
    const files = await listLibraryFiles(paths.historyDir);
    setProject(current => mergeLibrarySources(current, files));
    notify(`已加载 ${files.length} 份本地资料`);
  };

  const refreshWorkspaceDocs = async (paths = workspace) => {
    if (!desktop || !paths?.root) return;
    setWorkspaceDocs(await listWorkspaceMarkdown(paths.root));
  };

  const applyWorkspace = async (paths: WorkspacePaths, options?: { loadConnections?: boolean }) => {
    const ensured = await ensureWorkspace(paths);
    saveWorkspaceConfig(ensured);
    const connections = options?.loadConnections ? await loadWorkspaceConnections(ensured.root) : null;
    setProject(current => applyConnections(withWorkspace(current, ensured), connections));
    await refreshLibrary(ensured);
    await refreshWorkspaceDocs(ensured);
    return ensured;
  };

  return { workspaceDocs, refreshLibrary, refreshWorkspaceDocs, applyWorkspace };
}
