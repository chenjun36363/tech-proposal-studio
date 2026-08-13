import type { MinerUConfig } from "../../core/types";
import { createProject } from "../../core/data";
import { renumberHeadings } from "../editor/markdownDoc";
import { loadWorkspaceConnections, normalizeMineru } from "../workspace/connections";
import { isDesktop } from "../../services/runtime";
import {
  convertDocumentWithMineru,
  listWorkspaceMarkdown,
  preserveImportSource,
  uniqueImportedMarkdownName,
  writeTextFile,
} from "../workspace/workspace";

const SUPPORTED_EXT = /\.(pdf|docx?)$/i;

export function isSupportedImportDocument(path: string): boolean {
  return SUPPORTED_EXT.test(path);
}

export interface DocumentImportOptions {
  /** Formal proposals keep automatic numbering; knowledge imports preserve source headings. */
  renumberHeadings?: boolean;
}

/** Pure helper: normalize MinerU markdown and optionally apply proposal heading numbering. */
export function prepareImportedMarkdown(raw: string, options: DocumentImportOptions = {}): string {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return options.renumberHeadings === false ? normalized : renumberHeadings(normalized);
}

export function markdownNameFromSource(sourceFileName: string): string {
  const base = sourceFileName.replace(/\.(pdf|docx?)$/i, "").trim() || "导入文档";
  return uniqueImportedMarkdownName(`${base}.md`, []);
}

/** Prefer live workspace connections over in-memory project (localStorage strips apiKey). */
export async function resolveMineruConfig(
  workspaceRoot: string,
  fallback?: MinerUConfig | null,
): Promise<MinerUConfig> {
  const fromDisk = await loadWorkspaceConnections(workspaceRoot.trim() || undefined);
  if (fromDisk?.mineru?.apiKey?.trim() || fromDisk?.mineru) {
    // Prefer disk even when apiKey empty only if we have no better fallback later —
    // always take disk mineru block when present (apiKey may be filled by Rust).
    if (fromDisk.mineru) return normalizeMineru(fromDisk.mineru);
  }
  if (fallback) return normalizeMineru(fallback);
  return normalizeMineru(createProject().mineru);
}

/**
 * Convert Word/PDF via MinerU, renumber headings, write .md under workspace root.
 * Returns absolute path of the written markdown file.
 */
export async function importWordOrPdfToWorkspace(
  sourcePath: string,
  workspaceRoot: string,
  mineru?: MinerUConfig | null,
  options: DocumentImportOptions = {},
): Promise<{ path: string; sourceFileName: string; assetRelativeDir: string | null; originalPath: string | null; originalWarning: string | null }> {
  if (!isDesktop()) throw new Error("Word/PDF 导入仅在桌面端可用");
  if (!workspaceRoot.trim()) throw new Error("请先在设置中配置工作目录");
  if (!isSupportedImportDocument(sourcePath)) {
    throw new Error("仅支持 .pdf / .doc / .docx（推荐 .pdf 或 .docx）");
  }

  const config = await resolveMineruConfig(workspaceRoot, mineru);
  // Allow empty apiKey here: Rust also reads connections.json + keyring.

  const converted = await convertDocumentWithMineru(sourcePath, workspaceRoot, config);
  const markdown = prepareImportedMarkdown(converted.markdown, options);
  const files = await listWorkspaceMarkdown(workspaceRoot);
  const sourceName = converted.sourceFileName || sourcePath.split(/[\\/]/).pop() || "导入文档.pdf";
  const mdName = uniqueImportedMarkdownName(
    markdownNameFromSource(sourceName),
    files.map(file => file.path.split(/[\\/]/).pop() || file.title),
  );
  const separator = workspaceRoot.includes("\\") ? "\\" : "/";
  const destination = `${workspaceRoot.replace(/[\\/]+$/, "")}${separator}${mdName}`;
  const path = await writeTextFile(destination, markdown);

  // Preserve the original PDF / Word separately in the workspace so the user
  // keeps the source document alongside the generated Markdown.
  let originalPath: string | null = null;
  let originalWarning: string | null = null;
  try {
    originalPath = await preserveImportSource(sourcePath, workspaceRoot, "imports");
  } catch (error) {
    originalWarning = error instanceof Error ? error.message : "原始文件未能保留到工作区";
  }

  return {
    path,
    sourceFileName: sourceName,
    assetRelativeDir: converted.assetRelativeDir,
    originalPath,
    originalWarning,
  };
}
