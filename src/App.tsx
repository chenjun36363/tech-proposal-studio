import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Bold, BookOpen, Brain, Check, ChevronDown, ChevronRight, ChevronUp, Code2, Command, Download, FilePlus2, FolderOpen, Globe2, Highlighter, Italic, Moon, MoreHorizontal, Palette, PanelRightClose, PanelRightOpen, Pencil, Redo2, RefreshCw, Replace, Save, Search, Settings, Strikethrough, Sun, TerminalSquare, Undo2, X } from "lucide-react";
import { cycleTheme, getAppliedTheme, type Theme } from "./theme";
import { createProject, defaultWorkspaceFromRoot, makeId } from "./data";
import { exportMarkdown, loadProject, saveProject } from "./storage";
import { searchWeb } from "./services/search";
import { isDesktop } from "./services/runtime";
import { openWorkspacePowerShell, saveMarkdown } from "./services/system";
import { downloadDocx } from "./docxExport";
import { findMatches, replaceAllMatches, replaceMatch, type FindMatch } from "./findReplace";
import { MarkdownPreview, MarkdownSourceEditor, type MarkdownSourceEditorHandle } from "./markdownEditor";
import {
  applyHeadingLevel,
  alignHeadingsToRules,
  buildHeadingTree,
  defaultProposalMarkdown,
  fileNameFromTitle,
  parseMarkdownHeadings,
  renumberHeadings,
  replaceSection,
  sectionBody,
  stripHeadingPrefix,
  titleFromMarkdown,
} from "./markdownDoc";
import {
  ensureWorkspace,
  getDefaultWorkspaceRoot,
  importMarkdownToWorkspace,
  listLibraryFiles,
  listWorkspaceMarkdown,
  loadWorkspaceConfig,
  mergeLibrarySources,
  pickDirectory,
  pickDocumentFile,
  pickMarkdownFile,
  readTextFile,
  saveWorkspaceConfig,
  renameFile,
  withWorkspace,
  writeLibraryMarkdown,
  writeTextFile,
} from "./workspace";
import { AgentConversationPanel } from "./components/AgentConversationPanel";
import { normalizeAgentSettings } from "./agent/settings";
import { HeadingReviewModal } from "./components/HeadingReviewModal";
import { IconButton } from "./components/IconButton";
import { InlineMarkdown } from "./components/InlineMarkdown";
import { SourcePreviewModal } from "./components/SourcePreviewModal";
import { MemorySettingsPanel } from "./components/MemorySettingsPanel";
import { ModelSettingsSection } from "./features/settings/ModelSettingsSection";
import { useProposalDocumentController } from "./hooks/useProposalDocumentController";
import { useProposalFileActions } from "./hooks/useProposalFileActions";
import { useWorkspaceSession } from "./hooks/useWorkspaceSession";
import { useSourcePreview } from "./hooks/useSourcePreview";
import { useEnvironmentTools } from "./hooks/useEnvironmentTools";
import { importWordOrPdfToWorkspace } from "./documentImport";
import { KnowledgeManagerModal } from "./features/knowledge/KnowledgeManagerModal";
import { useKnowledgeTransfer } from "./features/knowledge/useKnowledgeTransfer";
import { InspectorPanel, type InspectorTab } from "./features/inspector/InspectorPanel";
import { WebSearchModal } from "./features/search/WebSearchModal";
import { EnvironmentModal } from "./features/environment/EnvironmentModal";
import {
  saveProjectConnections,
} from "./connections";
import type { AiDraft, DocumentBlock, Project, SearchResult, SessionEvent, SourceRecord, WorkspaceMarkdownFile, WorkspacePaths } from "./types";
import { matchesSource, sourceMatchExcerpt } from "./sourceSearch";
import {
  analyzeKnowledgeMarkdown,
  applyKnowledgeHeadings,
  deleteKnowledgeFile,
  getKnowledgeChunk,
  getKnowledgeSectionScope,
  importKnowledgeWeb,
  listKnowledgeBackups,
  listKnowledge,
  listKnowledgeSectionChunks,
  listKnowledgeSections,
  moveWorkspaceMarkdownToKnowledge,
  onKnowledgeProgress,
  removeKnowledgeDocument,
  restoreKnowledgeBackup,
  scanKnowledge,
  searchKnowledge,
  setKnowledgeChunkQuality,
  setKnowledgeSectionQuality,
} from "./knowledge";

const appIcon = new URL("../src-tauri/icons/128x128.png", import.meta.url).href;
import type { HeadingCandidate, HeadingDetectionResult, HeadingReviewDecision, KnowledgeChunk, KnowledgeChunkQuality, KnowledgeDocument, KnowledgeProgress, KnowledgeScanItem, KnowledgeSearchField, KnowledgeSearchResult, KnowledgeSection, KnowledgeSectionScope } from "./types";

type EditorMode = "section" | "full";
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
function syntheticBlock(project: Project, content: string): DocumentBlock {
  return {
    id: project.id,
    sectionId: "markdown",
    type: "text",
    content,
    order: 0,
    status: "draft",
    sourceRefs: project.contextSourceRefs,
  };
}

export default function App() {
  const { project, setProject, updateProject, setMarkdown, undo, redo, resetHistory } = useProposalDocumentController(
    () => withWorkspace(loadProject(), loadWorkspaceConfig()),
  );
  const [rightTab, setRightTab] = useState<InspectorTab>("commands");
  const [rightOpen, setRightOpen] = useState(true);
  const [theme, setTheme] = useState<Theme>(getAppliedTheme);
  const [rightWidth, setRightWidth] = useState(RIGHT_PANEL_DEFAULT);
  const [leftWidth, setLeftWidth] = useState(LEFT_PANEL_DEFAULT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [knowledgeManagerOpen, setKnowledgeManagerOpen] = useState(false);
  const [webSearchOpen, setWebSearchOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [exportMenu, setExportMenu] = useState(false);
  const [fileMenu, setFileMenu] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedHeadingId, setSelectedHeadingId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("section");
  const [viewMode, setViewMode] = useState<"split" | "edit" | "preview">("split");
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findIndex, setFindIndex] = useState(0);
  const [collapsedHeadings, setCollapsedHeadings] = useState<Set<string>>(new Set());
  const sourcePreview = useSourcePreview();
  const rightDrag = useRef<{ startX: number; startW: number } | null>(null);
  const leftDrag = useRef<{ startX: number; startW: number } | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const sourceEditorRef = useRef<MarkdownSourceEditorHandle | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const desktop = isDesktop();
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2500); };
  const environmentTools = useEnvironmentTools({ desktop, notify });
  const workspace = project.workspace;
  const markdown = project.markdown ?? "";
  const headings = useMemo(() => parseMarkdownHeadings(markdown), [markdown]);
  const headingTree = useMemo(() => buildHeadingTree(headings), [headings]);
  const selectedHeading = headings.find(h => h.id === selectedHeadingId) ?? headings[0] ?? null;
  const activeBody = selectedHeading && editorMode === "section" ? sectionBody(markdown, selectedHeading) : markdown;
  const activeBlock = useMemo(() => syntheticBlock(project, activeBody), [project, activeBody]);
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
    if (!fileMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (!fileMenuRef.current?.contains(e.target as Node)) setFileMenu(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [fileMenu]);

  useEffect(() => {
    if (!selectedHeadingId && headings[0]) setSelectedHeadingId(headings[0].id);
    else if (selectedHeadingId && headings.length && !headings.some(h => h.id === selectedHeadingId)) {
      setSelectedHeadingId(headings[0]?.id ?? null);
    }
  }, [headings, selectedHeadingId]);

  const { workspaceDocs, refreshLibrary, refreshWorkspaceDocs, applyWorkspace } = useWorkspaceSession({
    project, desktop, setProject, notify,
  });
  const {
    importingDocument: importingDoc,
    save: saveToWorkspace,
    openPath: openMarkdownPath,
    reload: reloadCurrentMarkdown,
    openFromDialog,
    importMarkdown: importFromDialog,
    importWordPdf: importWordPdfFromDialog,
    create: createNewFile,
    rename: renameCurrentFile,
  } = useProposalFileActions({
    project, desktop, setProject, resetHistory, selectedHeadingId, setSelectedHeadingId, setEditorMode,
    refreshWorkspaceDocs: () => refreshWorkspaceDocs(), notify,
  });
  const {
    transferringPath: knowledgeTransferPath,
    transfer: transferWorkspaceDocToKnowledge,
  } = useKnowledgeTransfer({
    project, desktop, setProject, refreshLibrary, refreshWorkspaceDocs,
    openKnowledgeManager: () => setKnowledgeManagerOpen(true), notify,
  });


  const setActiveContent = (next: string) => {
    if (selectedHeading && editorMode === "section") {
      setMarkdown(replaceSection(markdown, selectedHeading, next));
    } else {
      setMarkdown(next);
    }
  };

  const wrapSelection = (before: string, after: string) => {
    if (viewMode === "preview") {
      notify("请切换到源码或分栏后使用样式");
      return;
    }
    const sel = sourceEditorRef.current?.getSelection() ?? { start: 0, end: 0 };
    const selected = activeBody.slice(sel.start, sel.end);
    const wrapped = before + selected + after;
    const next = activeBody.slice(0, sel.start) + wrapped + activeBody.slice(sel.end);
    setActiveContent(next);
    requestAnimationFrame(() => {
      sourceEditorRef.current?.setSelection(
        sel.start + before.length,
        sel.start + before.length + selected.length,
      );
    });
  };

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

  const renderHeadingNodes = (nodes: typeof headingTree): React.ReactNode[] => {
    return nodes.flatMap(node => {
      const hasCh = node.children.length > 0;
      const collapsed = collapsedHeadings.has(node.heading.id);
      const item = (
        <button
          key={node.heading.id}
          className={`toc-item level-${node.heading.level} ${selectedHeading?.id === node.heading.id && editorMode === "section" ? "selected" : ""}`}
          onClick={() => { setSelectedHeadingId(node.heading.id); setEditorMode("section"); }}
          title={node.heading.title}
        >
          <span className="toc-chevron" onMouseDown={hasCh ? (e => { e.stopPropagation(); e.preventDefault(); }) : undefined} onClick={hasCh ? () => toggleCollapse(node.heading.id) : undefined}>
            {hasCh ? (collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />) : null}
          </span>
          <span>H{node.heading.level}</span>
          <InlineMarkdown className="toc-title" children={node.heading.title} />
        </button>
      );
      const children = collapsed ? [] : renderHeadingNodes(node.children);
      return [item, ...children];
    });
  };

  const applyHeadingToSelection = (level: number) => {
    if (viewMode === "preview") {
      notify("请切换到源码或分栏后设置标题");
      return;
    }
    const sel = sourceEditorRef.current?.getSelection() ?? { start: 0, end: 0 };
    if (editorMode === "section" && selectedHeading) {
      const result = applyHeadingLevel(activeBody, sel.start, sel.end, level);
      const nextFull = renumberHeadings(replaceSection(markdown, selectedHeading, result.markdown));
      setMarkdown(nextFull);
      requestAnimationFrame(() => sourceEditorRef.current?.setSelection(result.selectionStart, result.selectionEnd));
      notify(`已设为 H${level} 并重新编号`);
      return;
    }
    const result = applyHeadingLevel(markdown, sel.start, sel.end, level);
    setMarkdown(result.markdown);
    requestAnimationFrame(() => sourceEditorRef.current?.setSelection(result.selectionStart, result.selectionEnd));
    notify(`已设为 H${level} 并重新编号`);
  };

  const renumberAllHeadings = () => {
    const fallbackTitle = project.filePath?.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || project.name;
    const result = alignHeadingsToRules(markdown, fallbackTitle);
    const next = result.markdown;
    if (next === markdown) {
      notify("标题编号已是最新");
      return;
    }
    setMarkdown(next);
    notify(result.titleCreated ? "已生成全文标题并重新编号" : "已按固定样式重新编号全部标题");
  };

  const openFindBar = (withReplace = false) => {
    if (viewMode === "preview") setViewMode("split");
    setFindOpen(true);
    if (withReplace) {
      /* keep replace field visible always when open */
    }
    requestAnimationFrame(() => {
      const sel = sourceEditorRef.current?.getSelection();
      if (sel && sel.start !== sel.end) {
        const picked = activeBody.slice(sel.start, sel.end);
        if (picked && !picked.includes("\n") && picked.length < 200) setFindQuery(picked);
      }
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  };

  const selectFindMatch = (match: FindMatch | undefined, index: number) => {
    if (!match) return;
    setFindIndex(index);
    requestAnimationFrame(() => {
      sourceEditorRef.current?.setSelection(match.start, match.end);
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
    const next = (findIndex + dir + findHits.length) % findHits.length;
    selectFindMatch(findHits[next], next);
  };

  const replaceCurrent = () => {
    if (!findQuery) return notify("请输入查找内容");
    if (!findHits.length) return notify("未找到匹配");
    const idx = Math.min(Math.max(findIndex, 0), findHits.length - 1);
    const match = findHits[idx];
    const { text, nextCaret } = replaceMatch(activeBody, match, replaceQuery);
    setActiveContent(text);
    requestAnimationFrame(() => {
      const nextHits = findMatches(text, findQuery, { caseSensitive: findCaseSensitive });
      if (!nextHits.length) {
        setFindIndex(0);
        sourceEditorRef.current?.setSelection(nextCaret, nextCaret);
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
    if (!findQuery) return notify("请输入查找内容");
    const { text, count } = replaceAllMatches(activeBody, findQuery, replaceQuery, { caseSensitive: findCaseSensitive });
    if (!count) return notify("未找到匹配");
    setActiveContent(text);
    setFindIndex(0);
    notify(`已替换 ${count} 处${editorMode === "section" ? "（当前章节）" : "（全文）"}`);
  };

  useEffect(() => {
    if (!findOpen) return;
    if (!findHits.length) {
      setFindIndex(0);
      return;
    }
    if (findIndex >= findHits.length) setFindIndex(0);
  }, [findHits, findIndex, findOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z" && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
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
  }, [findOpen, findHits, findIndex, findQuery, activeBody, viewMode, editorMode, project]);

  const updateActiveBlock = (fn: (b: DocumentBlock) => DocumentBlock) => {
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
    setExporting(true);
    try {
      const path = await downloadDocx(project);
      if (path) notify(`Word 已保存：${path}`);
      else if (path === undefined && isDesktop()) notify("已取消导出");
      else notify("已导出 Word (.docx)");
    } catch (e: any) {
      notify(e?.message ?? "导出 Word 失败");
    } finally {
      setExporting(false);
    }
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

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark"><img src={appIcon} alt="" /><span>构案</span></div>
      <div className="project-identity">
        <input value={project.name} onChange={e => updateProject(p => ({ ...p, name: e.target.value }), false)} />
        <span>{project.filePath ? `磁盘 · ${project.filePath}` : `未关联文件 · 自动缓存 ${new Date(project.updatedAt).toLocaleDateString("zh-CN")}`}</span>
      </div>
      <div className="top-actions">
        <button className="text-button" disabled={!desktop} title={desktop ? "管理知识文档与索引" : "知识管理仅在桌面端可用"} onClick={() => setKnowledgeManagerOpen(true)}><BookOpen size={16} />知识管理</button>
        <button className="text-button" title="联网搜索" onClick={() => setWebSearchOpen(true)}><Globe2 size={16} />联网搜索</button>
        <IconButton
          title={!desktop ? "PowerShell 仅在桌面端可用" : !workspace?.root ? "请先配置工作区" : "在工作区打开 PowerShell"}
          disabled={!desktop || !workspace?.root}
          onClick={() => workspace?.root && void openWorkspacePowerShell(workspace.root).then(() => notify("已在工作区打开 PowerShell")).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error)))}
        ><TerminalSquare size={18} /></IconButton>
        <button className="text-button" onClick={() => void saveToWorkspace()}><Save size={16} />保存</button>
        <div className="export-menu" ref={exportMenuRef}>
          <button className="text-button" disabled={exporting} onClick={() => setExportMenu(v => !v)}>
            <Download size={16} />{exporting ? "导出中…" : "导出"}<ChevronDown size={14} />
          </button>
          {exportMenu && <div className="export-dropdown">
            <button onClick={() => void exportAsMarkdown()}>导出 Markdown (.md)</button>
            <button onClick={() => void exportAsWord()}>导出 Word (.docx)</button>
          </div>}
        </div>
        <IconButton
          title={rightOpen ? "收起右侧面板" : "打开右侧面板"}
          active={rightOpen}
          onClick={() => setRightOpen(v => !v)}
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
        <div className="file-menu" ref={fileMenuRef}>
          <IconButton title="文件操作" active={fileMenu} onClick={() => setFileMenu(value => !value)}><MoreHorizontal size={18} /></IconButton>
          {fileMenu && <div className="file-dropdown">
            <button type="button" onClick={() => { setFileMenu(false); void createNewFile(); }}><FilePlus2 size={15} />新建</button>
            <button type="button" onClick={() => { setFileMenu(false); void importFromDialog(); }}><Download size={15} />导入 Markdown</button>
            <button
              type="button"
              disabled={importingDoc || !desktop}
              title={!desktop ? "仅桌面端可用" : importingDoc ? "MinerU 解析中…" : "通过 MinerU 将 Word/PDF 转为 Markdown"}
              onClick={() => { setFileMenu(false); void importWordPdfFromDialog(); }}
            >
              <FilePlus2 size={15} />{importingDoc ? "解析中…" : "导入 Word/PDF"}
            </button>
            <button type="button" disabled={!desktop || !project.filePath} onClick={() => { setFileMenu(false); void reloadCurrentMarkdown(); }}><RefreshCw size={15} />重新加载</button>
            <button type="button" disabled={!desktop || !project.filePath} onClick={() => { setFileMenu(false); void renameCurrentFile(); }}><Pencil size={15} />重命名</button>
            <div className="file-dropdown-sep" />
            <button type="button" onClick={() => { setFileMenu(false); setEnvOpen(true); }}><Command size={15} />环境检查</button>
          </div>}
        </div>
      </div>
    </header>
    <div
      className={`workspace ${rightOpen ? "with-right" : "right-collapsed"}`}
      style={workspaceGridStyle}
    >
      <aside className="left-panel">
        <div className="panel-heading">
          <span>目录</span>
          <div>
            <IconButton title="新建 Markdown 文件" onClick={() => void createNewFile()}><FilePlus2 size={15} /></IconButton>
            <IconButton title="打开工作区 Markdown" onClick={() => void openFromDialog()}><FolderOpen size={15} /></IconButton>
            <IconButton
              title={project.filePath ? "重新加载当前 Markdown" : "未关联磁盘文件"}
              onClick={() => void reloadCurrentMarkdown()}
            >
              <RefreshCw size={15} />
            </IconButton>
          </div>
        </div>
        <div className="toc-mode">
          <button className={editorMode === "section" ? "active" : ""} onClick={() => setEditorMode("section")}>按章节</button>
          <button className={editorMode === "full" ? "active" : ""} onClick={() => setEditorMode("full")}>全文</button>
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
              <span>工作区文档</span>
              <IconButton title="刷新文件列表" onClick={() => void refreshWorkspaceDocs()}>
                <RefreshCw size={14} />
              </IconButton>
            </div>
            <div className="workspace-docs-list">
              {!workspaceDocs.length && <p className="muted toc-empty">根目录下暂无 .md</p>}
              {workspaceDocs.map(doc => (
                <div className={`workspace-doc-row ${project.filePath === doc.path ? "selected" : ""}`} key={doc.path}>
                  <button
                    type="button"
                    className="workspace-doc-item"
                    title={doc.path}
                    onClick={() => void openMarkdownPath(doc.path)}
                  >
                    <b>{doc.title}</b>
                    <span>{doc.path.split(/[\\/]/).pop()}</span>
                  </button>
                  <IconButton
                    title="转入知识库"
                    disabled={knowledgeTransferPath !== null}
                    onClick={() => void transferWorkspaceDocToKnowledge(doc)}
                  >
                    {knowledgeTransferPath === doc.path ? <RefreshCw className="spinning" size={14} /> : <BookOpen size={14} />}
                  </IconButton>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>
      <div className="left-splitter" onMouseDown={onLeftResizeStart} title="拖动调整左侧面板宽度" />
      <main className="editor-area">
        <div className="editor-title">
          <div>
            <span>{editorMode === "full" ? "全文编辑" : selectedHeading ? `H${selectedHeading.level}` : "正文"}</span>
            <input
              value={editorMode === "full" ? project.name : (selectedHeading?.title ?? project.name)}
              readOnly={editorMode === "section"}
              onChange={e => editorMode === "full" && updateProject(p => ({ ...p, name: e.target.value }), false)}
            />
          </div>
          <div className="view-toggle">
            <button className={viewMode === "edit" ? "active" : ""} onClick={() => setViewMode("edit")}>源码</button>
            <button className={viewMode === "split" ? "active" : ""} onClick={() => setViewMode("split")}>分栏</button>
            <button className={viewMode === "preview" ? "active" : ""} onClick={() => setViewMode("preview")}>预览</button>
          </div>
        </div>
        <div className="heading-toolbar" title="选中多行可批量设置标题；编号样式：H2 第N章 / H3 1.1 / H4 1.1.1 …（H1 为文档总标题）">
          <div className="heading-toolbar-row">
            <span className="heading-toolbar-label">设置标题</span>
            <div className="heading-level-group">
            {[1, 2, 3, 4, 5, 6].map(level => (
              <button
                key={level}
                type="button"
                className="heading-level-btn"
                onClick={() => applyHeadingToSelection(level)}
                title={level === 1 ? "H1 文档总标题" : `H${level} → ${level === 2 ? "第N章" : Array.from({ length: level - 1 }, (_, i) => i + 1).join(".")}`}
              >
                H{level}
              </button>
            ))}
            </div>
            <button type="button" className="heading-renumber-btn" onClick={renumberAllHeadings}>重编号</button>
            <span className="format-divider" />
            <button type="button" className="format-btn" onClick={() => wrapSelection("**", "**")} title="加粗 (Ctrl+B)"><Bold size={14} /></button>
            <button type="button" className="format-btn" onClick={() => wrapSelection("*", "*")} title="斜体 (Ctrl+I)"><Italic size={14} /></button>
            <button type="button" className="format-btn" onClick={() => wrapSelection("~~", "~~")} title="删除线"><Strikethrough size={14} /></button>
            <button type="button" className="format-btn" onClick={() => wrapSelection("`", "`")} title="行内代码"><Code2 size={14} /></button>
            <button type="button" className="format-btn" onClick={() => wrapSelection("==", "==")} title="标黄高亮"><Highlighter size={14} /></button>
          </div>
          <div className="heading-toolbar-row">
            <div className="toolbar-history">
              <IconButton title="撤销 (Ctrl+Z)" onClick={undo}><Undo2 size={16} /></IconButton>
              <IconButton title="重做 (Ctrl+Y / Ctrl+Shift+Z)" onClick={redo}><Redo2 size={16} /></IconButton>
            </div>
            <span className="heading-toolbar-spacer" />
            <button type="button" className="heading-renumber-btn" onClick={() => openFindBar(false)} title="查找 (Ctrl+F)">
              <Search size={14} /> 查找
            </button>
            <button type="button" className="heading-renumber-btn" onClick={() => openFindBar(true)} title="替换 (Ctrl+H)">
              <Replace size={14} /> 替换
            </button>
          </div>
        </div>
        {findOpen && (
          <div className="find-replace-bar">
            <div className="find-replace-row">
              <label>
                <span>查找</span>
                <input
                  ref={findInputRef}
                  value={findQuery}
                  onChange={e => { setFindQuery(e.target.value); setFindIndex(0); }}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      goFind(e.shiftKey ? -1 : 1);
                    }
                  }}
                  placeholder="输入要查找的文本"
                />
              </label>
              <span className="find-count">{findQuery ? (findHits.length ? `${Math.min(findIndex + 1, findHits.length)}/${findHits.length}` : "0/0") : "—"}</span>
              <button type="button" className="heading-level-btn" onClick={() => goFind(-1)} title="上一个 (Shift+F3)"><ChevronUp size={14} /></button>
              <button type="button" className="heading-level-btn" onClick={() => goFind(1)} title="下一个 (F3)"><ChevronDown size={14} /></button>
              <label className="find-option">
                <input type="checkbox" checked={findCaseSensitive} onChange={e => { setFindCaseSensitive(e.target.checked); setFindIndex(0); }} />
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
        <div className={`md-workspace mode-${viewMode}`}>
          {(viewMode === "edit" || viewMode === "split") && (
            <div className="md-pane source-pane">
              <MarkdownSourceEditor
                ref={sourceEditorRef}
                value={activeBody}
                onChange={setActiveContent}
                workspaceRoot={workspace?.root}
                placeholder={editorMode === "full" ? "编辑完整 Markdown…" : "编辑当前章节 Markdown… 支持 Ctrl+V 粘贴图片"}
              />
            </div>
          )}
          {(viewMode === "preview" || viewMode === "split") && (
            <div className="md-pane preview-pane">
              <MarkdownPreview
                markdown={activeBody}
                filePath={project.filePath}
                workspaceRoot={workspace?.root}
              />
            </div>
          )}
        </div>
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
          notify={notify}
          openSettings={() => setSettingsOpen(true)}
          close={() => setRightOpen(false)}
          openSourcePreview={sourcePreview.open}
        />
      </> : (
        <button className="right-rail" title="打开右侧面板" onClick={() => setRightOpen(true)}>
          <PanelRightOpen size={16} />
          <span>侧栏</span>
        </button>
      )}
    </div>
    {sourcePreview.source && <SourcePreviewModal
      source={sourcePreview.source}
      markdown={sourcePreview.markdown}
      loading={sourcePreview.loading}
      error={sourcePreview.error}
      workspaceRoot={project.workspace?.root}
      notify={notify}
      close={sourcePreview.close}
    />}
    {settingsOpen && <SettingsModal
      project={project}
      close={() => setSettingsOpen(false)}
      save={async next => {
        try {
          let workspacePaths = next.workspace;
          if (next.workspace?.root) {
            // Draft is source of truth; do not reload connections over it.
            workspacePaths = await applyWorkspace(next.workspace, { loadConnections: false });
          }
          const root = workspacePaths?.root || next.workspace?.root;
          const saved = await saveProjectConnections({
            ...next,
            agent: normalizeAgentSettings(next.agent),
            workspace: workspacePaths ?? next.workspace,
          }, root);
          saveProject(saved);
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
    {sourceOpen && <SourceModal
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
        }
      }}
    />}
    {envOpen && <EnvironmentModal
      project={project}
      controller={environmentTools}
      close={() => setEnvOpen(false)}
    />}
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </div>;
}

function SettingsModal({ project, close, save }: { project: Project; close: () => void; save: (p: Project) => void | Promise<void> }) {
  const [section, setSection] = useState<"model" | "search" | "agent" | "memory" | "parser" | "workspace">("model");
  const [draft, setDraft] = useState(() => {
    const next = structuredClone(project);
    if (!next.mineru) next.mineru = createProject().mineru;
    next.agent = normalizeAgentSettings(next.agent);
    return next;
  });
  const desktop = isDesktop();
  const workspace = draft.workspace ?? { root: "", historyDir: "" };
  const sectionDetails = {
    model: { title: "模型服务", description: "配置模型接口、访问凭据和默认模型。", icon: <Globe2 size={15} /> },
    search: { title: "联网搜索", description: "配置搜索提供方、接口地址和上游搜索引擎。", icon: <Search size={15} /> },
    agent: { title: "Agent", description: "控制多轮执行、上下文、记忆与工具使用策略。", icon: <Settings size={15} /> },
    memory: { title: "记忆", description: "查看、审核和维护当前工作区的长期记忆。", icon: <Brain size={15} /> },
    parser: { title: "文档解析", description: "配置 Word 和 PDF 转换所使用的 MinerU 服务。", icon: <FilePlus2 size={15} /> },
    workspace: { title: "工作区", description: "管理方案正文、知识库和连接配置的本地目录。", icon: <FolderOpen size={15} /> },
  } as const;

  const setWorkspace = (partial: Partial<WorkspacePaths>) => {
    const nextRoot = partial.root ?? workspace.root;
    const defaults = nextRoot ? defaultWorkspaceFromRoot(nextRoot) : { root: "", historyDir: "" };
    setDraft({
      ...draft,
      workspace: {
        root: nextRoot,
        historyDir: partial.historyDir ?? (partial.root ? defaults.historyDir : workspace.historyDir),
      },
    });
  };

  const browse = async (kind: "root" | "history") => {
    const title = kind === "root" ? "选择工作目录" : "选择知识库目录";
    const path = await pickDirectory(title);
    if (!path) return;
    if (kind === "root") setWorkspace({ root: path });
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
      <div className="notice search-settings-notice"><Search size={18} /><div><b>联网搜索按需调用</b><span>执行搜索前仍会向你展示确切查询内容。连接配置保存在工作区 <code>.gouan/connections.json</code>。</span></div></div>
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
        <label className="wide">搜索 API Key<input type="password" value={draft.search.apiKey} placeholder="写入工作区 .gouan/connections.json" onChange={e => setDraft({ ...draft, search: { ...draft.search, apiKey: e.target.value } })} /></label>
      </div>
      </div>}
      {section === "agent" && <div className="settings-section-content agent-runtime-settings">
        <div className="agent-title"><Settings size={15} /><span>Agent 运行策略</span></div>
        <p className="muted">控制多轮执行、会话记忆、知识检索与引用方式。章节修改仍需在审核区手动确认。</p>
        <div className="form-grid agent-runtime-grid">
          <label>上下文压缩阈值（tokens）<input type="number" min={8000} max={200000} step={1000} value={draft.agent.contextCompressionTokens} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, contextCompressionTokens: Number(e.target.value) || 48000 } })} /></label>
          <label>单任务联网搜索次数<input type="number" min={1} max={10} value={draft.agent.webSearchMaxCalls} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, webSearchMaxCalls: Number(e.target.value) || 2 } })} /></label>
          <label>保留近期消息<input type="number" min={4} max={100} value={draft.agent.recentMessages} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, recentMessages: Number(e.target.value) || 20 } })} /></label>
          <label>记忆目录条数<input type="number" min={5} max={100} value={draft.agent.memoryIndexLimit} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, memoryIndexLimit: Number(e.target.value) || 20 } })} /></label>
          <label>引用上下文上限（字符）<input type="number" min={2000} max={100000} step={1000} value={draft.agent.pinnedContextChars} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, pinnedContextChars: Number(e.target.value) || 24000 } })} /></label>
          <label>模型温度：{draft.agent.temperature.toFixed(1)}<input type="range" min={0} max={2} step={0.1} value={draft.agent.temperature} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, temperature: Number(e.target.value) } })} /></label>
          <label>回复风格<select value={draft.agent.responseStyle} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, responseStyle: e.target.value as Project["agent"]["responseStyle"] } })}><option value="concise">简洁</option><option value="balanced">均衡</option><option value="detailed">详细</option></select></label>
          <label>引用要求<select value={draft.agent.citationMode} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, citationMode: e.target.value as Project["agent"]["citationMode"] } })}><option value="required">必须标注来源</option><option value="preferred">尽量标注来源</option><option value="off">不强制标注</option></select></label>
          <div className="wide agent-capability-options">
            <label><input type="checkbox" checked={draft.agent.knowledgeToolsEnabled} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, knowledgeToolsEnabled: e.target.checked } })} /><span>允许知识库检索</span></label>
            <label><input type="checkbox" checked={draft.agent.memoryEnabled} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, memoryEnabled: e.target.checked } })} /><span>启用长期记忆</span></label>
            <label><input type="checkbox" checked={draft.agent.autoRemember} disabled={!draft.agent.memoryEnabled} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, autoRemember: e.target.checked } })} /><span>允许写入记忆</span></label>
            <label><input type="checkbox" checked={draft.agent.planningEnabled} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, planningEnabled: e.target.checked } })} /><span>复杂任务使用计划</span></label>
            <label><input type="checkbox" checked={draft.agent.defaultPinnedContextOnly} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, defaultPinnedContextOnly: e.target.checked } })} /><span>新会话默认仅用已引用资料</span></label>
          </div>
          <label className="wide">附加指令<textarea className="agent-instructions" maxLength={4000} value={draft.agent.customInstructions} onChange={e => setDraft({ ...draft, agent: { ...draft.agent, customInstructions: e.target.value } })} placeholder="例如：优先使用本项目术语，风险项采用表格呈现。" /></label>
        </div>
      </div>}
      {section === "memory" && <div className="settings-section-content memory-section-content">
        <MemorySettingsPanel project={draft} />
      </div>}
      {section === "parser" && <div className="settings-section-content">
        <div className="agent-title"><FilePlus2 size={15} /><span>文档解析 (MinerU)</span></div>
        <p className="muted">将 Word/PDF 转为 Markdown 时调用 MinerU 云端 API（默认 https://mineru.net）。API Key 写入工作区 <code>.gouan/connections.json</code>。</p>
        <div className="form-grid">
          <label className="wide">API 地址<input value={draft.mineru.baseUrl} onChange={e => setDraft({ ...draft, mineru: { ...draft.mineru, baseUrl: e.target.value } })} placeholder="https://mineru.net" /></label>
          <label className="wide">API Key<input type="password" value={draft.mineru.apiKey} placeholder="MinerU Token" onChange={e => setDraft({ ...draft, mineru: { ...draft.mineru, apiKey: e.target.value } })} /></label>
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
        <p className="muted">工作目录根下的 `.md` 是可打开/保存的方案正文；知识库目录存放引用资料。粘贴图片会保存到工作目录 `assets/`。API / 搜索配置保存在工作目录 `.gouan/connections.json`（不进 localStorage）。</p>
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
      </div>}
      </div>
      </section>
      </div>
      <div className="modal-actions"><button onClick={close}>取消</button><button className="primary" onClick={() => void save(draft)}>保存设置</button></div>
    </div>
  </div>;
}

function SourceModal({ close, add, historyDir }: { close: () => void; add: (s: SourceRecord, content?: string) => void | Promise<void>; historyDir: string }) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  return <div className="modal-backdrop" onMouseDown={close}>
    <div className="modal small" onMouseDown={e => e.stopPropagation()}>
      <div className="modal-title"><div><FilePlus2 size={19} /><span>导入 Markdown</span></div><IconButton title="关闭" onClick={close}><X size={18} /></IconButton></div>
      {historyDir && <p className="muted path-line">将写入：{historyDir}</p>}
      <div className="form-grid">
        <label className="wide">资料名称<input value={name} onChange={e => setName(e.target.value)} placeholder="例如：支付平台历史方案" /></label>
        <label className="wide">Markdown 内容<textarea value={content} onChange={e => setContent(e.target.value)} placeholder={"# 标题\n\n粘贴或输入资料内容…"} /></label>
      </div>
      <div className="modal-actions">
        <button onClick={close}>取消</button>
        <button className="primary" onClick={() => void add({
          id: makeId(),
          kind: "local",
          title: name || "未命名资料",
          location: historyDir || "local",
          excerpt: content.slice(0, 280),
          fingerprint: makeId(),
          accessedAt: new Date().toISOString(),
        }, content)}>导入</button>
      </div>
    </div>
  </div>;
}
