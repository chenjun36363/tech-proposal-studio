import { useState, type Dispatch, type SetStateAction } from "react";
import { applyConnections, loadWorkspaceConnections } from "../features/workspace/connections";
import { makeId } from "../core/data";
import { importWordOrPdfToWorkspace } from "../features/export/documentImport";
import { defaultProposalMarkdown, fileNameFromTitle, parseMarkdownHeadings, titleFromMarkdown } from "../features/editor/markdownDoc";
import { exportMarkdown } from "../features/workspace/storage";
import type { Project } from "../core/types";
import type { DocumentStatus, TextFileSnapshot } from "../features/workspace/documentSafety";
import {
  readTextFileSnapshot,
  sameDocumentPath,
  saveTextFileAs,
  writeTextFileChecked,
} from "../features/workspace/documentSafety";
import {
  importMarkdownToWorkspace,
  pickMarkdownFile,
  renameFile,
  withWorkspace,
} from "../features/workspace/workspace";

export type UnsafeDocumentAction = "open" | "create" | "import" | "reload" | "workspace" | "delete" | "close" | "knowledge";
export type ConflictChoice = "saveAs" | "force" | "cancel";

interface DocumentSafetyActions {
  baseline: TextFileSnapshot | null;
  status: DocumentStatus;
  openWithRecovery: (path: string, seed: Project, migrateCachedProject?: boolean) => Promise<Project>;
  markSaved: (snapshot: TextFileSnapshot) => Promise<void>;
  markUnsaved: () => void;
  markConflict: (snapshot?: TextFileSnapshot | null) => void;
  renameBaseline: (path: string) => void;
  getBaseline: () => TextFileSnapshot | null;
}

interface ProposalFileActionsOptions {
  project: Project;
  desktop: boolean;
  setProject: Dispatch<SetStateAction<Project>>;
  resetHistory: () => void;
  selectedHeadingId: string | null;
  setSelectedHeadingId: Dispatch<SetStateAction<string | null>>;
  setEditorMode: Dispatch<SetStateAction<"section" | "full">>;
  refreshWorkspaceDocs: () => Promise<void>;
  notify: (message: string) => void;
  safety: DocumentSafetyActions;
  beforeDocumentChange: (reason: UnsafeDocumentAction) => Promise<boolean>;
  resolveConflict: () => Promise<ConflictChoice>;
}

export function useProposalFileActions({
  project,
  desktop,
  setProject,
  resetHistory,
  selectedHeadingId,
  setSelectedHeadingId,
  setEditorMode,
  refreshWorkspaceDocs,
  notify,
  safety,
  beforeDocumentChange,
  resolveConflict,
}: ProposalFileActionsOptions) {
  const [importingDocument, setImportingDocument] = useState(false);
  const workspace = project.workspace;

  const applySavedSnapshot = async (snapshot: TextFileSnapshot, markdown: string) => {
    setProject(current => ({
      ...current,
      markdown,
      filePath: snapshot.path,
      name: titleFromMarkdown(markdown, current.name),
      updatedAt: new Date().toISOString(),
    }));
    await safety.markSaved(snapshot);
    await refreshWorkspaceDocs();
  };

  const saveContent = async (content: string, explicitPath?: string): Promise<TextFileSnapshot | null> => {
    if (safety.status === "checking") {
      notify("正在检查磁盘文件与共享草稿，请稍候再保存");
      return null;
    }
    if (!desktop) {
      notify("浏览器模式仅保存到 localStorage");
      return null;
    }
    if (!workspace?.root) {
      notify("请先在设置中配置工作目录");
      return null;
    }
    const separator = workspace.root.includes("\\") ? "\\" : "/";
    const path = explicitPath ?? project.filePath ?? `${workspace.root.replace(/[\\/]+$/, "")}${separator}${fileNameFromTitle(project.name)}`;
    const expected = safety.baseline && safety.baseline.path.replace(/\//g, "\\").toLocaleLowerCase() === path.replace(/\//g, "\\").toLocaleLowerCase()
      ? safety.baseline.sha256
      : null;
    try {
      const resolveExistingConflict = async (): Promise<TextFileSnapshot | "force" | null> => {
        const choice = await resolveConflict();
        if (choice === "cancel") return null;
        if (choice === "saveAs") {
          const snapshot = await saveTextFileAs(
            fileNameFromTitle(project.name),
            content,
            workspace.root,
          );
          if (!snapshot) return null;
          await applySavedSnapshot(snapshot, content);
          notify(`已另存为：${snapshot.path.split(/[\/]/).pop()}`);
          return snapshot;
        }
        return "force";
      };

      let result;
      const savingConflictedDocument = safety.status === "conflict"
        && sameDocumentPath(safety.baseline?.path ?? project.filePath, path);
      if (savingConflictedDocument) {
        const resolution = await resolveExistingConflict();
        if (!resolution) return null;
        if (resolution !== "force") return resolution;
        result = await writeTextFileChecked(path, content, expected, true);
      } else {
        result = await writeTextFileChecked(path, content, expected, false);
        if (result.outcome === "conflict") {
          safety.markConflict(result.snapshot);
          const resolution = await resolveExistingConflict();
          if (!resolution) return null;
          if (resolution !== "force") return resolution;
          result = await writeTextFileChecked(path, content, expected, true);
        }
      }
      if (result.outcome !== "saved") return null;
      await applySavedSnapshot(result.snapshot, content);
      notify("方案已保存到工作目录");
      return result.snapshot;
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败");
      return null;
    }
  };

  const save = async (): Promise<boolean> => Boolean(await saveContent(exportMarkdown(project)));

  const saveAsCopy = async (): Promise<boolean> => {
    if (!desktop || !workspace?.root) return false;
    try {
      const snapshot = await saveTextFileAs(fileNameFromTitle(project.name), exportMarkdown(project), workspace.root);
      if (!snapshot) return false;
      notify(`已保存副本：${snapshot.path.split(/[\/]/).pop()}`);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "另存副本失败");
      return false;
    }
  };

  const bindOpenedProject = (next: Project) => {
    resetHistory();
    setProject(next);
    setSelectedHeadingId(parseMarkdownHeadings(next.markdown)[0]?.id ?? null);
    setEditorMode("section");
  };

  const openPath = async (path: string, skipGuard = false): Promise<boolean> => {
    if (!skipGuard && !(await beforeDocumentChange("open"))) return false;
    try {
      const seed = withWorkspace({
        ...project,
        id: makeId(),
        filePath: path,
        updatedAt: new Date().toISOString(),
        sources: project.sources,
        contextSourceRefs: [],
      }, workspace);
      const next = await safety.openWithRecovery(path, seed);
      bindOpenedProject(next);
      notify(`已打开：${next.name}`);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "打开失败");
      return false;
    }
  };

  const reload = async (): Promise<boolean> => {
    if (!desktop) { notify("请在桌面端重新加载"); return false; }
    const path = project.filePath;
    if (!path) { notify("当前未关联磁盘 Markdown，请先打开或保存文件"); return false; }
    if (!(await beforeDocumentChange("reload"))) return false;
    try {
      const reloadPath = safety.getBaseline()?.path ?? path;
      const snapshot = await readTextFileSnapshot(reloadPath);
      resetHistory();
      setProject(current => ({ ...current, markdown: snapshot.content, name: titleFromMarkdown(snapshot.content, current.name), filePath: snapshot.path, updatedAt: new Date().toISOString() }));
      await safety.markSaved(snapshot);
      const headings = parseMarkdownHeadings(snapshot.content);
      setSelectedHeadingId(headings.some(heading => heading.id === selectedHeadingId) ? selectedHeadingId : (headings[0]?.id ?? null));
      notify("已从磁盘重新加载");
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "重新加载失败");
      return false;
    }
  };

  const openFromDialog = async () => {
    if (!desktop) return notify("请在桌面端打开文件");
    const path = await pickMarkdownFile("选择要编辑的 Markdown", workspace?.root);
    if (path) await openPath(path);
  };

  const importMarkdown = async (sourcePath: string): Promise<boolean> => {
    if (!desktop) { notify("请在桌面端导入文件"); return false; }
    if (!workspace?.root) { notify("请先在设置中配置工作目录"); return false; }
    if (!(await beforeDocumentChange("import"))) return false;
    try {
      const importedPath = await importMarkdownToWorkspace(sourcePath, workspace.root);
      const opened = await openPath(importedPath, true);
      await refreshWorkspaceDocs();
      if (opened) notify(`已导入并加载：${importedPath.split(/[\\/]/).pop()}`);
      return opened;
    } catch (error) {
      notify(error instanceof Error ? error.message : "导入失败");
      return false;
    }
  };

  const importWordPdf = async (sourcePath: string): Promise<boolean> => {
    if (!desktop) { notify("Word/PDF 导入仅在桌面端可用"); return false; }
    if (!workspace?.root) { notify("请先在设置中配置工作目录"); return false; }
    if (!(await beforeDocumentChange("import"))) return false;
    const connections = await loadWorkspaceConnections(workspace.root);
    if (connections) setProject(current => applyConnections(current, connections));
    setImportingDocument(true);
    try {
      const { path, sourceFileName, assetRelativeDir } = await importWordOrPdfToWorkspace(sourcePath, workspace.root, connections?.mineru ?? project.mineru);
      const opened = await openPath(path, true);
      await refreshWorkspaceDocs();
      if (opened) notify(`已通过 MinerU 导入：${sourceFileName} → ${path.split(/[\\/]/).pop()}${assetRelativeDir ? `，图片 → ${assetRelativeDir}` : ""}`);
      return opened;
    } catch (error) {
      notify(error instanceof Error ? error.message : "Word/PDF 导入失败");
      return false;
    } finally {
      setImportingDocument(false);
    }
  };

  const create = async () => {
    if (!desktop) return notify("新建文件仅在桌面端可用");
    if (!workspace?.root) return notify("请在设置中配置工作目录");
    const name = window.prompt("请输入文件名：")?.trim();
    if (!name) return;
    if (!(await beforeDocumentChange("create"))) return;
    const fileName = fileNameFromTitle(name);
    const separator = workspace.root.includes("\\") ? "\\" : "/";
    const path = `${workspace.root.replace(/[\\/]+$/, "")}${separator}${fileName}`;
    try {
      const result = await writeTextFileChecked(path, defaultProposalMarkdown(name), null, false);
      if (result.outcome === "conflict") throw new Error(`文件已存在：${fileName}`);
      await safety.markSaved(result.snapshot);
      await openPath(path, true);
      await refreshWorkspaceDocs();
      notify(`已创建：${fileName}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "创建失败");
    }
  };

  const rename = async () => {
    if (safety.status === "checking") return notify("正在检查磁盘文件与共享草稿，请稍候再重命名");
    if (!desktop) return notify("重命名仅在桌面端可用");
    if (!project.filePath) return notify("请先打开一个文件");
    const oldPath = project.filePath;
    const oldName = oldPath.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || "";
    const name = window.prompt("请输入新文件名：", oldName)?.trim();
    if (!name || name === oldName) return;
    const dir = oldPath.slice(0, Math.max(oldPath.lastIndexOf("\\"), oldPath.lastIndexOf("/")));
    const newPath = `${dir}${oldPath.includes("\\") ? "\\" : "/"}${fileNameFromTitle(name)}`;
    try {
      await renameFile(oldPath, newPath);
      safety.renameBaseline(newPath);
      setProject(current => ({ ...current, filePath: newPath, name, updatedAt: new Date().toISOString() }));
      await refreshWorkspaceDocs();
      notify(`已重命名为：${fileNameFromTitle(name)}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "重命名失败");
    }
  };

  return { importingDocument, save, saveContent, saveAsCopy, openPath, reload, openFromDialog, importMarkdown, importWordPdf, create, rename };
}
