import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bold, BookOpen, Brain, Check, ChevronDown, ChevronRight, ChevronUp, Code2, Copy, Download, FilePlus2, FileText, FolderOpen, GitBranch, GitCompare, Globe2, Highlighter, IndentDecrease, IndentIncrease, Info, Italic, Lock, MessageSquareText, Minus, Moon, MoreHorizontal, MoveVertical, Palette, PanelRightClose, PanelRightOpen, Pencil, Plus, Redo2, RefreshCw, Replace, Save, Search, Settings, Sparkles, Strikethrough, Sun, Trash2, Undo2, Wrench, X } from "lucide-react";
import { cycleTheme, getAppliedTheme, type Theme } from "./core/theme";
import { createProject, defaultWorkspaceFromRoot, makeId } from "./core/data";
import { exportMarkdown, loadProject, saveProject } from "./features/workspace/storage";
import { isDesktop } from "./services/runtime";
import { privilegedFileOperation } from "./services/privileged";
import { openWorkspaceDirectory, saveMarkdown } from "./services/system";
import { findMatches, replaceAllMatches, replaceMatch, type FindMatch } from "./features/editor/findReplace";
import { applyInlineFormat } from "./features/editor/inlineFormat";
import { MarkdownPreview, MarkdownSourceEditor, type MarkdownSourceEditorHandle } from "./features/editor/MarkdownEditor";
import { useSynchronizedScroll } from "./features/editor/scrollSync";
import {
  alignHeadingsToRules,
  applyAgentDraft as applyAgentDraftToMarkdown,
  buildHeadingTree,
  countMarkdownWords,
  defaultProposalMarkdown,
  deleteSection,
  fileNameFromTitle,
  insertSection,
  moveSection,
  parseMarkdownHeadings,
  remapHeadingAfterMarkdownChange,
  renumberHeadings,
  replaceSection,
  sectionBody,
  shiftHeadingSectionLevels,
  stripHeadingPrefix,
  titleFromMarkdown,
  type HeadingNode,
  type MdHeading,
} from "./features/editor/markdownDoc";
import { HEADING_NUMBERING_SCHEMES } from "./features/editor/headingNumbering";
import type { AgentDraft, AgentEditorSelection } from "./agent/protocol";
import type { AgentSearchHighlight, AgentWorkspaceRuntime } from "./agent/proposalTools";
import {
  applyTemplate,
  defaultTemplateMeta,
  listTemplates,
  saveTemplate,
  type ProposalTemplate,
} from "./features/editor/templates";
import {
  listLibraryFiles,
  loadWorkspaceConfig,
  mergeLibrarySources,
  pickDirectory,
  pickDocumentFile,
  pickMarkdownFile,
  renameFile,
  withWorkspace,
  writeLibraryMarkdown,
  deleteFile,
} from "./features/workspace/workspace";
import { firstWorkspaceDocumentAfterDelete, readTextFileSnapshot, runDocumentChangeGuard, sameDocumentPath, writeTextFileChecked, type TextFileSnapshot } from "./features/workspace/documentSafety";
import { normalizeAgentSettings } from "./agent/settings";
import { IconButton } from "./components/IconButton";
import { FileUploadPanel } from "./components/FileUploadPanel";
import { DiskConflictModal, UnsavedChangesModal } from "./components/DocumentSafetyModals";
import { InlineMarkdown } from "./components/InlineMarkdown";
import { SourcePreviewModal } from "./components/SourcePreviewModal";
import { MemorySettingsPanel } from "./components/MemorySettingsPanel";
import { ConversationHistorySettings } from "./components/ConversationHistorySettings";
import { ModelSettingsSection } from "./features/settings/ModelSettingsSection";
import { ToolSettingsSection } from "./features/settings/ToolSettingsSection";
import { SkillsSettingsSection } from "./features/settings/SkillsSettingsSection";
import { AppUpdateSettings } from "./features/settings/AppUpdateSettings";
import { WordExportSettingsSection } from "./features/settings/WordExportSettingsSection";
import { ApiKeyField } from "./components/ApiKeyField";
import { useProposalDocumentController } from "./hooks/useProposalDocumentController";
import { useDocumentSafety } from "./hooks/useDocumentSafety";
import { useProposalFileActions, type ConflictChoice, type UnsafeDocumentAction } from "./hooks/useProposalFileActions";
import { useWorkspaceSession } from "./hooks/useWorkspaceSession";
import { WorkspaceSetupGate } from "./components/WorkspaceSetupGate";
import { useSourcePreview } from "./hooks/useSourcePreview";
import { useEnvironmentTools } from "./hooks/useEnvironmentTools";
import { KnowledgeManagerModal } from "./features/knowledge/KnowledgeManagerModal";
import { useKnowledgeTransfer } from "./features/knowledge/useKnowledgeTransfer";
import { InspectorPanel, type InspectorTab } from "./features/inspector/InspectorPanel";
import { WebSearchModal } from "./features/search/WebSearchModal";
import { EnvironmentModal } from "./features/environment/EnvironmentModal";
import { WordExportModal } from "./components/WordExportModal";
import { SourceImportModal } from "./features/workspace/SourceImportModal";
import { GitDiffView, GitSidebar, type GitDiffSelection } from "./features/git/GitWorkspace";
import {
  applyConnections,
  loadWorkspaceConnections,
  sameWorkspaceRoot,
  saveProjectConnections,
} from "./features/workspace/connections";
import type { DocumentBlock, Project, WorkspaceMarkdownFile, WorkspacePaths } from "./core/types";

const appIcon = new URL("../src-tauri/icons/128x128.png", import.meta.url).href;

type EditorMode = "section" | "full";
type WorkspaceImportKind = "document";
type HeadingContextMenu = { x: number; y: number; node: HeadingNode };
type HeadingMoveTarget = { x: number; y: number; source: HeadingNode } | null;
type WorkspaceContextMenu =
  | { kind: "list"; x: number; y: number }
  | { kind: "document"; x: number; y: number; doc: WorkspaceMarkdownFile };

function textareaOffsetForSource(text: string, sourceOffset: number): number {
  return text.slice(0, sourceOffset).replace(/\r\n?/g, "\n").length;
}

function headingTreeHasH6(node: HeadingNode): boolean {
  return node.heading.level >= 6 || node.children.some(headingTreeHasH6);
}
const DOCUMENT_UPLOAD_EXTENSIONS = [".pdf", ".doc", ".docx"] as const;
const RIGHT_PANEL_MIN = 280;
const RIGHT_PANEL_MAX = 720;
const RIGHT_PANEL_DEFAULT = 400;
const LEFT_PANEL_MIN = 180;
const LEFT_PANEL_MAX = 480;
const LEFT_PANEL_DEFAULT = 220;
const SEARXNG_ENGINE_OPTIONS = [
  ["baidu", "百度"],
  ["360search", "360 搜索"],
  ["bing", "Bing"],
  ["duckduckgo", "DuckDuckGo"],
  ["google", "Google"],
  ["brave", "Brave"],
  ["startpage", "Startpage"],
  ["wikipedia", "Wikipedia"],
] as const;
function syntheticBlock(project: Project, content: string, headingId?: string, headingTitle?: string, headingLevel?: number): DocumentBlock {
  return {
    id: project.id,
    sectionId: headingId ?? "markdown",
    type: "text",
    content,
    order: 0,
    status: "draft",
    sourceRefs: project.contextSourceRefs,
    metadata: headingId ? { headingTitle: headingTitle ?? "", headingLevel: String(headingLevel ?? "") } : undefined,
  };
}

// 编辑/预览区域字体缩放（--md-font-scale 作用在 .md-workspace 上）
const EDITOR_FONT_SCALE_KEY = "tech-proposal-studio.editor-font-scale.v1";
const EDITOR_FONT_SCALE_STEP = 0.1;
const EDITOR_FONT_SCALE_MIN = 0.75;
const EDITOR_FONT_SCALE_MAX = 2;
function loadEditorFontScale(): number {
  try {
    const n = Number(localStorage.getItem(EDITOR_FONT_SCALE_KEY));
    if (Number.isFinite(n) && n >= EDITOR_FONT_SCALE_MIN && n <= EDITOR_FONT_SCALE_MAX) return n;
  } catch {
    /* 存储不可用时回退默认值 */
  }
  return 1;
}

// 预览区段落首行缩进偏好（--md-preview-indent 作用在 .md-workspace 上）
const PREVIEW_INDENT_KEY = "tech-proposal-studio.preview-indent.v1";
function loadPreviewIndent(): boolean {
  try {
    return localStorage.getItem(PREVIEW_INDENT_KEY) !== "0";
  } catch {
    return true;
  }
}

// 编辑区/预览区同步滚动偏好（分栏模式下生效）
const SYNC_SCROLL_KEY = "tech-proposal-studio.sync-scroll.v1";
function loadSyncScroll(): boolean {
  try {
    return localStorage.getItem(SYNC_SCROLL_KEY) !== "0";
  } catch {
    return true;
  }
}

export default function App() {
  const { project, setProject, updateProject, setMarkdown, undo, redo, resetHistory } = useProposalDocumentController(
    () => withWorkspace(loadProject(), loadWorkspaceConfig()),
  );
  const projectRef = useRef(project);
  projectRef.current = project;
  const [rightTab, setRightTab] = useState<InspectorTab>("commands");
  const [rightOpen, setRightOpen] = useState(true);
  const [theme, setTheme] = useState<Theme>(getAppliedTheme);
  const [rightWidth, setRightWidth] = useState(RIGHT_PANEL_DEFAULT);
  const [leftWidth, setLeftWidth] = useState(LEFT_PANEL_DEFAULT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [workspaceImportKind, setWorkspaceImportKind] = useState<WorkspaceImportKind | null>(null);
  const [knowledgeManagerOpen, setKnowledgeManagerOpen] = useState(false);
  const [webSearchOpen, setWebSearchOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [exportMenu, setExportMenu] = useState(false);
  const [wordExportOpen, setWordExportOpen] = useState(false);
  const [selectedHeadingId, setSelectedHeadingId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("section");
  const [fullTextLocked, setFullTextLocked] = useState(false);
  const [viewMode, setViewMode] = useState<"split" | "edit" | "preview">("split");
  const [editorFontScale, setEditorFontScale] = useState<number>(() => loadEditorFontScale());
  const [previewIndent, setPreviewIndent] = useState<boolean>(() => loadPreviewIndent());
  const [syncScroll, setSyncScroll] = useState<boolean>(() => loadSyncScroll());
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findIndex, setFindIndex] = useState(-1);
  const [collapsedHeadings, setCollapsedHeadings] = useState<Set<string>>(new Set());
  const [headingContextMenu, setHeadingContextMenu] = useState<HeadingContextMenu | null>(null);
  const [headingMoveTarget, setHeadingMoveTarget] = useState<HeadingMoveTarget>(null);
  const [workspaceContextMenu, setWorkspaceContextMenu] = useState<WorkspaceContextMenu | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [workspaceDocsCollapsed, setWorkspaceDocsCollapsed] = useState(false);
  const [leftView, setLeftView] = useState<"outline" | "git">("outline");
  const [gitDiff, setGitDiff] = useState<GitDiffSelection | null>(null);
  const [gitDiffActive, setGitDiffActive] = useState(false);
  const [agentSelection, setAgentSelection] = useState<AgentEditorSelection | undefined>(undefined);
  const confirmDeleteRef = useRef<number>(0);
  const allowCloseRef = useRef(false);
  const closePendingRef = useRef(false);
  const sourcePreview = useSourcePreview();
  const rightDrag = useRef<{ startX: number; startW: number } | null>(null);
  const leftDrag = useRef<{ startX: number; startW: number } | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceActionsMenuRef = useRef<HTMLDivElement | null>(null);
  const sourceEditorRef = useRef<MarkdownSourceEditorHandle | null>(null);
  const sourceScrollRef = useRef<HTMLTextAreaElement | null>(null);
  const previewPaneRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Toolbar mousedown can blur the editor before the click handler runs.
  // Keep a synchronous snapshot so the selected search text cannot be lost.
  const pendingFindSelectionRef = useRef<string | null>(null);
  const desktop = isDesktop();
  useSynchronizedScroll(sourceScrollRef, previewPaneRef, viewMode === "split" && syncScroll);
  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2500); }, []);
  const enterSectionMode = useCallback(() => { setEditorMode("section"); setFullTextLocked(false); }, []);
  const enterFullTextMode = useCallback(() => { setEditorMode("full"); setFullTextLocked(false); }, []);
  const locateHeadingInFullText = (heading: MdHeading) => {
    setSelectedHeadingId(heading.id);
    setCollapsedHeadings(current => {
      const next = new Set(current);
      next.delete(heading.id);
      return next;
    });
    requestAnimationFrame(() => {
      if (viewMode !== "preview" && sourceEditorRef.current) {
        sourceEditorRef.current.setSelection(heading.start, heading.start);
        sourceEditorRef.current.scrollToSelection();
        return;
      }
      const pane = previewPaneRef.current;
      if (!pane) return;
      const renderedHeadings = Array.from(pane.querySelectorAll("h1, h2, h3, h4, h5, h6")) as HTMLElement[];
      const headingIndex = headings.findIndex(item => item.id === heading.id);
      const target = headingIndex >= 0 ? renderedHeadings[headingIndex] : undefined;
      if (target) {
        const paneRect = pane.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        pane.scrollTop = Math.max(0, pane.scrollTop + targetRect.top - paneRect.top - 16);
        return;
      }
      // Fallback for a renderer that omits a heading: match by level/title,
      // but do so against the rendered pane rather than offsetTop from a
      // different offset parent.
      const title = stripHeadingPrefix(heading.title).replace(/\s+/g, " ").trim();
      const targetByTitle = Array.from(pane.querySelectorAll(`h${heading.level}`))
        .map(node => node as HTMLElement)
        .find(el => {
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          return text === title || text.endsWith(title) || text.startsWith(title);
        });
      if (targetByTitle) {
        const paneRect = pane.getBoundingClientRect();
        const targetRect = targetByTitle.getBoundingClientRect();
        pane.scrollTop = Math.max(0, pane.scrollTop + targetRect.top - paneRect.top - 16);
      }
    });
  };
  const [guardRequest, setGuardRequest] = useState<{ reason: UnsafeDocumentAction; resolve: (choice: "save" | "discard" | "cancel") => void } | null>(null);
  const [conflictRequest, setConflictRequest] = useState<{ resolve: (choice: ConflictChoice) => void } | null>(null);
  const saveToWorkspaceRef = useRef<() => Promise<boolean>>(async () => false);
  const saveAsCopyRef = useRef<() => Promise<boolean>>(async () => false);
  const [longWritingLocked, setLongWritingLocked] = useState(false);
  const safety = useDocumentSafety({ project, setProject, resetHistory, desktop, notify });
  const requestGuardChoice = useCallback((reason: UnsafeDocumentAction) => new Promise<"save" | "discard" | "cancel">(resolve => {
    setGuardRequest({ reason, resolve });
  }), []);
  const resolveConflict = useCallback(() => new Promise<ConflictChoice>(resolve => {
    setConflictRequest({ resolve });
  }), []);
  const beforeDocumentChange = useCallback(async (reason: UnsafeDocumentAction) => {
    if (safety.status === "checking") {
      notify("正在检查磁盘文件与共享草稿，请稍候再操作");
      return false;
    }
    if (longWritingLocked && reason !== "close") {
      notify("长任务正在安全写入文档，请先停止或完成长任务");
      return false;
    }
    return runDocumentChangeGuard({
      isDirty: safety.isDirty,
      flushDraft: safety.flushDraft,
      choose: () => requestGuardChoice(reason),
      save: () => reason === "delete" ? saveAsCopyRef.current() : saveToWorkspaceRef.current(),
      discard: safety.discardChanges,
      clearHandledDrafts: safety.clearHandledDrafts,
    });
  }, [longWritingLocked, notify, requestGuardChoice, safety]);
  const ensureDocumentEditable = useCallback(() => {
    if (safety.status === "checking") {
      notify("正在检查磁盘文件与共享草稿，请稍候再编辑");
      return false;
    }
    if (longWritingLocked) {
      notify("长任务运行期间不能修改正文");
      return false;
    }
    return true;
  }, [longWritingLocked, notify, safety.status]);
  const environmentTools = useEnvironmentTools({ desktop, notify });
  const workspace = project.workspace;
  const markdown = project.markdown ?? "";
  const headings = useMemo(() => parseMarkdownHeadings(markdown), [markdown]);
  const headingTree = useMemo(() => buildHeadingTree(headings), [headings]);
  const selectedHeading = headings.find(h => h.id === selectedHeadingId) ?? headings[0] ?? null;
  const activeBody = selectedHeading && editorMode === "section" ? sectionBody(markdown, selectedHeading) : markdown;
  const activeWordCount = useMemo(() => countMarkdownWords(activeBody), [activeBody]);
  // 行内格式化按钮的可用性与提示文案
  const formatDisabled = longWritingLocked || safety.status === "checking" || viewMode === "preview";
  const formatTitle = (label: string, shortcut?: string) =>
    formatDisabled
      ? (viewMode === "preview" ? "预览模式不可用，请切换到源码或分栏"
        : longWritingLocked ? "长任务运行期间不能修改正文"
        : "正在检查磁盘文件，请稍候")
      : (shortcut ? `${label} (${shortcut})` : label);
  const activeBlock = useMemo(
    () => syntheticBlock(project, activeBody, selectedHeading?.id, selectedHeading?.title, selectedHeading?.level),
    [project, activeBody, selectedHeading],
  );
  const findHits = useMemo(
    () => findMatches(activeBody, findQuery, { caseSensitive: findCaseSensitive }),
    [activeBody, findQuery, findCaseSensitive],
  );

  useEffect(() => {
    if (!exportMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (!exportMenuRef.current?.contains(e.target as Node)) setExportMenu(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [exportMenu]);

  useEffect(() => {
    if (!selectedHeadingId && headings[0]) setSelectedHeadingId(headings[0].id);
    else if (selectedHeadingId && headings.length && !headings.some(h => h.id === selectedHeadingId)) {
      setSelectedHeadingId(headings[0]?.id ?? null);
    }
  }, [headings, selectedHeadingId]);

  useEffect(() => setAgentSelection(undefined), [project.filePath, selectedHeadingId, editorMode]);

  useEffect(() => {
    if (!headingContextMenu && !workspaceContextMenu) return;
    const close = () => {
      setHeadingContextMenu(null);
      setWorkspaceContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [headingContextMenu, workspaceContextMenu]);

  useEffect(() => {
    try {
      localStorage.setItem(EDITOR_FONT_SCALE_KEY, String(editorFontScale));
      localStorage.setItem(PREVIEW_INDENT_KEY, previewIndent ? "1" : "0");
      localStorage.setItem(SYNC_SCROLL_KEY, syncScroll ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [editorFontScale, previewIndent, syncScroll]);

  const { workspaceDocs, refreshLibrary, refreshWorkspaceDocs, applyWorkspace, ready: workspaceReady } = useWorkspaceSession({
    project, desktop, setProject, notify,
  });
  const {
    importingDocument: importingDoc,
    save: saveToWorkspace,
    saveContent: saveWorkspaceContent,
    saveAsCopy: saveCurrentAsCopy,
    openPath: openMarkdownPath,
    reload: reloadCurrentMarkdown,
    importMarkdown: importFromDialog,
    importWordPdf: importWordPdfFromDialog,
    create: createNewFile,
  } = useProposalFileActions({
    project, desktop, setProject, resetHistory, selectedHeadingId, setSelectedHeadingId, setEditorMode,
    refreshWorkspaceDocs: () => refreshWorkspaceDocs(), notify,
    safety,
    beforeDocumentChange,
    resolveConflict,
  });
  const saveCurrentDocument = useCallback(async (): Promise<boolean> => {
    if (longWritingLocked) {
      notify("长任务占有当前文档写锁；请先停止、终止或完成长任务");
      return false;
    }
    return saveToWorkspace();
  }, [longWritingLocked, notify, saveToWorkspace]);
  saveToWorkspaceRef.current = saveCurrentDocument;
  saveAsCopyRef.current = saveCurrentAsCopy;
  const applyLongWritingSnapshot = useCallback(async (snapshot: TextFileSnapshot) => {
    resetHistory();
    setProject(current => ({
      ...current,
      markdown: snapshot.content,
      filePath: snapshot.path,
      name: titleFromMarkdown(snapshot.content, current.name),
      updatedAt: new Date().toISOString(),
    }));
    await safety.markSaved(snapshot);
  }, [resetHistory, safety, setProject]);
  const agentWorkspaceRuntime = useMemo<AgentWorkspaceRuntime | undefined>(() => {
    if (!desktop || !workspace?.root) return undefined;
    const separator = workspace.root.includes("\\") ? "\\" : "/";
    const normalizePath = (value: string) => value.replace(/\//g, "\\").toLocaleLowerCase();
    const requireWorkspaceDocument = (path: string) => {
      const found = workspaceDocs.find(item => normalizePath(item.path) === normalizePath(path));
      if (!found) throw new Error("只能通过工作区文档工具操作目录中已列出的 Markdown 文件");
      return found.path;
    };
    const bind = (next: Project) => {
      projectRef.current = next;
      resetHistory();
      setProject(next);
      setSelectedHeadingId(parseMarkdownHeadings(next.markdown)[0]?.id ?? null);
      enterSectionMode();
      return { markdown: next.markdown, filePath: next.filePath ?? "" };
    };
    const requireAllowed = async (reason: UnsafeDocumentAction) => {
      if (!(await beforeDocumentChange(reason))) throw new Error("用户已取消文档操作，当前编辑内容保持不变");
    };
    return {
      listDocuments: async () => workspaceDocs.map(({ title, path, size }) => ({ title, path, size })),
      createBlank: async name => {
        await requireAllowed("create");
        const title = name.replace(/\.(md|markdown)$/i, "").trim();
        if (!title) throw new Error("文档名称不能为空");
        const fileName = fileNameFromTitle(title);
        const path = `${workspace.root.replace(/[\\/]+$/, "")}${separator}${fileName}`;
        if (workspaceDocs.some(item => normalizePath(item.path) === normalizePath(path))) throw new Error(`文件已存在：${fileName}`);
        const nextMarkdown = `# ${title}\n`;
        const result = await writeTextFileChecked(path, nextMarkdown, null, false);
        if (result.outcome === "conflict") throw new Error(`文件已存在：${fileName}`);
        await safety.markSaved(result.snapshot);
        const next = { ...projectRef.current, id: makeId(), name: title, markdown: nextMarkdown, filePath: result.snapshot.path, contextSourceRefs: [], updatedAt: new Date().toISOString() };
        const state = bind(next);
        await refreshWorkspaceDocs();
        return state;
      },
      open: async path => {
        await requireAllowed("open");
        const resolved = requireWorkspaceDocument(path);
        const seed = { ...projectRef.current, id: makeId(), filePath: resolved, contextSourceRefs: [], updatedAt: new Date().toISOString() };
        return bind(await safety.openWithRecovery(resolved, seed));
      },
      save: async (nextMarkdown, path) => {
        if (!path) throw new Error("当前文档尚未关联磁盘文件");
        if (longWritingLocked) throw new Error("长任务占有当前文档写锁，普通 Agent 不能写入该文件");
        const snapshot = await saveWorkspaceContent(nextMarkdown, path);
        if (!snapshot) throw new Error("保存已取消，当前内容和草稿保持不变");
        projectRef.current = { ...projectRef.current, markdown: nextMarkdown, filePath: snapshot.path, name: titleFromMarkdown(nextMarkdown, projectRef.current.name), updatedAt: new Date().toISOString() };
        return { markdown: nextMarkdown, filePath: snapshot.path };
      },
      reload: async path => {
        if (!path) throw new Error("当前文档尚未关联磁盘文件");
        await requireAllowed("reload");
        const reloadPath = safety.getBaseline()?.path ?? path;
        const snapshot = await readTextFileSnapshot(reloadPath);
        await safety.markSaved(snapshot);
        return bind({ ...projectRef.current, markdown: snapshot.content, filePath: snapshot.path, name: titleFromMarkdown(snapshot.content, projectRef.current.name), updatedAt: new Date().toISOString() });
      },
      rename: async (name, path) => {
        if (!path) throw new Error("当前文档尚未关联磁盘文件");
        const oldPath = requireWorkspaceDocument(path);
        const dir = oldPath.slice(0, Math.max(oldPath.lastIndexOf("\\"), oldPath.lastIndexOf("/")));
        const nextPath = `${dir}${oldPath.includes("\\") ? "\\" : "/"}${fileNameFromTitle(name)}`;
        if (workspaceDocs.some(item => normalizePath(item.path) === normalizePath(nextPath) && normalizePath(item.path) !== normalizePath(oldPath))) throw new Error("目标文件名已存在");
        await renameFile(oldPath, nextPath);
        safety.renameBaseline(nextPath);
        projectRef.current = { ...projectRef.current, filePath: nextPath, name, updatedAt: new Date().toISOString() };
        setProject(projectRef.current);
        await refreshWorkspaceDocs();
        return { markdown: projectRef.current.markdown, filePath: nextPath };
      },
      delete: async (path, mode, currentPath) => {
        const resolved = requireWorkspaceDocument(path);
        const isCurrent = Boolean(currentPath && normalizePath(currentPath) === normalizePath(resolved));
        if (isCurrent) await requireAllowed("delete");
        if (mode === "trash") await privilegedFileOperation({ operation: "delete", path: resolved, deleteMode: "trash" });
        else await deleteFile(resolved);
        const remainingDocuments = await refreshWorkspaceDocs();
        if (isCurrent) {
          await safety.clearHandledDrafts();
          safety.markUnsaved();
          const nextDocument = firstWorkspaceDocumentAfterDelete(remainingDocuments, resolved);
          if (nextDocument) {
            const seed = {
              ...projectRef.current,
              id: makeId(),
              filePath: nextDocument.path,
              contextSourceRefs: [],
              updatedAt: new Date().toISOString(),
            };
            return bind(await safety.openWithRecovery(nextDocument.path, seed));
          }
          return bind({ ...createProject(), workspace: projectRef.current.workspace });
        }
        return null;
      },
      reconcileDocument: (path?: string) => safety.reconcileDocument(path),
    };
  }, [desktop, workspace?.root, workspaceDocs, refreshWorkspaceDocs, resetHistory, setProject, beforeDocumentChange, safety, saveWorkspaceContent, longWritingLocked]);
  const {
    transferringPath: knowledgeTransferPath,
    transfer: transferWorkspaceDocToKnowledge,
  } = useKnowledgeTransfer({
    project, desktop, setProject, refreshLibrary, refreshWorkspaceDocs,
    openKnowledgeManager: () => setKnowledgeManagerOpen(true), notify,
    beforeDocumentChange: () => beforeDocumentChange("knowledge"),
    markCurrentUnsaved: safety.markUnsaved,
  });


  const setActiveContent = (next: string) => {
    if (!ensureDocumentEditable()) return;
    if (selectedHeading && editorMode === "section") {
      const nextMarkdown = replaceSection(markdown, selectedHeading, next);
      const nextHeading = remapHeadingAfterMarkdownChange(markdown, nextMarkdown, selectedHeading.id);
      if (nextHeading) setSelectedHeadingId(nextHeading.id);
      setMarkdown(nextMarkdown);
    } else {
      setMarkdown(next);
    }
  };

  const wrapSelection = (before: string, after: string = before, placeholder = "") => {
    if (viewMode === "preview") {
      notify("预览模式下不能编辑，请切换到源码或分栏后使用样式");
      return;
    }
    const sel = sourceEditorRef.current?.getSelection() ?? { start: 0, end: 0 };
    const { text, selectionStart, selectionEnd } = applyInlineFormat(
      activeBody,
      sel.start,
      sel.end,
      before,
      after,
      placeholder,
    );
    setActiveContent(text);
    requestAnimationFrame(() => {
      sourceEditorRef.current?.setSelection(selectionStart, selectionEnd);
    });
  };
  // 供全局键盘快捷键引用最新版 wrapSelection，避免 useEffect 闭包拿到过期引用
  const wrapSelectionRef = useRef(wrapSelection);
  wrapSelectionRef.current = wrapSelection;

  const toggleCollapse = (id: string) => {
    setCollapsedHeadings(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const expandAll = () => setCollapsedHeadings(new Set());

  const expandToLevel = (level: number) => {
    const next = new Set<string>();
    for (const h of headings) {
      if (h.level > level) next.add(h.id);
    }
    setCollapsedHeadings(next);
  };

  const openHeadingContextMenu = (event: React.MouseEvent, node: HeadingNode) => {
    event.preventDefault();
    const menuWidth = 224;
    const menuHeight = 300;
    setSelectedHeadingId(node.heading.id);
    enterSectionMode();
    setHeadingContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      node,
    });
  };

  const insertHeadingSection = (headingNode: HeadingNode, placement: "before" | "after" | "child") => {
    setHeadingContextMenu(null);
    if (!ensureDocumentEditable()) return;
    const target = headingNode.heading;
    const level = placement === "child" ? target.level + 1 : target.level;
    if (level > 6) return notify("H6 不能再插入子标题");
    if (level === 1) return notify("不能新增文档 H1 标题");

    const rawTitle = window.prompt(
      placement === "child" ? "请输入子章节标题：" : "请输入同级章节标题：",
      "新章节",
    );
    const title = stripHeadingPrefix(rawTitle ?? "").trim();
    if (!title) return;

    try {
      const section = `${"#".repeat(level)} ${title}

`;
      const positioned = insertSection(markdown, target, placement === "before" ? "before" : "after", section);
      const next = renumberHeadings(positioned, project.headingNumbering);
      const inserted = parseMarkdownHeadings(next).find(heading =>
        heading.level === level && stripHeadingPrefix(heading.title) === title,
      );
      setMarkdown(next);
      if (inserted) setSelectedHeadingId(inserted.id);
      enterSectionMode();
      notify(`已插入${placement === "child" ? "子" : "同级"}章节：${title}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "插入章节失败");
    }
  };

  const renderHeadingNodes = (nodes: typeof headingTree): React.ReactNode[] => {
    return nodes.flatMap(node => {
      const hasCh = node.children.length > 0;
      const collapsed = collapsedHeadings.has(node.heading.id);
      const item = (
        <div key={node.heading.id} className={`toc-item-wrap level-${node.heading.level} ${selectedHeading?.id === node.heading.id && (editorMode === "section" || fullTextLocked) ? "selected" : ""}`}>
          <button
            className="toc-item"
            onClick={() => {
              if (fullTextLocked) {
                locateHeadingInFullText(node.heading);
                return;
              }
              setSelectedHeadingId(node.heading.id);
              setEditorMode("section");
            }}
            onContextMenu={event => openHeadingContextMenu(event, node)}
            title={`${node.heading.title}（右键打开章节操作）`}
          >
            <span className="toc-chevron" onMouseDown={hasCh ? (e => { e.stopPropagation(); e.preventDefault(); }) : undefined} onClick={hasCh ? () => toggleCollapse(node.heading.id) : undefined}>
              {hasCh ? (collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />) : null}
            </span>
            <span>H{node.heading.level}</span>
            <InlineMarkdown className="toc-title" children={node.heading.title} />
          </button>
        </div>
      );
      const children = collapsed ? [] : renderHeadingNodes(node.children);
      return [item, ...children];
    });
  };

  const renumberAllHeadings = () => {
    if (!ensureDocumentEditable()) return;
    const fallbackTitle = project.filePath?.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || project.name;
    const result = alignHeadingsToRules(markdown, fallbackTitle, project.headingNumbering);
    const next = result.markdown;
    if (next === markdown) {
      notify("标题编号已是最新");
      return;
    }
    const selection = sourceEditorRef.current?.getSelection();
    const nextHeading = selectedHeading
      ? remapHeadingAfterMarkdownChange(markdown, next, selectedHeading.id)
      : undefined;
    setMarkdown(next);
    if (nextHeading) setSelectedHeadingId(nextHeading.id);
    if (selection) {
      requestAnimationFrame(() => sourceEditorRef.current?.setSelection(selection.start, selection.end));
    }
    notify(result.titleCreated ? "已生成全文标题并重新编号" : "已按所选格式重新编号全部标题");
  };

  /* ---------- Template ---------- */
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templates, setTemplates] = useState<ProposalTemplate[]>([]);

  const openTemplatePicker = async () => {
    const list = await listTemplates(workspace?.root).catch(() => []);
    setTemplates(list);
    setTemplatePickerOpen(true);
  };

  const createFromTemplate = async (templateId: string) => {
    setTemplatePickerOpen(false);
    if (!desktop) return notify("新建文件仅在桌面端可用");
    if (!workspace?.root) return notify("请在设置中配置工作目录");
    const name = window.prompt("请输入文件名：")?.trim();
    if (!name) return;
    if (!(await beforeDocumentChange("create"))) return;
    try {
      const markdown = templateId === "__default__"
        ? defaultProposalMarkdown(name)
        : await applyTemplate(templateId, name, workspace.root);
      const fileName = fileNameFromTitle(name);
      const separator = workspace.root.includes("\\") ? "\\" : "/";
      const path = `${workspace.root.replace(/[\\/]+$/, "")}${separator}${fileName}`;
      const result = await writeTextFileChecked(path, markdown, null, false);
      if (result.outcome === "conflict") throw new Error(`文件已存在：${fileName}`);
      await safety.markSaved(result.snapshot);
      await openMarkdownPath(path, true);
      await refreshWorkspaceDocs();
      notify(`已从模板创建：${fileName}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "创建失败");
    }
  };

  const saveAsTemplate = async (document?: WorkspaceMarkdownFile) => {
    if (!desktop || !workspace?.root) return notify("另存为模板需要工作区");
    const defaultName = document?.title ?? project.name;
    const name = window.prompt("模板名称：", `${defaultName} 章节结构`)?.trim();
    if (!name) return;
    try {
      const content = document && !sameDocumentPath(project.filePath, document.path)
        ? (await readTextFileSnapshot(document.path)).content
        : markdown;
      await saveTemplate(content, name, workspace.root);
      notify(`已保存模板：${name}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存模板失败");
    }
  };

  const placeWorkspaceContextMenu = (menu: WorkspaceContextMenu, x: number, y: number) => {
    const menuWidth = menu.kind === "document" ? 252 : 244;
    const menuHeight = menu.kind === "document" ? 276 : 224;
    setHeadingContextMenu(null);
    setWorkspaceContextMenu({
      ...menu,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
    });
  };

  const openWorkspaceContextMenu = (event: React.MouseEvent, menu: WorkspaceContextMenu) => {
    event.preventDefault();
    event.stopPropagation();
    placeWorkspaceContextMenu(menu, event.clientX, event.clientY);
  };

  const toggleWorkspaceActionsMenu = (anchor: HTMLElement | null) => {
    if (workspaceContextMenu?.kind === "list") {
      setWorkspaceContextMenu(null);
      return;
    }
    const bounds = anchor?.getBoundingClientRect();
    placeWorkspaceContextMenu(
      { kind: "list", x: 0, y: 0 },
      (bounds?.right ?? window.innerWidth - 8) - 244,
      (bounds?.bottom ?? 8) + 4,
    );
  };

  const chooseMarkdownForWorkspace = async () => {
    if (!desktop || !workspace?.root) return notify("请先在设置中配置工作目录");
    const path = await pickMarkdownFile("选择要加入工作区的 Markdown", workspace.root);
    if (path) await importFromDialog(path);
  };

  const reloadWorkspaceDocument = async (document: WorkspaceMarkdownFile) => {
    if (sameDocumentPath(project.filePath, document.path)) {
      await reloadCurrentMarkdown();
      return;
    }
    await openMarkdownPath(document.path);
  };

  const renameWorkspaceDocument = async (document: WorkspaceMarkdownFile) => {
    if (safety.status === "checking") return notify("正在检查磁盘文件与共享草稿，请稍候再重命名");
    if (!desktop) return notify("重命名仅在桌面端可用");
    const isCurrent = sameDocumentPath(project.filePath, document.path);
    if (isCurrent && longWritingLocked) return notify("长任务运行期间不能重命名当前文件");
    const oldName = document.path.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || document.title;
    const name = window.prompt("请输入新文件名：", oldName)?.trim();
    if (!name || name === oldName) return;
    const dir = document.path.slice(0, Math.max(document.path.lastIndexOf("\\"), document.path.lastIndexOf("/")));
    const nextPath = `${dir}${document.path.includes("\\") ? "\\" : "/"}${fileNameFromTitle(name)}`;
    try {
      await renameFile(document.path, nextPath);
      if (isCurrent) {
        safety.renameBaseline(nextPath);
        setProject(current => ({ ...current, filePath: nextPath, name, updatedAt: new Date().toISOString() }));
      }
      await refreshWorkspaceDocs();
      notify(`已重命名为：${fileNameFromTitle(name)}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "重命名失败");
    }
  };

  const deleteHeadingSection = async (headingNode: import("./features/editor/markdownDoc").HeadingNode) => {
    if (!ensureDocumentEditable()) return;
    const h = headingNode.heading;
    if (h.level <= 1) return notify("不能删除文档标题");
    if (!window.confirm(`确定删除「${h.title}」及其全部内容？`)) return;
    const next = deleteSection(markdown, h);
    setMarkdown(next);
    notify(`已删除章节：${h.title}`);
  };

  const deleteWorkspaceDoc = async (doc: WorkspaceMarkdownFile) => {
    if (!desktop) return notify("删除文件仅在桌面端可用");
    const isCurrent = sameDocumentPath(project.filePath, doc.path);
    if (isCurrent && !(await beforeDocumentChange("delete"))) return;
    try {
      await deleteFile(doc.path);
      const remainingDocuments = await refreshWorkspaceDocs();
      if (isCurrent) {
        await safety.clearHandledDrafts();
        safety.markUnsaved();
        const nextDocument = firstWorkspaceDocumentAfterDelete(remainingDocuments, doc.path);
        const opened = nextDocument ? await openMarkdownPath(nextDocument.path, true) : false;
        if (!opened) {
          const blank = createProject();
          blank.workspace = project.workspace;
          setProject(blank);
          resetHistory();
        }
      }
      setPendingDelete(null);
      notify(`已删除：${doc.title}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败");
    }
  };

  const rememberFindSelection = () => {
    pendingFindSelectionRef.current = sourceEditorRef.current?.getSelectedText() ?? "";
  };

  const openFindBar = (withReplace = false) => {
    // Read the selection synchronously. If this was triggered by a toolbar
    // click, the mousedown handler has already captured it before the editor
    // loses focus; keyboard shortcuts can read it directly here.
    const picked = pendingFindSelectionRef.current ?? sourceEditorRef.current?.getSelectedText() ?? "";
    pendingFindSelectionRef.current = null;

    if (viewMode === "preview") setViewMode("split");
    setFindOpen(true);
    if (picked) {
      // Do not truncate or reject multiline selections: the search query must
      // be exactly the text selected by the user.
      setFindQuery(picked);
      setFindIndex(-1);
    }
    if (withReplace) {
      /* keep replace field visible always when open */
    }
    // Wait for the controlled query field to receive the new value before
    // focusing/selecting it.
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  };

  const selectFindMatch = (match: FindMatch | undefined, index: number) => {
    if (!match) return;
    setFindIndex(index);
    requestAnimationFrame(() => {
      // Find ranges are offsets in the source document. Textareas normalize
      // CRLF to LF, so convert before applying the range to the editor.
      sourceEditorRef.current?.setSelection(
        textareaOffsetForSource(activeBody, match.start),
        textareaOffsetForSource(activeBody, match.end),
      );
      sourceEditorRef.current?.scrollToSelection();
    });
  };

  const goFind = (dir: 1 | -1) => {
    if (!findQuery) {
      notify("请输入查找内容");
      return;
    }
    if (!findHits.length) {
      notify("未找到匹配");
      return;
    }
    // A newly entered query has no active result yet. The first Next/Previous
    // action should land on the first/last match, not skip over one.
    const next = findIndex < 0
      ? (dir === 1 ? 0 : findHits.length - 1)
      : (findIndex + dir + findHits.length) % findHits.length;
    selectFindMatch(findHits[next], next);
  };

  const replaceCurrent = () => {
    if (!ensureDocumentEditable()) return;
    if (!findQuery) return notify("请输入查找内容");
    if (!findHits.length) return notify("未找到匹配");
    const idx = findIndex < 0 ? 0 : Math.min(findIndex, findHits.length - 1);
    const match = findHits[idx];
    const { text, nextCaret } = replaceMatch(activeBody, match, replaceQuery);
    setActiveContent(text);
    requestAnimationFrame(() => {
      const nextHits = findMatches(text, findQuery, { caseSensitive: findCaseSensitive });
      if (!nextHits.length) {
        setFindIndex(-1);
        const editorCaret = textareaOffsetForSource(text, nextCaret);
        sourceEditorRef.current?.setSelection(editorCaret, editorCaret);
        notify("已替换，无更多匹配");
        return;
      }
      const nextIdx = Math.min(idx, nextHits.length - 1);
      setFindIndex(nextIdx);
      selectFindMatch(nextHits[nextIdx], nextIdx);
      notify("已替换 1 处");
    });
  };

  const replaceAllInScope = () => {
    if (!ensureDocumentEditable()) return;
    if (!findQuery) return notify("请输入查找内容");
    const { text, count } = replaceAllMatches(activeBody, findQuery, replaceQuery, { caseSensitive: findCaseSensitive });
    if (!count) return notify("未找到匹配");
    setActiveContent(text);
    setFindIndex(0);
    notify(`已替换 ${count} 处${editorMode === "section" ? "（当前章节）" : "（全文）"}`);
  };

  const shiftHeadingTree = (headingNode: HeadingNode, direction: "promote" | "demote") => {
    setHeadingContextMenu(null);
    if (!ensureDocumentEditable()) return;
    try {
      const result = shiftHeadingSectionLevels(markdown, headingNode.heading.id, direction, project.headingNumbering);
      setMarkdown(result.markdown);
      setSelectedHeadingId(result.headingId);
      enterSectionMode();
      notify(`已${direction === "promote" ? "升级" : "降级"} ${result.changedCount} 个标题并重新编号`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "标题层级调整失败");
    }
  };

  const openHeadingMove = (headingNode: HeadingNode) => {
    const menuWidth = 440;
    const menuHeight = 460;
    setHeadingContextMenu(null);
    setHeadingMoveTarget({
      x: Math.max(8, Math.min(window.innerWidth / 2 - menuWidth / 2, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(window.innerHeight / 2 - menuHeight / 2, window.innerHeight - menuHeight - 8)),
      source: headingNode,
    });
  };

  const confirmMoveHeading = (source: HeadingNode, target: MdHeading, position: "before" | "after") => {
    setHeadingMoveTarget(null);
    if (!ensureDocumentEditable()) return;
    if (source.heading.level <= 1) return notify("不能移动文档 H1 标题");
    try {
      const moved = moveSection(markdown, source.heading, target, position);
      if (moved === markdown) {
        notify("章节已在目标位置，无需移动");
        return;
      }
      const next = renumberHeadings(moved, project.headingNumbering);
      setMarkdown(next);
      const sourceName = stripHeadingPrefix(source.heading.title);
      const movedHeading = parseMarkdownHeadings(next).find(heading =>
        heading.level === source.heading.level && stripHeadingPrefix(heading.title) === sourceName,
      );
      if (movedHeading) {
        setSelectedHeadingId(movedHeading.id);
        enterSectionMode();
      }
      notify(`已移动章节：${source.heading.title}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "移动章节失败");
    }
  };

  const showAgentDocumentSearch = ({ query, caseSensitive, scope, headingId }: AgentSearchHighlight) => {
    setFindQuery(query);
    setFindCaseSensitive(caseSensitive);
    setFindIndex(-1);
    setFindOpen(true);
    setViewMode("split");
    if (scope === "section" && headingId && headings.some(heading => heading.id === headingId)) {
      setSelectedHeadingId(headingId);
      enterSectionMode();
    } else {
      enterFullTextMode();
    }
  };

  useEffect(() => {
    if (!findOpen) return;
    if (!findHits.length) {
      setFindIndex(-1);
      return;
    }
    if (findIndex >= findHits.length) setFindIndex(-1);
  }, [findHits, findIndex, findOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // 行内格式化快捷键（仅当焦点位于编辑器文本框内，避免误触搜索框等输入控件）
    const inEditor = !!document.activeElement?.classList?.contains("md-source");
    if (mod && !e.isComposing && inEditor && viewMode !== "preview") {
      if (key === "b") { e.preventDefault(); wrapSelectionRef.current("**", "**", "粗体"); return; }
      if (key === "i") { e.preventDefault(); wrapSelectionRef.current("*", "*", "斜体"); return; }
      if (key === "e") { e.preventDefault(); wrapSelectionRef.current("`", "`", "代码"); return; }
      if (key === "s" && e.shiftKey) { e.preventDefault(); wrapSelectionRef.current("~~", "~~", "删除"); return; }
    }
    if (mod && key === "s") {
        e.preventDefault();
        void saveCurrentDocument();
        return;
      }
      if (mod && key === "z" && !e.altKey) {
        e.preventDefault();
        if (!ensureDocumentEditable()) return;
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (!ensureDocumentEditable()) return;
        redo();
        return;
      }
      if (mod && key === "f") {
        e.preventDefault();
        openFindBar(false);
      } else if (mod && key === "h") {
        e.preventDefault();
        openFindBar(true);
      } else if (e.key === "F3") {
        e.preventDefault();
        if (!findOpen) openFindBar(false);
        else goFind(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape" && findOpen) {
        e.preventDefault();
        setFindOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findHits, findIndex, findQuery, activeBody, viewMode, editorMode, project, ensureDocumentEditable, saveCurrentDocument]);

  useEffect(() => {
    if (!desktop) {
      const warnBeforeUnload = (event: BeforeUnloadEvent) => {
        if (!safety.isDirty) return;
        event.preventDefault();
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", warnBeforeUnload);
      return () => window.removeEventListener("beforeunload", warnBeforeUnload);
    }
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const appWindow = getCurrentWindow();
      unlisten = await appWindow.onCloseRequested(async event => {
        if (allowCloseRef.current) return;
        event.preventDefault();
        if (closePendingRef.current) return;
        closePendingRef.current = true;
        let forceCloseTimer: number | undefined;
        try {
          // 兜底：若守卫确认 / 保存 / 草稿写入（SQLite/文件锁竞争）长时间不返回，
          // 强制放行关窗，避免 closePendingRef 永久锁死导致窗口再也关不掉。
          const allowed = await Promise.race([
            beforeDocumentChange("close"),
            new Promise<boolean>((resolve) => {
              forceCloseTimer = window.setTimeout(() => {
                allowCloseRef.current = true;
                resolve(true);
              }, 8000);
            }),
          ]);
          if (!allowed) return;
          safety.suppressNextUnloadDraftFlush();
          allowCloseRef.current = true;
          await appWindow.close();
        } finally {
          if (forceCloseTimer) window.clearTimeout(forceCloseTimer);
          if (!allowCloseRef.current) closePendingRef.current = false;
        }
      });
      if (disposed) unlisten();
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, beforeDocumentChange, safety]);

  const updateActiveBlock = (fn: (b: DocumentBlock) => DocumentBlock) => {
    if (!ensureDocumentEditable()) return;
    const next = fn(activeBlock);
    updateProject(p => {
      const currentMarkdown = p.markdown ?? "";
      const nextMarkdown = selectedHeading && editorMode === "section"
        ? replaceSection(currentMarkdown, selectedHeading, next.content)
        : next.content;
      return {
        ...p,
        markdown: nextMarkdown,
        name: titleFromMarkdown(nextMarkdown, p.name),
        updatedAt: new Date().toISOString(),
        contextSourceRefs: next.sourceRefs,
      };
    });
  };

  const locateLongWritingChapter = (titlePath: string[]) => {
    const targetTitle = stripHeadingPrefix(titlePath.at(-1) ?? "");
    const heading = parseMarkdownHeadings(projectRef.current.markdown).find(item =>
      item.level === 2 && stripHeadingPrefix(item.title) === targetTitle,
    );
    if (!heading) {
      notify(`未能在当前文档中定位章节：${titlePath.join(" / ")}`);
      return;
    }
    setSelectedHeadingId(heading.id);
    enterSectionMode();
    setCollapsedHeadings(current => {
      const next = new Set(current);
      next.delete(heading.id);
      return next;
    });
    notify(`已定位：${heading.title}`);
  };

  const captureAgentSelection = (selection: { start: number; end: number }) => {
    if (selection.start === selection.end) {
      setAgentSelection(undefined);
      return;
    }
    const baseOffset = selectedHeading && editorMode === "section" ? selectedHeading.start : 0;
    setAgentSelection({
      start: baseOffset + selection.start,
      end: baseOffset + selection.end,
      text: activeBody.slice(selection.start, selection.end),
      scope: editorMode === "section" ? "section" : "document",
      sectionId: selectedHeading?.id,
      sectionTitle: selectedHeading?.title,
    });
  };
  const validAgentSelection = agentSelection
    && markdown.slice(agentSelection.start, agentSelection.end) === agentSelection.text
    ? agentSelection
    : undefined;

  const applyAgentEditDraft = (draft: AgentDraft) => {
    if (!ensureDocumentEditable()) return;
    const applied = applyAgentDraftToMarkdown(projectRef.current.markdown, draft);
    const nextHeadings = parseMarkdownHeadings(applied.markdown);
    const nextHeading = applied.headingId ? nextHeadings.find(item => item.id === applied.headingId) : undefined;
    projectRef.current = { ...projectRef.current, markdown: applied.markdown, name: titleFromMarkdown(applied.markdown, projectRef.current.name), updatedAt: new Date().toISOString() };
    setMarkdown(applied.markdown);
    if (nextHeading) setSelectedHeadingId(nextHeading.id);
    if (applied.selectionStart !== undefined && applied.selectionEnd !== undefined) {
      requestAnimationFrame(() => {
        const sectionOffset = editorMode === "section" && nextHeading ? nextHeading.start : 0;
        const start = Math.max(0, applied.selectionStart! - sectionOffset);
        const end = Math.max(start, applied.selectionEnd! - sectionOffset);
        sourceEditorRef.current?.setSelection(start, end);
        sourceEditorRef.current?.scrollToSelection();
      });
    }
  };

  const exportAsMarkdown = async () => {
    setExportMenu(false);
    try {
      await saveMarkdown(project, exportMarkdown(project));
      notify("已导出 Markdown");
    } catch (e: any) {
      notify(e?.message ?? "导出 Markdown 失败");
    }
  };

  const exportAsWord = async () => {
    setExportMenu(false);
    setWordExportOpen(true);
  };

  const onRightResizeStart = (e: React.MouseEvent) => {
    if (!rightOpen) return;
    e.preventDefault();
    rightDrag.current = { startX: e.clientX, startW: rightWidth };
    const max = Math.min(RIGHT_PANEL_MAX, Math.floor(window.innerWidth * 0.55));
    const onMove = (ev: MouseEvent) => {
      const drag = rightDrag.current;
      if (!drag) return;
      const next = Math.min(Math.max(drag.startW + (drag.startX - ev.clientX), RIGHT_PANEL_MIN), max);
      setRightWidth(next);
    };
    const onUp = () => {
      rightDrag.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-right");
    };
    document.body.classList.add("resizing-right");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onLeftResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    leftDrag.current = { startX: e.clientX, startW: leftWidth };
    const max = Math.min(LEFT_PANEL_MAX, Math.floor(window.innerWidth * 0.4));
    const onMove = (ev: MouseEvent) => {
      const drag = leftDrag.current;
      if (!drag) return;
      const next = Math.min(Math.max(drag.startW + (ev.clientX - drag.startX), LEFT_PANEL_MIN), max);
      setLeftWidth(next);
    };
    const onUp = () => {
      leftDrag.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-left");
    };
    document.body.classList.add("resizing-left");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const workspaceGridStyle = rightOpen
    ? { gridTemplateColumns: `${leftWidth}px 5px 1fr 5px ${rightWidth}px`, gridTemplateRows: "minmax(0, 1fr)" }
    : { gridTemplateColumns: `${leftWidth}px 5px 1fr 36px`, gridTemplateRows: "minmax(0, 1fr)" };

  // 桌面端必须配置工作目录后才能进入：初始化未完成时先等待；确认无目录则引导设置。
  const root = project.workspace?.root ?? "";
  const needsWorkspaceSetup = desktop && workspaceReady && !root.trim();
  const handleWorkspaceSetup = useCallback(async (setupRoot: string) => {
    await applyWorkspace(
      { root: setupRoot, historyDir: defaultWorkspaceFromRoot(setupRoot).historyDir },
      { loadConnections: true },
    );
  }, [applyWorkspace]);

  if (desktop && !workspaceReady) {
    return (
      <div className="workspace-setup-gate">
        <div className="workspace-setup-card">
          <div className="workspace-setup-icon spinning"><FolderOpen size={28} /></div>
          <p className="muted">正在初始化工作区…</p>
        </div>
      </div>
    );
  }
  if (needsWorkspaceSetup) {
    return <WorkspaceSetupGate onSetup={handleWorkspaceSetup} notify={notify} />;
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark"><img src={appIcon} alt="" /><span>TechProposal Studio</span></div>
      <div className="project-identity">
        <input disabled={longWritingLocked || safety.status === "checking"} className={safety.isDirty ? "document-name-dirty" : ""} value={project.name} onChange={e => updateProject(p => ({ ...p, name: e.target.value }), false)} />
        <div className="document-status-row">
          <span className={`document-status status-${safety.status}`}>{safety.status === "checking"
            ? "检查磁盘与草稿中…"
            : safety.status === "conflict"
              ? `⚠ 磁盘已在外部修改${project.filePath ? ` · ${project.filePath}` : ""}${safety.otherDraftCount ? ` · 另有 ${safety.otherDraftCount} 份草稿` : ""}`
              : safety.status === "recovered"
                ? `已恢复草稿 · 尚未写入磁盘${safety.otherDraftCount ? ` · 另有 ${safety.otherDraftCount} 份草稿` : ""}`
                : safety.status === "saved"
                  ? `已保存 · ${project.filePath ?? "浏览器缓存"}`
                  : `● 未保存 · ${project.filePath ?? "尚未关联磁盘文件"}`}</span>
          {project.filePath && (
            <button
              type="button"
              className="copy-path-btn"
              title="复制文件路径"
              onClick={() => void navigator.clipboard.writeText(project.filePath!).then(() => notify("已复制文件路径")).catch(() => notify("复制失败"))}
            ><Copy size={11} /></button>
          )}
        </div>
      </div>
      <div className="top-actions">
        <button className="text-button" disabled={!desktop} title={desktop ? "管理知识文档与索引" : "知识管理仅在桌面端可用"} onClick={() => setKnowledgeManagerOpen(true)}><BookOpen size={16} />知识管理</button>
        <button className="text-button" title="联网搜索" onClick={() => setWebSearchOpen(true)}><Globe2 size={16} />联网搜索</button>
        <button disabled={longWritingLocked || safety.status === "checking"} title={longWritingLocked ? "长任务占有当前文档写锁" : "保存当前 Markdown"} className={`text-button save-action ${safety.isDirty ? "dirty" : ""}`} onClick={() => void saveCurrentDocument()}><Save size={16} />保存</button>
        <div className="export-menu" ref={exportMenuRef}>
          <button className="text-button" onClick={() => setExportMenu(v => !v)}>
            <Download size={16} />导出<ChevronDown size={14} />
          </button>
          {exportMenu && <div className="export-dropdown">
            <button onClick={() => void exportAsMarkdown()}>导出 Markdown (.md)</button>
            <button onClick={() => void exportAsWord()}>导出 Word (.docx)</button>
          </div>}
        </div>
        <IconButton
          title={rightOpen ? "收起右侧面板" : "打开右侧面板"}
          active={rightOpen}
          onClick={() => {
            if (rightOpen && longWritingLocked) {
              notify("长任务运行期间请保持右侧面板打开");
              return;
            }
            setRightOpen(value => !value);
          }}
        >
          {rightOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </IconButton>
        <IconButton
          title={"当前：" + (theme === "gouan" ? "构案" : theme === "light" ? "浅色" : "深色") + "；切换到" + (theme === "gouan" ? "浅色" : theme === "light" ? "深色" : "构案") + "主题"}
          onClick={() => setTheme(cycleTheme(theme))}
        >
          {theme === "gouan" ? <Palette size={18} /> : theme === "light" ? <Sun size={18} /> : <Moon size={18} />}
        </IconButton>
        <IconButton title="设置" onClick={() => setSettingsOpen(true)}><Settings size={18} /></IconButton>
      </div>
    </header>
    <div
      className={`workspace ${rightOpen ? "with-right" : "right-collapsed"}`}
      style={workspaceGridStyle}
    >
      <aside className="left-panel">
        <div className="panel-heading">
          <span>{leftView === "outline" ? "目录" : "源代码管理"}</span>
          <div />
        </div>
        <div className="left-view-tabs" aria-label="左侧面板视图">
          <button className={leftView === "outline" ? "active" : ""} type="button" onClick={() => setLeftView("outline")} title="文档目录"><FileText size={14} /><span>目录</span></button>
          <button className={leftView === "git" ? "active" : ""} type="button" onClick={() => setLeftView("git")} title="Git 源代码管理"><GitBranch size={14} /><span>Git</span></button>
        </div>
        {leftView === "outline" ? <>
        <div className="toc-mode">
          <button className={editorMode === "section" ? "active" : ""} onClick={enterSectionMode}>按章节</button>
          <button
            className={`${editorMode === "full" ? "active" : ""}${fullTextLocked ? " locked" : ""}`}
            onClick={() => {
              if (editorMode === "full") setFullTextLocked(v => !v);
              else enterFullTextMode();
            }}
            title={fullTextLocked ? "全文已锁定：点击章节标题仅定位，不切换回按章节模式" : "全文（再次点击锁定全文模式，点击章节仅定位）"}
          >
            全文{fullTextLocked && <Lock size={11} className="toc-lock-icon" aria-label="已锁定" />}
          </button>
        </div>
        <div className="toc-actions">
          <div className="toc-actions-row">
            <span className="toc-actions-label-sep">显示级别</span>
            <span className="toc-action-btn-group">
              {[1, 2, 3, 4].map(l => <button key={`e${l}`} className="toc-action-btn" onClick={() => expandToLevel(l)}>{l}级</button>)}
              <button type="button" className="toc-action-btn" onClick={expandAll}>全部</button>
            </span>
          </div>
        </div>
        <nav className="toc-list">
          {headings.length === 0 && <p className="muted toc-empty">正文中尚无 Markdown 标题（# / ##）</p>}
          {renderHeadingNodes(headingTree)}
        </nav>
        {desktop && (
          <div className="workspace-docs">
            <div className="panel-heading compact">
              <button type="button" className="panel-toggle" onClick={() => setWorkspaceDocsCollapsed(v => !v)}>
                {workspaceDocsCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span>工作区文档</span>
              </button>
              <div className="panel-heading-actions">
                <IconButton
                  title="新建空白 Markdown 文件"
                  disabled={!workspace?.root || longWritingLocked || safety.status === "checking"}
                  onClick={() => void createNewFile()}
                >
                  <FilePlus2 size={14} />
                </IconButton>
                <div ref={workspaceActionsMenuRef} onPointerDown={event => event.stopPropagation()}>
                  <IconButton
                    title="工作区文档更多操作"
                    active={workspaceContextMenu?.kind === "list"}
                    onClick={() => toggleWorkspaceActionsMenu(workspaceActionsMenuRef.current)}
                  >
                    <MoreHorizontal size={14} />
                  </IconButton>
                </div>
              </div>
            </div>
            {!workspaceDocsCollapsed && <div className="workspace-docs-list">
              {!workspaceDocs.length && <p className="muted toc-empty">根目录下暂无 .md（可使用标题右侧的更多操作导入或从模板新建）</p>}
              {workspaceDocs.map(doc => {
                const isCurrentDocument = sameDocumentPath(project.filePath, doc.path);
                return <div
                  className={`workspace-doc-row ${isCurrentDocument ? "selected" : ""}`}
                  key={doc.path}
                  onContextMenu={event => openWorkspaceContextMenu(event, { kind: "document", x: 0, y: 0, doc })}
                >
                  <button
                    type="button"
                    className="workspace-doc-item"
                    title={`${doc.path}（右键打开文件操作）`}
                    onClick={() => void openMarkdownPath(doc.path)}
                  >
                    <b>{doc.title}</b>
                    <span>{doc.path.split(/[\/]/).pop()}</span>
                  </button>
                  {pendingDelete === doc.path && <div className="workspace-doc-confirm-delete">
                    <button type="button" className="workspace-doc-confirm-yes" onClick={() => { confirmDeleteRef.current += 1; void deleteWorkspaceDoc(doc); }}>确认</button>
                    <button type="button" className="workspace-doc-confirm-no" onClick={() => setPendingDelete(null)}>取消</button>
                  </div>}
                  {knowledgeTransferPath === doc.path && <span className="workspace-doc-status"><RefreshCw className="spinning" size={13} />转入中…</span>}
                </div>;
              })}
            </div>}
          </div>
        )}
        </> : <GitSidebar
          root={workspace?.root ?? ""}
          project={project}
          selected={gitDiff}
          onSelect={selection => { setGitDiff(selection); setGitDiffActive(Boolean(selection)); }}
          notify={notify}
        />}
      </aside>
      <div className="left-splitter" onMouseDown={onLeftResizeStart} title="拖动调整左侧面板宽度" />
      <main className={`editor-area ${longWritingLocked ? "long-task-locked" : ""}`}>
        {longWritingLocked && <div className="long-task-lock-banner">长任务正在按章节安全写入。正文编辑、手动保存、标题操作、文件切换、重命名和删除已锁定；仍可预览已完成章节。</div>}
        <div className="editor-title">
          <div>
            <span>{gitDiffActive && gitDiff ? (gitDiff.kind === "commit" ? "提交历史" : gitDiff.staged ? "暂存区差异" : "工作区差异") : editorMode === "full" ? "全文" : selectedHeading ? `H${selectedHeading.level}` : "正文"}</span>
            <input
              value={gitDiffActive && gitDiff ? (gitDiff.kind === "commit" ? gitDiff.title : gitDiff.path) : editorMode === "full" ? project.name : (selectedHeading?.title ?? project.name)}
              readOnly={longWritingLocked || safety.status === "checking" || gitDiffActive || editorMode === "section"}
              onChange={e => !longWritingLocked && safety.status !== "checking" && editorMode === "full" && updateProject(p => ({ ...p, name: e.target.value }), false)}
            />
          </div>
          <div className="editor-title-actions">
            {!gitDiffActive && <span className="editor-word-count" aria-live="polite">{editorMode === "full" ? "全文" : "本章"} {activeWordCount.toLocaleString()} 字</span>}
            {!gitDiffActive && <button
              type="button"
              className="editor-toggle"
              title={editorMode === "section" ? "复制当前章节全文" : "复制全文 Markdown"}
              onClick={() => void navigator.clipboard.writeText(activeBody).then(() => notify(`已复制${editorMode === "section" ? "当前章节" : "全文"}内容`)).catch(() => notify("复制失败"))}
            ><Copy size={13} />复制</button>}
            {!gitDiffActive && <button
              type="button"
              className={`editor-toggle${previewIndent ? " active" : ""}`}
              title={previewIndent ? "已启用段落首行缩进（点击关闭）" : "已关闭段落首行缩进（点击启用）"}
              onClick={() => setPreviewIndent(v => !v)}
            >
              <IndentIncrease size={13} />
              首行
            </button>}
            {!gitDiffActive && <button
              type="button"
              className={`editor-toggle${syncScroll ? " active" : ""}`}
              title={syncScroll ? "已启用编辑与预览同步滚动（点击关闭，分栏模式生效）" : "已关闭同步滚动（点击启用，分栏模式生效）"}
              onClick={() => setSyncScroll(v => !v)}
            >
              <MoveVertical size={13} />
              滚动
            </button>}
            {!gitDiffActive && <div className="font-scale-control" title="调整编辑与预览区域的字体大小">
              <button type="button" className="heading-level-btn" aria-label="缩小字体" onClick={() => setEditorFontScale(s => Math.max(EDITOR_FONT_SCALE_MIN, Math.round((s - EDITOR_FONT_SCALE_STEP) * 100) / 100))}>
                <Minus size={13} />
              </button>
              <button type="button" className="font-scale-value" title="点击恢复 100%" onClick={() => setEditorFontScale(1)}>
                {Math.round(editorFontScale * 100)}%
              </button>
              <button type="button" className="heading-level-btn" aria-label="放大字体" onClick={() => setEditorFontScale(s => Math.min(EDITOR_FONT_SCALE_MAX, Math.round((s + EDITOR_FONT_SCALE_STEP) * 100) / 100))}>
                <Plus size={13} />
              </button>
            </div>}
            <div className="view-toggle">
              <button className={!gitDiffActive && viewMode === "edit" ? "active" : ""} onClick={() => { setGitDiffActive(false); setViewMode("edit"); }}>源码</button>
              <button className={!gitDiffActive && viewMode === "split" ? "active" : ""} onClick={() => { setGitDiffActive(false); setViewMode("split"); }}>分栏</button>
              <button className={!gitDiffActive && viewMode === "preview" ? "active" : ""} onClick={() => { setGitDiffActive(false); setViewMode("preview"); }}>预览</button>
              {gitDiff && <button className={gitDiffActive ? "active" : ""} type="button" title="返回最近查看的 Git 差异" onClick={() => setGitDiffActive(true)}><GitCompare size={13} />Diff</button>}
            </div>
          </div>
        </div>
        {!gitDiffActive && <div
          className="heading-toolbar"
          title="按选定方案重新生成全文标题编号，不改变 H1–H6 层级"
          onMouseDown={event => {
            if (!(event.target instanceof Element) || !event.target.closest("button:not(:disabled)")) return;
            event.preventDefault();
            sourceEditorRef.current?.focus();
          }}
        >
          <div className="heading-toolbar-row">
            <label className="heading-style-select" title="选择 Markdown 与 Word 共用的标题编号方案；切换后点击“设置标题”才会重写 Markdown">
              <span>编号</span>
              <select
                value={project.headingNumbering.schemeId}
                onChange={event => setProject(current => ({
                  ...current,
                  headingNumbering: { ...current.headingNumbering, schemeId: event.target.value },
                  updatedAt: new Date().toISOString(),
                }))}
              >
                <option value="none">无编号</option>
                {HEADING_NUMBERING_SCHEMES.map(scheme => (
                  <option key={scheme.id} value={scheme.id}>{scheme.label} — {scheme.description}</option>
                ))}
              </select>
            </label>
            <label className="heading-style-select" title="只控制从哪个 Markdown 标题级别开始编号，不改变现有 H1–H6 层级">
              <span>起始</span>
              <select
                value={String(project.headingNumbering.startLevel)}
                disabled={project.headingNumbering.schemeId === "none"}
                onChange={event => setProject(current => ({
                  ...current,
                  headingNumbering: { ...current.headingNumbering, startLevel: Number(event.target.value) },
                  updatedAt: new Date().toISOString(),
                }))}
              >
                {[1, 2, 3, 4, 5, 6].map(level => (
                  <option key={level} value={String(level)}>H{level}</option>
                ))}
              </select>
            </label>
            <button type="button" className="heading-renumber-btn" onClick={renumberAllHeadings}>设置标题</button>
          </div>
          <div className="heading-toolbar-row">
            <div className="toolbar-history">
              <IconButton title="撤销 (Ctrl+Z)" disabled={longWritingLocked || safety.status === "checking"} onClick={undo}><Undo2 size={16} /></IconButton>
              <IconButton title="重做 (Ctrl+Y / Ctrl+Shift+Z)" disabled={longWritingLocked || safety.status === "checking"} onClick={redo}><Redo2 size={16} /></IconButton>
            </div>
            <span className="format-divider" />
            <button type="button" className="format-btn" disabled={formatDisabled} onClick={() => wrapSelection("**", "**", "粗体")} title={formatTitle("加粗", "Ctrl+B")}><Bold size={14} /></button>
            <button type="button" className="format-btn" disabled={formatDisabled} onClick={() => wrapSelection("*", "*", "斜体")} title={formatTitle("斜体", "Ctrl+I")}><Italic size={14} /></button>
            <button type="button" className="format-btn" disabled={formatDisabled} onClick={() => wrapSelection("~~", "~~", "删除")} title={formatTitle("删除线", "Ctrl+Shift+S")}><Strikethrough size={14} /></button>
            <button type="button" className="format-btn" disabled={formatDisabled} onClick={() => wrapSelection("`", "`", "代码")} title={formatTitle("行内代码", "Ctrl+E")}><Code2 size={14} /></button>
            <button type="button" className="format-btn" disabled={formatDisabled} onClick={() => wrapSelection("==", "==", "高亮")} title={formatTitle("标黄高亮")}><Highlighter size={14} /></button>
            <span className="heading-toolbar-spacer" />
            <button type="button" className="heading-renumber-btn" onMouseDown={e => { if (e.button === 0) rememberFindSelection(); }} onClick={() => openFindBar(false)} title="查找 (Ctrl+F)">
              <Search size={14} /> 查找
            </button>
            <button type="button" className="heading-renumber-btn" onMouseDown={e => { if (e.button === 0) rememberFindSelection(); }} onClick={() => openFindBar(true)} title="替换 (Ctrl+H)">
              <Replace size={14} /> 替换
            </button>
          </div>
        </div>}
        {!gitDiffActive && findOpen && (
          <div className="find-replace-bar">
            <div className="find-replace-row">
              <label>
                <span>查找</span>
                <textarea
                  ref={findInputRef}
                  value={findQuery}
                  rows={1}
                  onChange={e => { setFindQuery(e.target.value); setFindIndex(-1); }}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      goFind(1);
                    }
                  }}
                  placeholder="输入要查找的文本"
                />
              </label>
              <span className="find-count">{findQuery ? (findHits.length ? (findIndex >= 0 ? `${findIndex + 1}/${findHits.length}` : `0/${findHits.length}`) : "0/0") : "—"}</span>
              <button type="button" className="heading-level-btn" onClick={() => goFind(-1)} title="上一个 (Shift+F3)"><ChevronUp size={14} /></button>
              <button type="button" className="heading-level-btn" onClick={() => goFind(1)} title="下一个 (F3)"><ChevronDown size={14} /></button>
              <label className="find-option">
                <input type="checkbox" checked={findCaseSensitive} onChange={e => { setFindCaseSensitive(e.target.checked); setFindIndex(-1); }} />
                区分大小写
              </label>
              <IconButton title="关闭 (Esc)" onClick={() => setFindOpen(false)}><X size={16} /></IconButton>
            </div>
            <div className="find-replace-row">
              <label>
                <span>替换</span>
                <input
                  value={replaceQuery}
                  onChange={e => setReplaceQuery(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      replaceCurrent();
                    }
                  }}
                  placeholder="替换为"
                />
              </label>
              <button type="button" className="heading-renumber-btn" onClick={replaceCurrent}>替换</button>
              <button type="button" className="heading-renumber-btn" onClick={replaceAllInScope}>
                全部替换{editorMode === "section" ? "（本章）" : "（全文）"}
              </button>
            </div>
          </div>
        )}
        {gitDiffActive && gitDiff ? <GitDiffView root={workspace?.root ?? ""} selection={gitDiff} /> : <div className={`md-workspace mode-${viewMode}`} style={{ "--md-font-scale": editorFontScale, "--md-preview-indent": previewIndent ? "2em" : "0" } as React.CSSProperties}>
          {(viewMode === "edit" || viewMode === "split") && (
            <div className="md-pane source-pane">
              <MarkdownSourceEditor
                ref={sourceEditorRef}
                value={activeBody}
                onChange={setActiveContent}
                workspaceRoot={workspace?.root}
                filePath={project.filePath}
                onSelectionChange={captureAgentSelection}
                placeholder={editorMode === "full" ? "编辑完整 Markdown…" : "编辑当前章节 Markdown… 支持 Ctrl+V 粘贴图片"}
                highlights={findOpen ? findHits : []}
                activeHighlight={findIndex}
                readOnly={longWritingLocked || safety.status === "checking"}
                scrollElementRef={sourceScrollRef}
              />
            </div>
          )}
          {(viewMode === "preview" || viewMode === "split") && (
            <div className="md-pane preview-pane" ref={previewPaneRef}>
              <MarkdownPreview
                markdown={activeBody}
                filePath={project.filePath}
                workspaceRoot={workspace?.root}
                searchQuery={findOpen ? findQuery : ""}
                searchCaseSensitive={findCaseSensitive}
              />
            </div>
          )}
        </div>}
      </main>
      {rightOpen ? <>
        <div className="right-splitter" onMouseDown={onRightResizeStart} title="拖动调整右侧面板宽度" />
        <InspectorPanel
          tab={rightTab}
          setTab={setRightTab}
          project={project}
          block={activeBlock}
          updateProject={updateProject}
          updateBlock={updateActiveBlock}
          agentSelection={validAgentSelection}
          clearAgentSelection={() => setAgentSelection(undefined)}
          applyAgentDraft={applyAgentEditDraft}
          agentWorkspaceRuntime={agentWorkspaceRuntime}
          onAgentDocumentSearch={showAgentDocumentSearch}
          notify={notify}
          openSourcePreview={sourcePreview.open}
          longWritingBaselineHash={safety.baseline?.sha256 ?? null}
          saveBeforeLongWriting={(content) => saveWorkspaceContent(content ?? exportMarkdown(projectRef.current), projectRef.current.filePath)}
          onLongWritingSnapshot={applyLongWritingSnapshot}
          onLongWritingLockChange={setLongWritingLocked}
          onLocateLongWritingChapter={locateLongWritingChapter}
        />
      </> : (
        <button className="right-rail" title="打开右侧面板" onClick={() => setRightOpen(true)}>
          <PanelRightOpen size={16} />
          <span>侧栏</span>
        </button>
      )}
    </div>
    {headingContextMenu && <div
      className="toc-context-menu"
      role="menu"
      aria-label={`章节操作：${headingContextMenu.node.heading.title}`}
      style={{ left: headingContextMenu.x, top: headingContextMenu.y }}
      onPointerDown={event => event.stopPropagation()}
    >
      <div className="toc-context-menu-title" title={headingContextMenu.node.heading.title}>
        {headingContextMenu.node.heading.title}
      </div>
      <button type="button" role="menuitem" disabled={headingContextMenu.node.heading.level === 1} onClick={() => insertHeadingSection(headingContextMenu.node, "before")}><Plus size={14} />在前插入同级章节</button>
      <button type="button" role="menuitem" disabled={headingContextMenu.node.heading.level === 1} onClick={() => insertHeadingSection(headingContextMenu.node, "after")}><Plus size={14} />在后插入同级章节</button>
      <button type="button" role="menuitem" disabled={headingContextMenu.node.heading.level >= 6} onClick={() => insertHeadingSection(headingContextMenu.node, "child")}><Plus size={14} />插入子章节</button>
      <div className="toc-context-menu-separator" />
      <button type="button" role="menuitem" disabled={headingContextMenu.node.heading.level === 1} onClick={() => shiftHeadingTree(headingContextMenu.node, "promote")}><IndentDecrease size={14} />升级标题</button>
      <button type="button" role="menuitem" disabled={headingTreeHasH6(headingContextMenu.node)} onClick={() => shiftHeadingTree(headingContextMenu.node, "demote")}><IndentIncrease size={14} />降级标题</button>
      <div className="toc-context-menu-separator" />
      <button type="button" role="menuitem" disabled={headingContextMenu.node.heading.level === 1} onClick={() => openHeadingMove(headingContextMenu.node)}><MoveVertical size={14} />移动到…</button>
      <div className="toc-context-menu-separator" />
      <button type="button" role="menuitem" className="danger" disabled={headingContextMenu.node.heading.level === 1} onClick={() => void deleteHeadingSection(headingContextMenu.node)}><Trash2 size={14} />删除章节</button>
    </div>}
    {headingMoveTarget && (() => {
      const source = headingMoveTarget.source.heading;
      const destinations = headings.filter(target =>
        target.id !== source.id
        && !(target.start > source.start && target.start < source.end),
      );
      return <div
        className="toc-move-overlay"
        onPointerDown={event => event.stopPropagation()}
        onMouseDown={event => event.stopPropagation()}
        onClick={() => setHeadingMoveTarget(null)}
      >
        <div className="toc-move-panel" role="dialog" aria-label="移动到指定标题" onClick={event => event.stopPropagation()}>
          <div className="toc-move-head">
            <span className="toc-move-title">移动「{headingMoveTarget.source.heading.title}」到指定位置</span>
            <button type="button" className="toc-move-close" onClick={() => setHeadingMoveTarget(null)}><X size={15} /></button>
          </div>
          <div className="toc-move-recipient">
            {destinations.length === 0
              ? <p className="muted toc-move-empty">文中没有其他可作为目标位置的标题</p>
              : destinations.map(target => {
                const beforeNoop = target.start === source.end;
                const afterNoop = target.end === source.start;
                return (
                  <div className="toc-move-row" key={target.id}>
                    <span className={`toc-move-name level-${target.level}`} title={target.title}>
                      <span className="toc-move-level">H{target.level}</span>
                      <InlineMarkdown className="toc-move-label" children={target.title} />
                    </span>
                    <span className="toc-move-actions">
                      <button type="button" disabled={beforeNoop} onClick={() => confirmMoveHeading(headingMoveTarget.source, target, "before")} title={`移动到「${target.title}」之前`}>之前</button>
                      <button type="button" disabled={afterNoop} onClick={() => confirmMoveHeading(headingMoveTarget.source, target, "after")} title={`移动到「${target.title}」之后`}>之后</button>
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      </div>;
    })()}
    {workspaceContextMenu && <div
      className="toc-context-menu workspace-doc-context-menu"
      role="menu"
      aria-label={workspaceContextMenu.kind === "list" ? "工作区文档操作" : `文档操作：${workspaceContextMenu.doc.title}`}
      style={{ left: workspaceContextMenu.x, top: workspaceContextMenu.y }}
      onPointerDown={event => event.stopPropagation()}
    >
      {workspaceContextMenu.kind === "list" ? <>
        <div className="toc-context-menu-title">工作区文档</div>
        <button
          type="button"
          role="menuitem"
          disabled={!workspace?.root || longWritingLocked || safety.status === "checking"}
          onClick={() => { setWorkspaceContextMenu(null); void openTemplatePicker(); }}
        ><FilePlus2 size={14} />从模板新建</button>
        <button
          type="button"
          role="menuitem"
          disabled={!workspace?.root || longWritingLocked || safety.status === "checking"}
          onClick={() => { setWorkspaceContextMenu(null); void chooseMarkdownForWorkspace(); }}
        ><Download size={14} />选择 Markdown 并加入工作区…</button>
        <button
          type="button"
          role="menuitem"
          disabled={!workspace?.root || importingDoc || longWritingLocked || safety.status === "checking"}
          onClick={() => { setWorkspaceContextMenu(null); setWorkspaceImportKind("document"); }}
        ><FilePlus2 size={14} />{importingDoc ? "正在导入 Word / PDF…" : "导入 Word / PDF…"}</button>
        <div className="toc-context-menu-separator" />
        <button type="button" role="menuitem" disabled={!workspace?.root} onClick={() => { setWorkspaceContextMenu(null); void refreshWorkspaceDocs(); }}><RefreshCw size={14} />刷新文件列表</button>
        <button
          type="button"
          role="menuitem"
          disabled={!workspace?.root}
          onClick={() => {
            setWorkspaceContextMenu(null);
            if (workspace?.root) void openWorkspaceDirectory(workspace.root).catch(error => notify(String(error)));
          }}
        ><FolderOpen size={14} />在资源管理器中打开工作区</button>
      </> : <>
        <div className="toc-context-menu-title" title={workspaceContextMenu.doc.path}>{workspaceContextMenu.doc.title}</div>
        <button
          type="button"
          role="menuitem"
          disabled={longWritingLocked || safety.status === "checking"}
          onClick={() => { const document = workspaceContextMenu.doc; setWorkspaceContextMenu(null); void openMarkdownPath(document.path); }}
        ><FileText size={14} />打开</button>
        <button
          type="button"
          role="menuitem"
          disabled={longWritingLocked || safety.status === "checking"}
          onClick={() => { const document = workspaceContextMenu.doc; setWorkspaceContextMenu(null); void reloadWorkspaceDocument(document); }}
        ><RefreshCw size={14} />重新加载</button>
        <div className="toc-context-menu-separator" />
        <button
          type="button"
          role="menuitem"
          disabled={safety.status === "checking" || (longWritingLocked && sameDocumentPath(project.filePath, workspaceContextMenu.doc.path))}
          onClick={() => { const document = workspaceContextMenu.doc; setWorkspaceContextMenu(null); void renameWorkspaceDocument(document); }}
        ><Pencil size={14} />重命名</button>
        <button
          type="button"
          role="menuitem"
          disabled={!workspace?.root}
          onClick={() => { const document = workspaceContextMenu.doc; setWorkspaceContextMenu(null); void saveAsTemplate(document); }}
        ><FileText size={14} />另存为模板</button>
        <button
          type="button"
          role="menuitem"
          disabled={knowledgeTransferPath !== null}
          onClick={() => { const document = workspaceContextMenu.doc; setWorkspaceContextMenu(null); void transferWorkspaceDocToKnowledge(document); }}
        >{knowledgeTransferPath === workspaceContextMenu.doc.path ? <RefreshCw className="spinning" size={14} /> : <BookOpen size={14} />}{knowledgeTransferPath === workspaceContextMenu.doc.path ? "转入知识库中…" : "转入知识库"}</button>
        <div className="toc-context-menu-separator" />
        <button
          type="button"
          role="menuitem"
          className="danger"
          disabled={sameDocumentPath(project.filePath, workspaceContextMenu.doc.path) && (longWritingLocked || safety.status === "checking")}
          onClick={() => { const document = workspaceContextMenu.doc; setWorkspaceContextMenu(null); setPendingDelete(document.path); }}
        ><Trash2 size={14} />删除文件</button>
      </>}
    </div>}
    {sourcePreview.source && <SourcePreviewModal
      source={sourcePreview.source}
      markdown={sourcePreview.markdown}
      loading={sourcePreview.loading}
      error={sourcePreview.error}
      workspaceRoot={project.workspace?.root}
      notify={notify}
      close={sourcePreview.close}
    />}
    {wordExportOpen && <WordExportModal project={project} close={() => setWordExportOpen(false)} notify={notify} />}
    {settingsOpen && <SettingsModal
      project={project}
      close={() => setSettingsOpen(false)}
      openEnvironmentCheck={() => setEnvOpen(true)}
      save={async (next, context) => {
        try {
          const nextRoot = next.workspace?.root;
          const switchingWorkspace = !sameWorkspaceRoot(project.workspace?.root, nextRoot);
          if (switchingWorkspace && !nextRoot?.trim()) {
            notify("请先设置工作目录，否则模型密钥等连接配置不会被保存");
            return;
          }
          if (switchingWorkspace && !(await beforeDocumentChange("workspace"))) return;
          let projectToSave = switchingWorkspace
            ? { ...next, id: makeId(), name: "未命名文档", markdown: defaultProposalMarkdown("未命名文档"), filePath: undefined, contextSourceRefs: [], updatedAt: new Date().toISOString() }
            : next;
          if (nextRoot && switchingWorkspace
            && !sameWorkspaceRoot(context?.connectionsLoadedRoot, nextRoot)) {
            const connections = await loadWorkspaceConnections(nextRoot);
            projectToSave = applyConnections(projectToSave, connections);
          }
          let workspacePaths = projectToSave.workspace;
          if (projectToSave.workspace?.root) {
            workspacePaths = await applyWorkspace(projectToSave.workspace, { loadConnections: false });
          }
          const root = workspacePaths?.root || projectToSave.workspace?.root;
          const saved = await saveProjectConnections({
            ...projectToSave,
            agent: normalizeAgentSettings(projectToSave.agent),
            workspace: workspacePaths ?? projectToSave.workspace,
          }, root);
          saveProject(saved);
          if (switchingWorkspace) safety.markUnsaved();
          setProject(saved);
          setSettingsOpen(false);
          notify(root ? "设置已保存到工作区" : "设置已保存（浏览器本地）");
        } catch (e: any) {
          notify(e?.message ?? "保存设置失败");
        }
      }}
    />}
    {knowledgeManagerOpen && <KnowledgeManagerModal
      project={project}
      updateProject={updateProject}
      updateBlock={updateActiveBlock}
      refreshWorkspaceDocs={refreshWorkspaceDocs}
      openMarkdownPath={openMarkdownPath}
      notify={notify}
      close={() => setKnowledgeManagerOpen(false)}
    />}
    {webSearchOpen && <WebSearchModal
      project={project}
      notify={notify}
      close={() => setWebSearchOpen(false)}
    />}
    {workspaceImportKind && <FileUploadPanel
      title="导入 Word / PDF 到工作区"
      description="拖入 Word / PDF，或选择文件路径。构案将通过 MinerU 转换为 Markdown，并把图片写入工作区 assets；原始文件会一并复制到工作区 imports 目录保留。"
      extensions={DOCUMENT_UPLOAD_EXTENSIONS}
      extensionLabel="Word / PDF（.doc / .docx / .pdf）"
      destination={workspace?.root}
      busy={importingDoc}
      submitLabel="解析并导入"
      choosePath={() => pickDocumentFile("选择要导入的 Word / PDF", workspace?.root)}
      upload={async path => {
        const succeeded = await importWordPdfFromDialog(path);
        if (succeeded) setWorkspaceImportKind(null);
        return succeeded;
      }}
      close={() => setWorkspaceImportKind(null)}
    />}
    {templatePickerOpen && <div className="modal-backdrop" onClick={() => setTemplatePickerOpen(false)}>
      <div className="modal wide template-picker-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title"><div><FileText size={18} /><span>从模板新建</span></div><IconButton title="关闭" onClick={() => setTemplatePickerOpen(false)}><X size={18} /></IconButton></div>
        <div className="template-picker-body">
          {[defaultTemplateMeta(), ...templates].map(t => (
            <button type="button" key={t.id} className="template-picker-item" onClick={() => void createFromTemplate(t.id)}>
              <span><b>{t.name}</b><em>{t.chapterCount} 章</em></span>
            </button>
          ))}
          {!templates.length && <p className="muted">暂无自定义模板。打开方案后可通过文件菜单另存为模板。</p>}
        </div>
      </div>
    </div>}
    {sourceOpen && <SourceImportModal
      historyDir={workspace?.historyDir || ""}
      close={() => setSourceOpen(false)}
      add={async (source, content) => {
        try {
          if (desktop && workspace?.historyDir && content != null) {
            const file = await writeLibraryMarkdown(workspace.historyDir, source.title, content);
            const files = await listLibraryFiles(workspace.historyDir);
            updateProject(p => mergeLibrarySources(p, [...files, file]));
            notify("资料已写入知识库目录并加载");
          } else {
            updateProject(p => ({ ...p, sources: [...p.sources, source] }));
            notify("资料已加入项目");
          }
          setSourceOpen(false);
        } catch (e: any) {
          notify(e?.message ?? "导入失败");
          throw e;
        }
      }}
    />}
    {envOpen && <EnvironmentModal
      project={project}
      controller={environmentTools}
      close={() => setEnvOpen(false)}
    />}
    {guardRequest && <UnsavedChangesModal reason={guardRequest.reason} choose={choice => {
      const resolve = guardRequest.resolve;
      setGuardRequest(null);
      resolve(choice);
    }} />}
    {conflictRequest && <DiskConflictModal choose={choice => {
      const resolve = conflictRequest.resolve;
      setConflictRequest(null);
      resolve(choice);
    }} />}
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </div>;
}
function SettingsModal({ project, close, openEnvironmentCheck, save }: {
  project: Project;
  close: () => void;
  openEnvironmentCheck: () => void;
  save: (p: Project, context?: { connectionsLoadedRoot?: string }) => void | Promise<void>;
}) {
  const [section, setSection] = useState<"model" | "search" | "agent" | "tools" | "skills" | "history" | "memory" | "parser" | "wordExport" | "workspace" | "about">("model");
  const [draft, setDraft] = useState(() => {
    const next = structuredClone(project);
    if (!next.mineru) next.mineru = createProject().mineru;
    if (!next.wordExport) next.wordExport = createProject().wordExport;
    next.agent = normalizeAgentSettings(next.agent);
    return next;
  });
  const [connectionsLoadedRoot, setConnectionsLoadedRoot] = useState(project.workspace?.root ?? "");
  const [workspaceLoadMessage, setWorkspaceLoadMessage] = useState("");
  const desktop = isDesktop();
  const workspace = draft.workspace ?? { root: "", historyDir: "" };
  const sectionDetails = {
    model: { title: "模型服务", description: "配置模型接口、访问凭据和默认模型。", icon: <Globe2 size={15} /> },
    search: { title: "联网搜索", description: "配置搜索提供方、接口地址和上游搜索引擎。", icon: <Search size={15} /> },
    agent: { title: "Agent", description: "控制多轮执行、上下文、记忆与工具使用策略。", icon: <Settings size={15} /> },
    tools: { title: "工具", description: "管理注册给 AI 的工具及其可用状态。", icon: <Wrench size={15} /> },
    skills: { title: "技能", description: "管理 Agent Skills、ClawHub 市场和本地运行环境。", icon: <Sparkles size={15} /> },
    history: { title: "历史会话", description: "查看并清理当前项目保存的 Agent 对话记录。", icon: <MessageSquareText size={15} /> },
    memory: { title: "记忆", description: "查看、审核和维护当前工作区的长期记忆。", icon: <Brain size={15} /> },
    parser: { title: "文档解析", description: "配置 Word 和 PDF 转换所使用的 MinerU 服务。", icon: <FilePlus2 size={15} /> },
    wordExport: { title: "Word 导出", description: "配置封面 Logo、公司信息、页眉及页脚页码。", icon: <FileText size={15} /> },
    workspace: { title: "工作区", description: "管理方案正文、知识库和连接配置的本地目录。", icon: <FolderOpen size={15} /> },
    about: { title: "关于与更新", description: "查看版本并安装经过签名验证的应用更新。", icon: <Info size={15} /> },
  } as const;

  const setWorkspace = (partial: Partial<WorkspacePaths>) => {
    setDraft(current => {
      const currentWorkspace = current.workspace ?? { root: "", historyDir: "" };
      const nextRoot = partial.root ?? currentWorkspace.root;
      const defaults = nextRoot ? defaultWorkspaceFromRoot(nextRoot) : { root: "", historyDir: "" };
      return {
        ...current,
        workspace: {
          root: nextRoot,
          historyDir: partial.historyDir ?? (partial.root !== undefined ? defaults.historyDir : currentWorkspace.historyDir),
        },
      };
    });
    if (partial.root !== undefined && !sameWorkspaceRoot(partial.root, connectionsLoadedRoot)) {
      setConnectionsLoadedRoot("");
      setWorkspaceLoadMessage("");
    }
  };

  const browse = async (kind: "root" | "history") => {
    const title = kind === "root" ? "选择工作目录" : "选择知识库目录";
    const path = await pickDirectory(title);
    if (!path) return;
    if (kind === "root") {
      setWorkspaceLoadMessage("正在加载工作区配置...");
      try {
        const connections = await loadWorkspaceConnections(path);
        const paths = defaultWorkspaceFromRoot(path);
        setDraft(current => applyConnections({ ...current, workspace: paths }, connections));
        setConnectionsLoadedRoot(path);
        setWorkspaceLoadMessage(connections ? "已加载该工作区的模型、搜索和 MinerU 配置。" : "该工作区暂无连接配置，将沿用当前设置。");
      } catch (error) {
        setConnectionsLoadedRoot("");
        setWorkspaceLoadMessage(error instanceof Error ? error.message : "加载工作区配置失败");
      }
    }
    if (kind === "history") setWorkspace({ historyDir: path });
  };

  return <div className="modal-backdrop" onMouseDown={close}>
    <div className="modal wide settings-modal" onMouseDown={e => e.stopPropagation()}>
      <div className="modal-title"><div><Settings size={19} /><span>设置</span></div><IconButton title="关闭" onClick={close}><X size={18} /></IconButton></div>
      <div className="settings-modal-body">
      <aside className="settings-section-nav" aria-label="设置分类">
        <span>常规</span>
        {(Object.keys(sectionDetails) as Array<keyof typeof sectionDetails>).map(id => {
          const item = sectionDetails[id];
          return <button type="button" className={section === id ? "active" : ""} aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)} key={id}>
            <i>{item.icon}</i><span>{item.title}</span>
          </button>;
        })}
        <div><b>本地优先</b><span>正文与索引默认保存在设备上</span></div>
      </aside>
      <section className="settings-section-detail">
      <header className="settings-section-header"><div>{sectionDetails[section].icon}</div><span><b>{sectionDetails[section].title}</b><small>{sectionDetails[section].description}</small></span></header>
      <div className="settings-section-scroll">
      {section === "model" && <ModelSettingsSection draft={draft} setDraft={setDraft} />}
      {section === "search" && <div className="settings-section-content">
      <div className="notice search-settings-notice"><Search size={18} /><div><b>联网搜索按需调用</b><span>Agent 仅在当前会话启用联网搜索后调用服务。连接配置保存在工作区 <code>.gouan/connections.json</code>。</span></div></div>
      <div className="form-grid">
        <label>搜索服务<select value={draft.search.provider} onChange={e => setDraft({ ...draft, search: { ...draft.search, provider: e.target.value as any } })}><option value="searxng">SearXNG</option><option value="brave">Brave Search</option></select></label>
        <label>搜索地址<input value={draft.search.endpoint} onChange={e => setDraft({ ...draft, search: { ...draft.search, endpoint: e.target.value } })} /></label>
        {draft.search.provider === "searxng" && <fieldset className="engine-options wide">
          <legend>上游搜索引擎</legend>
          {SEARXNG_ENGINE_OPTIONS.map(([id, label]) => {
            const selected = (draft.search.engines ?? ["baidu", "360search", "bing"]).includes(id);
            return <label key={id} className={selected ? "selected" : ""}>
              <input
                type="checkbox"
                checked={selected}
                onChange={e => {
                  const current = draft.search.engines ?? ["baidu", "360search", "bing"];
                  const engines = e.target.checked ? [...new Set([...current, id])] : current.filter(engine => engine !== id);
                  if (!engines.length) return;
                  setDraft({ ...draft, search: { ...draft.search, engines } });
                }}
              />
              <span>{label}</span>
            </label>;
          })}
        </fieldset>}
        <label className="wide">搜索 API Key<ApiKeyField value={draft.search.apiKey} placeholder="写入工作区 .gouan/connections.json" onChange={v => setDraft({ ...draft, search: { ...draft.search, apiKey: v } })} /></label>
      </div>
      </div>}
      {section === "agent" && <div className="settings-section-content agent-runtime-settings">
        <div className="agent-title"><Settings size={15} /><span>Agent 运行策略</span></div>
        <p className="muted">控制多轮执行、会话记忆、知识检索与引用方式。章节修改仍需在审核区手动确认。</p>
        <div className="form-grid agent-runtime-grid">
          <label>上下文压缩阈值（tokens）<input type="number" min={1024} max={500000} step={1000} value={draft.agent.contextCompressionTokens} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, contextCompressionTokens: Number(e.target.value) || 98000 } })} /></label>
          <label>长任务模型上下文窗口（tokens）<input type="number" min={8192} max={1000000} step={1000} value={draft.agent.longWritingContextWindowTokens} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, longWritingContextWindowTokens: Number(e.target.value) || 32768 } })} /></label>
          <label>Agent 最大执行轮次<input type="number" min={4} max={50} value={draft.agent.maxRounds} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, maxRounds: Number(e.target.value) || 20 } })} /></label>
          <label>单任务联网搜索次数<input type="number" min={1} max={10} value={draft.agent.webSearchMaxCalls} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, webSearchMaxCalls: Number(e.target.value) || 2 } })} /></label>
          <label>保留近期消息<input type="number" min={4} max={100} value={draft.agent.recentMessages} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, recentMessages: Number(e.target.value) || 20 } })} /></label>
          <label>记忆目录条数<input type="number" min={5} max={100} value={draft.agent.memoryIndexLimit} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, memoryIndexLimit: Number(e.target.value) || 20 } })} /></label>
          <label>引用上下文上限（字符）<input type="number" min={2000} max={200000} step={1000} value={draft.agent.pinnedContextChars} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, pinnedContextChars: Number(e.target.value) || 198000 } })} /></label>
          <label>模型温度：{draft.agent.temperature.toFixed(1)}<input type="range" min={0} max={2} step={0.1} value={draft.agent.temperature} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, temperature: Number(e.target.value) } })} /></label>
          <label>回复风格<select value={draft.agent.responseStyle} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, responseStyle: e.target.value as Project["agent"]["responseStyle"] } })}><option value="concise">简洁</option><option value="balanced">均衡</option><option value="detailed">详细</option></select></label>
          <label>引用要求<select value={draft.agent.citationMode} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, citationMode: e.target.value as Project["agent"]["citationMode"] } })}><option value="required">必须标注来源</option><option value="preferred">尽量标注来源</option><option value="off">不强制标注</option></select></label>
          <div className="wide agent-capability-options">
            <label><input type="checkbox" checked={draft.agent.memoryEnabled} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, memoryEnabled: e.target.checked } })} /><span>新会话默认引用记忆</span></label>
            <label><input type="checkbox" checked={draft.agent.knowledgeToolsEnabled} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, knowledgeToolsEnabled: e.target.checked } })} /><span>新会话默认知识检索</span></label>
            <label><input type="checkbox" checked={draft.agent.webSearchEnabled} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, webSearchEnabled: e.target.checked } })} /><span>新会话默认联网搜索</span></label>
            <label><input type="checkbox" checked={draft.agent.autoRemember} disabled={!draft.agent.memoryEnabled} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, autoRemember: e.target.checked } })} /><span>允许写入记忆</span></label>
            <label><input type="checkbox" checked={draft.agent.planningEnabled} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, planningEnabled: e.target.checked } })} /><span>复杂任务使用计划</span></label>
            <label><input type="checkbox" checked={draft.agent.defaultPinnedContextOnly} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, defaultPinnedContextOnly: e.target.checked } })} /><span>新会话默认仅用已引用资料</span></label>
          </div>
          <label className="wide">附加指令<textarea className="agent-instructions" maxLength={4000} value={draft.agent.customInstructions} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, customInstructions: e.target.value } })} placeholder="例如：优先使用本项目术语，风险项采用表格呈现。" /></label>
        </div>
      </div>}
      {section === "tools" && <ToolSettingsSection
        draft={draft}
        setDraft={setDraft}
        openEnvironmentCheck={desktop ? openEnvironmentCheck : undefined}
      />}
      {section === "skills" && <SkillsSettingsSection project={draft} setProject={setDraft} />}
      {section === "history" && <ConversationHistorySettings project={project} />}
      {section === "memory" && <div className="settings-section-content memory-section-content">
        <MemorySettingsPanel project={draft} />
      </div>}
      {section === "wordExport" && <WordExportSettingsSection value={draft.wordExport} onChange={wordExport => setDraft({ ...draft, wordExport })} />}
      {section === "parser" && <div className="settings-section-content">
        <div className="agent-title"><FilePlus2 size={15} /><span>文档解析 (MinerU)</span></div>
        <p className="muted">将 Word/PDF 转为 Markdown 时调用 MinerU 云端 API（默认 https://mineru.net）。API Key 写入工作区 <code>.gouan/connections.json</code>。</p>
        <div className="form-grid">
          <label className="wide">API 地址<input value={draft.mineru.baseUrl} onChange={e => setDraft({ ...draft, mineru: { ...draft.mineru, baseUrl: e.target.value } })} placeholder="https://mineru.net" /></label>
          <label className="wide">API Key<ApiKeyField value={draft.mineru.apiKey} placeholder="MinerU Token" onChange={v => setDraft({ ...draft, mineru: { ...draft.mineru, apiKey: v } })} /></label>
          <label>模型版本
            <select value={draft.mineru.modelVersion} onChange={e => setDraft({ ...draft, mineru: { ...draft.mineru, modelVersion: e.target.value } })}>
              <option value="vlm">VLM 精准模型</option>
              <option value="pipeline">Pipeline 通用模型</option>
              <option value="MinerU-HTML">MinerU HTML</option>
            </select>
          </label>
          <label>解析语言<input value={draft.mineru.language} onChange={e => setDraft({ ...draft, mineru: { ...draft.mineru, language: e.target.value } })} placeholder="ch" /></label>
          <label>超时秒数<input type="number" min={30} max={1800} value={draft.mineru.timeoutSeconds} onChange={e => setDraft({ ...draft, mineru: { ...draft.mineru, timeoutSeconds: Number(e.target.value) || 300 } })} /></label>
          <label>轮询间隔秒<input type="number" min={1} max={30} value={draft.mineru.pollIntervalSeconds} onChange={e => setDraft({ ...draft, mineru: { ...draft.mineru, pollIntervalSeconds: Number(e.target.value) || 3 } })} /></label>
          <div className="wide mineru-options">
            <span><input type="checkbox" checked={draft.mineru.isOcr} onChange={e => setDraft({ ...draft, mineru: { ...draft.mineru, isOcr: e.target.checked } })} /> OCR（扫描件）</span>
            <span><input type="checkbox" checked={draft.mineru.enableTable} onChange={e => setDraft({ ...draft, mineru: { ...draft.mineru, enableTable: e.target.checked } })} /> 表格识别</span>
            <span><input type="checkbox" checked={draft.mineru.enableFormula} onChange={e => setDraft({ ...draft, mineru: { ...draft.mineru, enableFormula: e.target.checked } })} /> 公式识别</span>
          </div>
        </div>
      </div>}
      {section === "workspace" && <div className="settings-section-content">
        <div className="agent-title"><FolderOpen size={15} /><span>工作区目录</span></div>
        <p className="muted">工作目录根下的 `.md` 是可打开/保存的方案正文；知识库目录存放引用资料。粘贴图片会按文档分目录保存到工作目录 `assets/&lt;文档名&gt;/`。API / 搜索配置保存在工作目录 `.gouan/connections.json`（不进 localStorage）。</p>
        <label className="wide path-field">工作目录
          <div className="path-row">
            <input value={workspace.root} onChange={e => setWorkspace({ root: e.target.value })} placeholder="例如 D:\gouan-workspace" />
            <button disabled={!desktop} onClick={() => void browse("root")}>浏览</button>
          </div>
        </label>
        <label className="wide path-field">知识库目录
          <div className="path-row">
            <input value={workspace.historyDir} onChange={e => setWorkspace({ historyDir: e.target.value })} placeholder="默认 <工作目录>/knowledge" />
            <button disabled={!desktop} onClick={() => void browse("history")}>浏览</button>
          </div>
        </label>
        {!desktop && <p className="muted">浏览器模式无法选择真实磁盘目录；请使用桌面端。</p>}
        {workspaceLoadMessage && <p className="muted">{workspaceLoadMessage}</p>}
      </div>}
      {section === "about" && <AppUpdateSettings />}
      </div>
      </section>
      </div>
      <div className="modal-actions"><button onClick={close}>取消</button><button className="primary" onClick={() => void save(draft, { connectionsLoadedRoot })}>保存设置</button></div>
    </div>
  </div>;
}
