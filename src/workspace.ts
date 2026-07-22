import type { LibraryFile, Project, SourceRecord, WorkspaceMarkdownFile, WorkspacePaths } from "./types";
import { makeId, normalizeWorkspacePaths } from "./data";
import { isDesktop } from "./services";
import { invoke } from "@tauri-apps/api/core";

const WORKSPACE_KEY = "tech-proposal-studio.workspace.v1";

export function loadWorkspaceConfig(): WorkspacePaths | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspacePaths & { proposalsDir?: string; libraryDir?: string };
    return normalizeWorkspacePaths(parsed);
  } catch {
    return null;
  }
}

export function saveWorkspaceConfig(paths: WorkspacePaths) {
  const normalized = normalizeWorkspacePaths(paths) ?? paths;
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(normalized));
}

export function withWorkspace(project: Project, paths?: WorkspacePaths | null): Project {
  const workspace = paths
    ?? normalizeWorkspacePaths(project.workspace as WorkspacePaths & { proposalsDir?: string; libraryDir?: string } | undefined)
    ?? loadWorkspaceConfig()
    ?? { root: "", historyDir: "" };
  return { ...project, workspace };
}

export async function ensureWorkspace(paths: WorkspacePaths): Promise<WorkspacePaths> {
  const normalized = normalizeWorkspacePaths(paths) ?? paths;
  if (!isDesktop()) {
    saveWorkspaceConfig(normalized);
    return normalized;
  }
  const ensured = await invoke<WorkspacePaths>("ensure_workspace", { paths: normalized });
  saveWorkspaceConfig(ensured);
  return ensured;
}

export async function pickDirectory(title: string): Promise<string | null> {
  if (!isDesktop()) return null;
  return invoke<string | null>("pick_directory", { title });
}

export async function pickMarkdownFile(title: string, defaultPath?: string): Promise<string | null> {
  if (!isDesktop()) return null;
  return invoke<string | null>("pick_markdown_file", { title, defaultPath: defaultPath || null });
}

export async function getDefaultWorkspaceRoot(): Promise<string> {
  if (!isDesktop()) return "";
  return invoke<string>("default_workspace_root");
}

export async function listWorkspaceMarkdown(root: string): Promise<WorkspaceMarkdownFile[]> {
  if (!isDesktop() || !root) return [];
  return invoke<WorkspaceMarkdownFile[]>("list_workspace_markdown", { root });
}

export async function listLibraryFiles(historyDir: string): Promise<LibraryFile[]> {
  if (!isDesktop() || !historyDir) return [];
  return invoke<LibraryFile[]>("list_library_markdown", { historyDir });
}

export async function readTextFile(path: string): Promise<string> {
  if (!isDesktop()) throw new Error("请在桌面端打开 Markdown 文件");
  return invoke<string>("read_text_file", { path });
}

export async function readBinaryFile(path: string): Promise<Uint8Array> {
  if (!isDesktop()) throw new Error("请在桌面端读取二进制文件");
  const bytes = await invoke<number[]>("read_binary_file", { path });
  return new Uint8Array(bytes);
}

export async function renameFile(oldPath: string, newPath: string): Promise<string> {
  if (!isDesktop()) throw new Error("重命名仅在桌面端可用");
  return invoke<string>("rename_file", { oldPath, newPath });
}

export async function writeTextFile(path: string, content: string): Promise<string> {
  if (!isDesktop()) throw new Error("请在桌面端保存 Markdown 文件");
  return invoke<string>("write_text_file", { path, content });
}

export function uniqueImportedMarkdownName(sourceName: string, existingNames: string[]): string {
  const normalized = sourceName.replace(/\.markdown$/i, ".md").replace(/[<>:"/\\|?*]/g, "_");
  const safeName = /\.md$/i.test(normalized) ? normalized : `${normalized || "导入文档"}.md`;
  const stem = safeName.replace(/\.md$/i, "");
  const used = new Set(existingNames.map(name => name.toLocaleLowerCase()));
  if (!used.has(safeName.toLocaleLowerCase())) return safeName;
  for (let index = 1; ; index += 1) {
    const candidate = `${stem} (${index}).md`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

export async function importMarkdownToWorkspace(sourcePath: string, root: string): Promise<string> {
  if (!isDesktop()) throw new Error("导入 Markdown 仅在桌面端可用");
  if (!root.trim()) throw new Error("请先在设置中配置工作目录");
  const files = await listWorkspaceMarkdown(root);
  const normalizePath = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "").toLocaleLowerCase();
  const existingSource = files.find(file => normalizePath(file.path) === normalizePath(sourcePath));
  if (existingSource) return existingSource.path;
  const content = await readTextFile(sourcePath);
  const sourceName = sourcePath.split(/[\\/]/).pop() || "导入文档.md";
  const fileName = uniqueImportedMarkdownName(sourceName, files.map(file => file.path.split(/[\\/]/).pop() || file.title));
  const separator = root.includes("\\") ? "\\" : "/";
  const destination = `${root.replace(/[\\/]+$/, "")}${separator}${fileName}`;
  return writeTextFile(destination, content);
}

export async function writeLibraryMarkdown(historyDir: string, title: string, content: string): Promise<LibraryFile> {
  if (!isDesktop()) throw new Error("请在桌面端导入到历史资料目录");
  return invoke<LibraryFile>("write_library_markdown", { historyDir, title, content });
}

export async function saveImageToWorkspace(root: string, bytes: number[], preferredName?: string): Promise<{ path: string; relativePath: string }> {
  if (!isDesktop()) throw new Error("请在桌面端粘贴图片");
  return invoke("save_image_to_workspace", { root, bytes, preferredName: preferredName || null });
}

export function libraryFileToSource(file: LibraryFile): SourceRecord {
  return {
    id: makeId(),
    kind: "local",
    title: file.title,
    location: file.path,
    excerpt: file.excerpt,
    fingerprint: file.path,
    accessedAt: file.updatedAt || new Date().toISOString(),
  };
}

/** Refresh local library sources from disk markdown files; keep non-library sources. */
export function mergeLibrarySources(project: Project, files: LibraryFile[]): Project {
  const retained = project.sources.filter((s) => s.kind !== "local");
  const byPath = new Map(project.sources.filter((s) => s.kind === "local").map((s) => [s.location, s]));
  const local = files.map((file) => {
    const old = byPath.get(file.path);
    if (old) {
      return {
        ...old,
        title: file.title,
        excerpt: file.excerpt,
        accessedAt: file.updatedAt || old.accessedAt,
        fingerprint: file.path,
        kind: "local" as const,
      };
    }
    return libraryFileToSource(file);
  });
  return { ...project, sources: [...local, ...retained] };
}
