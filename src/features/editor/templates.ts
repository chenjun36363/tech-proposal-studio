import { type Project } from "./types";

export interface ProposalTemplate {
  id: string;
  name: string;
  chapterCount: number;
  createdAt: number;
}

const BROWSER_KEY = "tech-proposal-studio.templates.v1";
const TEMPLATES_REL_DIR = ".gouan/templates";
const MANIFEST_FILE = "index.json";

/* ------------------------------------------------------------------ */
/*  Extract skeleton                                                  */
/* ------------------------------------------------------------------ */

/**
 * Strip a full proposal Markdown down to a heading-only skeleton.
 * - H1 is kept as document title
 * - H2+ headings are kept in place
 * - Content between headings is replaced with a standard placeholder
 * - Code blocks, tables, etc. are removed
 */
export function extractTemplateSkeleton(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
  const inCode: boolean[] = [];
  let codeDepth = 0;
  const result: string[] = [];
  let inHeadingBlock = false;
  let lastLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const isCodeFence = /^```/.test(trimmed) || /^~~~/.test(trimmed);
    if (isCodeFence) {
      codeDepth += 1;
      continue;
    }
    if (codeDepth > 0) {
      if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) codeDepth -= 1;
      continue;
    }

    const h = raw.match(HEADING_RE);
    if (h) {
      const level = h[1].length;
      if (result.length > 0 && inHeadingBlock) {
        result.push("", "在此编写本章内容…", "");
      }
      result.push(raw);
      lastLevel = level;
      inHeadingBlock = true;
    } else if (inHeadingBlock && trimmed) {
      // skip content between headings
    }
  }

  // Close the last chapter
  if (inHeadingBlock) {
    result.push("", "在此编写本章内容…");
  }

  return result.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Counting                                                          */
/* ------------------------------------------------------------------ */

function countChapters(skeleton: string): number {
  return (skeleton.match(/^##\s+/gm) ?? []).length;
}

/* ------------------------------------------------------------------ */
/*  Browser-mode helpers                                              */
/* ------------------------------------------------------------------ */

interface BrowserTemplate {
  id: string;
  name: string;
  chapterCount: number;
  createdAt: number;
  markdown: string;
}

function readBrowserTemplates(): BrowserTemplate[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(BROWSER_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBrowserTemplates(templates: BrowserTemplate[]) {
  localStorage.setItem(BROWSER_KEY, JSON.stringify(templates));
}

/* ------------------------------------------------------------------ */
/*  Desktop helpers                                                   */
/* ------------------------------------------------------------------ */

async function templatesDir(root: string): Promise<string> {
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${TEMPLATES_REL_DIR}`;
}

async function ensureDir(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("ensure_workspace_dir", { root: path });
  } catch {
    // may fail if the dir already exists; ignore
  }
}

async function readManifest(root: string): Promise<ProposalTemplate[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const dir = await templatesDir(root);
  try {
    const content = await invoke<string>("read_text_file", {
      path: `${dir}${root.includes("\\") ? "\\" : "/"}${MANIFEST_FILE}`,
    });
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeManifest(root: string, templates: ProposalTemplate[]) {
  const { invoke } = await import("@tauri-apps/api/core");
  const dir = await templatesDir(root);
  await invoke("write_text_file", {
    path: `${dir}${root.includes("\\") ? "\\" : "/"}${MANIFEST_FILE}`,
    content: JSON.stringify(templates, null, 2),
  });
}

async function readTemplateFile(root: string, fileName: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const dir = await templatesDir(root);
  const sep = root.includes("\\") ? "\\" : "/";
  return invoke<string>("read_text_file", { path: `${dir}${sep}${fileName}` });
}

async function writeTemplateFile(root: string, fileName: string, content: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const dir = await templatesDir(root);
  const sep = root.includes("\\") ? "\\" : "/";
  await ensureDir(dir);
  await invoke("write_text_file", {
    path: `${dir}${sep}${fileName}`,
    content,
  });
}

async function deleteTemplateFile(root: string, fileName: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const dir = await templatesDir(root);
  const sep = root.includes("\\") ? "\\" : "/";
  await invoke("delete_file", { path: `${dir}${sep}${fileName}` });
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export async function listTemplates(workspaceRoot?: string): Promise<ProposalTemplate[]> {
  if (workspaceRoot?.trim()) {
    return readManifest(workspaceRoot);
  }
  return readBrowserTemplates().map(({ markdown: _m, ...meta }) => meta);
}

export async function saveTemplate(
  markdown: string,
  name: string,
  workspaceRoot?: string,
): Promise<ProposalTemplate> {
  const skeleton = extractTemplateSkeleton(markdown);
  const chapterCount = countChapters(skeleton);
  const id = `tmpl-${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = Date.now();
  const meta: ProposalTemplate = { id, name, chapterCount, createdAt };

  if (workspaceRoot?.trim()) {
    const existing = await readManifest(workspaceRoot);
    existing.push(meta);
    await writeManifest(workspaceRoot, existing);
    await writeTemplateFile(workspaceRoot, `${id}.md`, skeleton);
  } else {
    const all = readBrowserTemplates();
    all.push({ ...meta, markdown: skeleton });
    writeBrowserTemplates(all);
  }

  return meta;
}

export async function loadTemplateContent(
  id: string,
  workspaceRoot?: string,
): Promise<string> {
  if (workspaceRoot?.trim()) {
    return readTemplateFile(workspaceRoot, `${id}.md`);
  }
  const all = readBrowserTemplates();
  const t = all.find(item => item.id === id);
  if (!t) throw new Error(`找不到模板：${id}`);
  return t.markdown;
}

export async function deleteTemplate(
  id: string,
  workspaceRoot?: string,
): Promise<void> {
  if (workspaceRoot?.trim()) {
    let all = await readManifest(workspaceRoot);
    all = all.filter(item => item.id !== id);
    await writeManifest(workspaceRoot, all);
    await deleteTemplateFile(workspaceRoot, `${id}.md`).catch(() => undefined);
  } else {
    const all = readBrowserTemplates().filter(item => item.id !== id);
    writeBrowserTemplates(all);
  }
}

/**
 * Create a ready-to-use proposal Markdown from a template, setting the H1 title.
 */
export async function applyTemplate(
  templateId: string,
  title: string,
  workspaceRoot?: string,
): Promise<string> {
  const skeleton = await loadTemplateContent(templateId, workspaceRoot);
  // Replace H1 title line
  const lines = skeleton.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s/.test(lines[i])) {
      lines[i] = `# ${title}`;
      break;
    }
  }
  return lines.join("\n");
}

/** The default 9-chapter template as a named entry. */
export function defaultTemplateMeta(): ProposalTemplate {
  return {
    id: "__default__",
    name: "默认 9 章模板",
    chapterCount: 9,
    createdAt: 0,
  };
}
