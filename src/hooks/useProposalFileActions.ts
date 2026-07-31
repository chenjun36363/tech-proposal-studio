import { useState, type Dispatch, type SetStateAction } from "react";
import { applyConnections, loadWorkspaceConnections } from "../features/workspace/connections";
import { makeId } from "../core/data";
import { importWordOrPdfToWorkspace } from "../features/export/documentImport";
import { defaultProposalMarkdown, fileNameFromTitle, parseMarkdownHeadings, titleFromMarkdown } from "../features/editor/markdownDoc";
import { exportMarkdown } from "../features/workspace/storage";
import type { Project } from "../core/types";
import {
  importMarkdownToWorkspace,
  pickDocumentFile,
  pickMarkdownFile,
  readTextFile,
  renameFile,
  withWorkspace,
  writeTextFile,
} from "../features/workspace/workspace";

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
}: ProposalFileActionsOptions) {
  const [importingDocument, setImportingDocument] = useState(false);
  const workspace = project.workspace;

  const save = async () => {
    if (!desktop) return notify("浏览器模式仅保存到 localStorage");
    try {
      if (!workspace?.root) return notify("请先在设置中配置工作目录");
      const separator = workspace.root.includes("\\") ? "\\" : "/";
      const path = project.filePath ?? `${workspace.root.replace(/[\\/]+$/, "")}${separator}${fileNameFromTitle(project.name)}`;
      const saved = await writeTextFile(path, exportMarkdown(project));
      setProject(current => ({ ...current, filePath: saved, updatedAt: new Date().toISOString() }));
      await refreshWorkspaceDocs();
      notify("方案已保存到工作目录");
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败");
    }
  };

  const openPath = async (path: string) => {
    try {
      const markdown = await readTextFile(path);
      const next = withWorkspace({
        ...project,
        id: makeId(),
        name: titleFromMarkdown(markdown, path.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || "未命名"),
        markdown,
        filePath: path,
        updatedAt: new Date().toISOString(),
        sources: project.sources,
        contextSourceRefs: [],
      }, workspace);
      resetHistory();
      setProject(next);
      setSelectedHeadingId(parseMarkdownHeadings(markdown)[0]?.id ?? null);
      setEditorMode("section");
      notify(`已打开：${next.name}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "打开失败");
    }
  };

  const reload = async () => {
    if (!desktop) return notify("请在桌面端重新加载");
    const path = project.filePath;
    if (!path) return notify("当前未关联磁盘 Markdown，请先打开或保存文件");
    try {
      const markdown = await readTextFile(path);
      resetHistory();
      setProject(current => ({ ...current, markdown, name: titleFromMarkdown(markdown, current.name), filePath: path, updatedAt: new Date().toISOString() }));
      const headings = parseMarkdownHeadings(markdown);
      setSelectedHeadingId(headings.some(heading => heading.id === selectedHeadingId) ? selectedHeadingId : (headings[0]?.id ?? null));
      notify("已从磁盘重新加载");
    } catch (error) {
      notify(error instanceof Error ? error.message : "重新加载失败");
    }
  };

  const openFromDialog = async () => {
    if (!desktop) return notify("请在桌面端打开文件");
    const path = await pickMarkdownFile("选择要编辑的 Markdown", workspace?.root);
    if (path) await openPath(path);
  };

  const importMarkdown = async () => {
    if (!desktop) return notify("请在桌面端导入文件");
    if (!workspace?.root) return notify("请先在设置中配置工作目录");
    const sourcePath = await pickMarkdownFile("选择要导入到工作区的 Markdown");
    if (!sourcePath) return;
    try {
      const importedPath = await importMarkdownToWorkspace(sourcePath, workspace.root);
      await openPath(importedPath);
      await refreshWorkspaceDocs();
      notify(`已导入并加载：${importedPath.split(/[\\/]/).pop()}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "导入失败");
    }
  };

  const importWordPdf = async () => {
    if (!desktop) return notify("Word/PDF 导入仅在桌面端可用");
    if (!workspace?.root) return notify("请先在设置中配置工作目录");
    const connections = await loadWorkspaceConnections(workspace.root);
    if (connections) setProject(current => applyConnections(current, connections));
    const sourcePath = await pickDocumentFile("选择要导入的 Word / PDF（推荐 .docx / .pdf）", workspace.root);
    if (!sourcePath) return;
    setImportingDocument(true);
    try {
      const { path, sourceFileName, assetRelativeDir } = await importWordOrPdfToWorkspace(sourcePath, workspace.root, connections?.mineru ?? project.mineru);
      await openPath(path);
      await refreshWorkspaceDocs();
      notify(`已通过 MinerU 导入：${sourceFileName} → ${path.split(/[\\/]/).pop()}${assetRelativeDir ? `，图片 → ${assetRelativeDir}` : ""}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Word/PDF 导入失败");
    } finally {
      setImportingDocument(false);
    }
  };

  const create = async () => {
    if (!desktop) return notify("新建文件仅在桌面端可用");
    if (!workspace?.root) return notify("请在设置中配置工作目录");
    const name = window.prompt("请输入文件名：")?.trim();
    if (!name) return;
    const fileName = fileNameFromTitle(name);
    const separator = workspace.root.includes("\\") ? "\\" : "/";
    const path = `${workspace.root.replace(/[\\/]+$/, "")}${separator}${fileName}`;
    try {
      await writeTextFile(path, defaultProposalMarkdown(name));
      await openPath(path);
      await refreshWorkspaceDocs();
      notify(`已创建：${fileName}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "创建失败");
    }
  };

  const rename = async () => {
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
      setProject(current => ({ ...current, filePath: newPath, name, updatedAt: new Date().toISOString() }));
      await refreshWorkspaceDocs();
      notify(`已重命名为：${fileNameFromTitle(name)}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "重命名失败");
    }
  };

  return { importingDocument, save, openPath, reload, openFromDialog, importMarkdown, importWordPdf, create, rename };
}
