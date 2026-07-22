import { useEffect, useMemo, useRef, useState } from "react";
import { Bold, BookOpen, Bot, Braces, Check, ChevronDown, ChevronRight, ChevronUp, Code2, Command, Download, ExternalLink, Eye, FilePlus2, FolderOpen, FolderSearch, Globe2, Highlighter, Italic, Layers3, Maximize2, Minimize2, Minus, MoreHorizontal, PanelRightClose, PanelRightOpen, Pencil, Redo2, RefreshCw, Replace, Save, Search, Settings, Sparkles, Strikethrough, TerminalSquare, ThumbsDown, ThumbsUp, Trash2, Undo2, X } from "lucide-react";
import { createProject, defaultWorkspaceFromRoot, makeId } from "./data";
import { exportMarkdown, loadProject, saveProject } from "./storage";
import { agentTools, buildAgentCommand, buildAgentInstallCommand, defaultAgentPrompt, withAgentContext, type AgentToolId } from "./agents";
import { detectTools, improveBlock, isDesktop, openExternalUrl, runCommand, saveMarkdown, searchWeb } from "./services";
import { downloadDocx } from "./docxExport";
import { findMatches, replaceAllMatches, replaceMatch, type FindMatch } from "./findReplace";
import { MarkdownPreview, MarkdownSourceEditor, type MarkdownSourceEditorHandle } from "./markdownEditor";
import {
  applyHeadingLevel,
  buildHeadingTree,
  defaultProposalMarkdown,
  fileNameFromTitle,
  parseMarkdownHeadings,
  renumberHeadings,
  replaceSection,
  sectionBody,
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
  pickMarkdownFile,
  readTextFile,
  saveWorkspaceConfig,
  renameFile,
  withWorkspace,
  writeLibraryMarkdown,
  writeTextFile,
} from "./workspace";
import {
  applyConnections,
  connectionsFromProject,
  loadWorkspaceConnections,
  saveWorkspaceConnections,
  syncConnectionSecrets,
} from "./connections";
import type { AiDraft, CommandResult, DocumentBlock, Project, SearchResult, SourceRecord, WorkspaceMarkdownFile, WorkspacePaths } from "./types";
import { matchesSource, sourceMatchExcerpt } from "./sourceSearch";
import {
  analyzeKnowledgeMarkdown,
  applyKnowledgeHeadings,
  deleteKnowledgeFile,
  getKnowledgeChunk,
  importKnowledgeMarkdown,
  importKnowledgeWeb,
  listKnowledgeBackups,
  listKnowledge,
  listKnowledgeSectionChunks,
  listKnowledgeSections,
  onKnowledgeProgress,
  removeKnowledgeDocument,
  retryKnowledgeEnrichment,
  restoreKnowledgeBackup,
  scanKnowledge,
  searchKnowledge,
  setKnowledgeChunkQuality,
} from "./knowledge";
import type { HeadingCandidate, HeadingDetectionResult, HeadingReviewDecision, KnowledgeChunk, KnowledgeChunkQuality, KnowledgeDocument, KnowledgeProgress, KnowledgeScanItem, KnowledgeSearchResult, KnowledgeSection } from "./types";

type RightTab = "ai" | "commands" | "context" | "sources" | "search" | "env";
type EditorMode = "section" | "full";
const RIGHT_PANEL_MIN = 280;
const RIGHT_PANEL_MAX = 720;
const RIGHT_PANEL_DEFAULT = 360;
const LEFT_PANEL_MIN = 180;
const LEFT_PANEL_MAX = 480;
const LEFT_PANEL_DEFAULT = 240;
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
const IconButton = ({ title, children, onClick, active = false }: { title: string; children: React.ReactNode; onClick?: () => void; active?: boolean }) => <button className={`icon-button ${active ? "active" : ""}`} title={title} aria-label={title} onClick={onClick}>{children}</button>;

function SourcePreviewModal({ source, markdown, loading, error, workspaceRoot, close, notify }: {
  source: SourceRecord;
  markdown: string;
  loading: boolean;
  error: string;
  workspaceRoot?: string;
  close: () => void;
  notify: (message: string) => void;
}) {
  const [maximized, setMaximized] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const toggleMaximized = () => { setMaximized(value => !value); setPosition({ x: 0, y: 0 }); };
  const openOriginal = async () => {
    try { await openExternalUrl(source.location); } catch (e: any) { notify(e?.message ?? "无法打开来源链接"); }
  };
  return <div className="preview-modal-overlay" onClick={close}>
    <div className={`preview-modal ${maximized ? "maximized" : ""}`} style={maximized ? undefined : { transform: `translate(${position.x}px, ${position.y}px)` }} onClick={e => e.stopPropagation()}>
      <div
        className="preview-modal-head"
        onDoubleClick={event => { if (!(event.target as HTMLElement).closest("button")) toggleMaximized(); }}
        onPointerDown={event => {
          if (maximized || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
          dragRef.current = { x: event.clientX, y: event.clientY, left: position.x, top: position.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const drag = dragRef.current;
          if (!drag) return;
          setPosition({ x: drag.left + event.clientX - drag.x, y: drag.top + event.clientY - drag.y });
        }}
        onPointerUp={event => { dragRef.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { dragRef.current = null; }}
      >
        <div className="preview-modal-title">
          <strong>{source.title}</strong>
          <em title={source.location}>{source.location}</em>
        </div>
        <div className="preview-modal-tools">
          {source.kind === "web" && <IconButton title="打开原网页" onClick={() => void openOriginal()}><ExternalLink size={16} /></IconButton>}
          <IconButton title={maximized ? "还原窗口" : "最大化窗口"} onClick={toggleMaximized}>{maximized ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</IconButton>
          <span className="preview-tool-divider" />
          <IconButton title="关闭预览" onClick={close}><X size={18} /></IconButton>
        </div>
      </div>
      {loading && <div className="loading-line preview-status">正在加载预览…</div>}
      {error && <p className="muted preview-status">{error}</p>}
      {!loading && !error && <div className="preview-modal-viewport">
        <div className="preview-modal-canvas">
          <MarkdownPreview
            markdown={markdown}
            filePath={source.kind === "local" ? source.location : undefined}
            workspaceRoot={workspaceRoot}
            onLinkClick={href => void openExternalUrl(href).catch((e: any) => notify(e?.message ?? "无法打开链接"))}
          />
        </div>
      </div>}
    </div>
  </div>;
}

function HeadingReviewModal({ result, candidates, setCandidates, busy, close, confirm }: {
  result: HeadingDetectionResult;
  candidates: HeadingCandidate[];
  setCandidates: (items: HeadingCandidate[]) => void;
  busy: boolean;
  close: () => void;
  confirm: () => void;
}) {
  const selected = candidates.filter(item => item.selected);
  const levelJumps = selected.filter((item, index) => index > 0 && item.level > selected[index - 1].level + 1).length;
  const update = (id: string, patch: Partial<HeadingCandidate>) => setCandidates(candidates.map(item => item.id === id ? { ...item, ...patch, source: patch.level || patch.selected !== undefined ? "user" : item.source } : item));
  return <div className="modal-backdrop heading-review-backdrop" onClick={close}>
    <div className="modal heading-review-modal" onClick={event => event.stopPropagation()}>
      <div className="modal-title"><div><BookOpen size={18} />识别文档结构</div><IconButton title="关闭" onClick={close}><X size={17} /></IconButton></div>
      <div className="heading-review-summary">
        <div><b>{result.title}</b><span>{selected.length} 个标题 · {candidates.filter(item => item.confidence < .8).length} 个需关注</span></div>
        {result.tocStart != null && <em>已识别 Word 目录，第 {result.tocStart + 1}-{(result.tocEnd ?? result.tocStart) + 1} 行仅用于结构匹配</em>}
        {result.modelError && <p>{result.modelError}</p>}
        {!!levelJumps && <p>{levelJumps} 处标题层级存在跳跃，请重点检查章节树。</p>}
      </div>
      <div className="heading-review-grid">
        <section className="heading-candidate-list">
          <div className="heading-review-column-title">候选标题</div>
          {candidates.map(item => <div className={`heading-candidate ${item.confidence < .8 ? "uncertain" : ""}`} key={item.id}>
            <input type="checkbox" checked={item.selected} disabled={item.source === "markdown"} title={item.source === "markdown" ? "已有 Markdown 标题保持不变" : undefined} onChange={event => update(item.id, { selected: event.target.checked })} />
            <select value={item.level} disabled={!item.selected || item.source === "markdown"} onChange={event => update(item.id, { level: Number(event.target.value) })}>{[1,2,3,4,5,6].map(level => <option value={level} key={level}>H{level}</option>)}</select>
            <div><b>{item.text}</b><span>第 {item.line + 1} 行 · {item.reason}</span><code>{item.selected && !item.original.trimStart().startsWith("#") ? `${"#".repeat(item.level)} ${item.original.trimStart()}` : item.original}</code></div>
            <em>{Math.round(item.confidence * 100)}%</em>
          </div>)}
          {!candidates.length && <p className="muted">未发现标题候选，将按文档根节点切片。</p>}
        </section>
        <section className="heading-tree-preview">
          <div className="heading-review-column-title">章节树预览</div>
          {selected.map(item => <div key={item.id} style={{ paddingLeft: `${(item.level - 1) * 14}px` }}><span>H{item.level}</span><b>{item.text}</b></div>)}
          {!selected.length && <p className="muted">没有选中的标题</p>}
        </section>
      </div>
      <div className="modal-actions"><button onClick={close} disabled={busy}>取消</button><button className="primary" onClick={confirm} disabled={busy}>{busy ? "正在规范化并索引…" : "确认结构并入库"}</button></div>
    </div>
  </div>;
}

function syntheticBlock(project: Project, content: string): DocumentBlock {
  return {
    id: project.id,
    sectionId: "markdown",
    type: "text",
    content,
    order: 0,
    status: "draft",
    sourceRefs: project.sections[0]?.blocks[0]?.sourceRefs ?? [],
  };
}

export default function App() {
  const [project, setProject] = useState<Project>(() => withWorkspace(loadProject(), loadWorkspaceConfig()));
  const [rightTab, setRightTab] = useState<RightTab>("ai");
  const [rightOpen, setRightOpen] = useState(true);
  const [rightWidth, setRightWidth] = useState(RIGHT_PANEL_DEFAULT);
  const [leftWidth, setLeftWidth] = useState(LEFT_PANEL_DEFAULT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [knowledgeManagerOpen, setKnowledgeManagerOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [exportMenu, setExportMenu] = useState(false);
  const [fileMenu, setFileMenu] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [workspaceDocs, setWorkspaceDocs] = useState<WorkspaceMarkdownFile[]>([]);
  const [selectedHeadingId, setSelectedHeadingId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("section");
  const [viewMode, setViewMode] = useState<"split" | "edit" | "preview">("split");
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findIndex, setFindIndex] = useState(0);
  const [collapsedHeadings, setCollapsedHeadings] = useState<Set<string>>(new Set());
  const [previewSource, setPreviewSource] = useState<SourceRecord | null>(null);
  const [previewMarkdown, setPreviewMarkdown] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const history = useRef<Project[]>([]);
  const redoStack = useRef<Project[]>([]);
  const saveTimer = useRef<number | undefined>(undefined);
  const rightDrag = useRef<{ startX: number; startW: number } | null>(null);
  const leftDrag = useRef<{ startX: number; startW: number } | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const sourceEditorRef = useRef<MarkdownSourceEditorHandle | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const desktop = isDesktop();
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
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveProject(project), 500);
    return () => window.clearTimeout(saveTimer.current);
  }, [project]);

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

  useEffect(() => {
    void (async () => {
      try {
        if (!desktop) {
          const browserConn = await loadWorkspaceConnections();
          if (browserConn) setProject(p => applyConnections(p, browserConn));
          return;
        }
        let paths = loadWorkspaceConfig();
        if (!paths?.root) {
          const root = await getDefaultWorkspaceRoot();
          if (root) paths = defaultWorkspaceFromRoot(root);
        }
        if (!paths?.root) return;
        const ensured = await ensureWorkspace(paths);
        const conn = await loadWorkspaceConnections(ensured.root);
        setProject(p => {
          let next = withWorkspace(p, ensured);
          if (conn) next = applyConnections(next, conn);
          return next;
        });
        const files = await listLibraryFiles(ensured.historyDir);
        setProject(p => mergeLibrarySources(withWorkspace(p, ensured), files));
        setWorkspaceDocs(await listWorkspaceMarkdown(ensured.root));
      } catch (e: any) {
        notify(e?.message ?? "工作区初始化失败");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop]);

  const updateProject = (fn: (p: Project) => Project, remember = true) => {
    if (remember) {
      history.current.push(structuredClone(project));
      if (history.current.length > 100) history.current.shift();
      redoStack.current = [];
    }
    setProject(fn(project));
  };
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2500); };
  const undo = () => {
    const previous = history.current.pop();
    if (!previous) return;
    redoStack.current.push(structuredClone(project));
    setProject(previous);
  };
  const redo = () => {
    const next = redoStack.current.pop();
    if (!next) return;
    history.current.push(structuredClone(project));
    if (history.current.length > 100) history.current.shift();
    setProject(next);
  };

  const setMarkdown = (next: string, remember = true) => {
    updateProject(p => ({
      ...p,
      markdown: next,
      name: titleFromMarkdown(next, p.name),
      updatedAt: new Date().toISOString(),
    }), remember);
  };

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

  const collapseAll = () => {
    const next = new Set<string>();
    const walk = (nodes: typeof headingTree) => {
      for (const n of nodes) {
        if (n.children.length > 0) next.add(n.heading.id);
        walk(n.children);
      }
    };
    walk(headingTree);
    setCollapsedHeadings(next);
  };

  const expandToLevel = (level: number) => {
    const next = new Set<string>();
    for (const h of headings) {
      if (h.level > level) next.add(h.id);
    }
    setCollapsedHeadings(next);
  };

  const collapseToLevel = (level: number) => {
    const next = new Set<string>();
    for (const h of headings) {
      if (h.level >= level) next.add(h.id);
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
          <b>{node.heading.title}</b>
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
    const next = renumberHeadings(markdown);
    if (next === markdown) {
      notify("标题编号已是最新");
      return;
    }
    setMarkdown(next);
    notify("已按固定样式重新编号全部标题");
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

  const refreshLibrary = async (paths = workspace) => {
    if (!desktop || !paths?.historyDir) return;
    const files = await listLibraryFiles(paths.historyDir);
    setProject(p => mergeLibrarySources(p, files));
    notify(`已加载 ${files.length} 份本地资料`);
  };

  const refreshWorkspaceDocs = async (paths = workspace) => {
    if (!desktop || !paths?.root) return;
    setWorkspaceDocs(await listWorkspaceMarkdown(paths.root));
  };

  const saveToWorkspace = async () => {
    if (!desktop) return notify("浏览器模式仅保存到 localStorage");
    try {
      if (!project.workspace?.root) return notify("请先在设置中配置工作目录");
      let path = project.filePath;
      if (!path) {
        path = `${project.workspace.root.replace(/[\\/]+$/, "")}${project.workspace.root.includes("\\") ? "\\" : "/"}${fileNameFromTitle(project.name)}`;
      }
      const saved = await writeTextFile(path, exportMarkdown(project));
      setProject(p => ({ ...p, filePath: saved, updatedAt: new Date().toISOString() }));
      await refreshWorkspaceDocs();
      notify("方案已保存到工作目录");
    } catch (e: any) {
      notify(e?.message ?? "保存失败");
    }
  };

  const openMarkdownPath = async (path: string) => {
    try {
      const text = await readTextFile(path);
      const next = withWorkspace({
        ...project,
        id: makeId(),
        name: titleFromMarkdown(text, path.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || "未命名"),
        markdown: text,
        filePath: path,
        updatedAt: new Date().toISOString(),
        sections: project.sections,
        sources: project.sources,
      }, workspace);
      history.current = [];
      redoStack.current = [];
      setProject(next);
      const hs = parseMarkdownHeadings(text);
      setSelectedHeadingId(hs[0]?.id ?? null);
      setEditorMode("section");
      notify(`已打开：${next.name}`);
    } catch (e: any) {
      notify(e?.message ?? "打开失败");
    }
  };

  const reloadCurrentMarkdown = async () => {
    if (!desktop) return notify("请在桌面端重新加载");
    const path = project.filePath;
    if (!path) return notify("当前未关联磁盘 Markdown，请先打开或保存文件");
    try {
      const text = await readTextFile(path);
      const prevHeadingId = selectedHeadingId;
      history.current = [];
      redoStack.current = [];
      setProject(p => ({
        ...p,
        markdown: text,
        name: titleFromMarkdown(text, p.name),
        filePath: path,
        updatedAt: new Date().toISOString(),
      }));
      const hs = parseMarkdownHeadings(text);
      setSelectedHeadingId(hs.some(h => h.id === prevHeadingId) ? prevHeadingId : (hs[0]?.id ?? null));
      notify("已从磁盘重新加载");
    } catch (e: any) {
      notify(e?.message ?? "重新加载失败");
    }
  };

  const openFromDialog = async () => {
    if (!desktop) return notify("请在桌面端打开文件");
    const path = await pickMarkdownFile("选择要编辑的 Markdown", workspace?.root);
    if (!path) return;
    await openMarkdownPath(path);
  };

  const importFromDialog = async () => {
    if (!desktop) return notify("请在桌面端导入文件");
    const root = workspace?.root;
    if (!root) return notify("请先在设置中配置工作目录");
    const sourcePath = await pickMarkdownFile("选择要导入到工作区的 Markdown");
    if (!sourcePath) return;
    try {
      const importedPath = await importMarkdownToWorkspace(sourcePath, root);
      await openMarkdownPath(importedPath);
      await refreshWorkspaceDocs();
      notify(`已导入并加载：${importedPath.split(/[\\/]/).pop()}`);
    } catch (e: any) {
      notify(e?.message ?? "导入失败");
    }
  };

  const createNewFile = async () => {
    if (!desktop) return notify("新建文件仅在桌面端可用");
    const root = workspace?.root;
    if (!root) return notify("请在设置中配置工作目录");
    const input = window.prompt("请输入文件名：");
    if (!input) return;
    const name = input.trim();
    if (!name) return;
    const fileName = fileNameFromTitle(name);
    const path = `${root.replace(/[\\/]+$/, "")}${root.includes("\\") ? "\\" : "/"}${fileName}`;
    const template = defaultProposalMarkdown(name);
    try {
      await writeTextFile(path, template);
      await openMarkdownPath(path);
      await refreshWorkspaceDocs();
      notify(`已创建：${fileName}`);
    } catch (e: any) {
      notify(e?.message ?? "创建失败");
    }
  };

  const renameCurrentFile = async () => {
    if (!desktop) return notify("重命名仅在桌面端可用");
    if (!project.filePath) return notify("请先打开一个文件");
    const oldPath = project.filePath;
    const oldName = oldPath.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || "";
    const input = window.prompt("请输入新文件名：", oldName);
    if (!input) return;
    const name = input.trim();
    if (!name || name === oldName) return;
    const dir = oldPath.slice(0, Math.max(oldPath.lastIndexOf("\\"), oldPath.lastIndexOf("/")));
    const sep = oldPath.includes("\\") ? "\\" : "/";
    const newPath = `${dir}${sep}${fileNameFromTitle(name)}`;
    try {
      await renameFile(oldPath, newPath);
      const next = { ...project, filePath: newPath, name, updatedAt: new Date().toISOString() };
      setProject(next);
      await refreshWorkspaceDocs();
      notify(`已重命名为：${fileNameFromTitle(name)}`);
    } catch (e: any) {
      notify(e?.message ?? "重命名失败");
    }
  };

  const applyWorkspace = async (paths: WorkspacePaths, opts?: { loadConnections?: boolean }) => {
    const ensured = await ensureWorkspace(paths);
    saveWorkspaceConfig(ensured);
    if (opts?.loadConnections) {
      const conn = await loadWorkspaceConnections(ensured.root);
      setProject(p => {
        let next = withWorkspace(p, ensured);
        if (conn) next = applyConnections(next, conn);
        return next;
      });
    } else {
      setProject(p => withWorkspace(p, ensured));
    }
    await refreshLibrary(ensured);
    await refreshWorkspaceDocs(ensured);
    return ensured;
  };

  const updateActiveBlock = (fn: (b: DocumentBlock) => DocumentBlock) => {
    const next = fn(activeBlock);
    setActiveContent(next.content);
    if (next.sourceRefs) {
      // keep sourceRefs on first legacy block for AI context toggles
      updateProject(p => {
        if (!p.sections[0]?.blocks[0]) return p;
        const sections = p.sections.map((s, i) => i === 0 ? {
          ...s,
          blocks: s.blocks.map((b, j) => j === 0 ? { ...b, sourceRefs: next.sourceRefs } : b),
        } : s);
        return { ...p, sections };
      }, false);
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
    ? { gridTemplateColumns: `${leftWidth}px 5px 1fr 5px ${rightWidth}px` }
    : { gridTemplateColumns: `${leftWidth}px 5px 1fr 36px` };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark"><Braces size={18} /><span>构案</span></div>
      <div className="project-identity">
        <input value={project.name} onChange={e => updateProject(p => ({ ...p, name: e.target.value }), false)} />
        <span>{project.filePath ? `磁盘 · ${project.filePath}` : `未关联文件 · 自动缓存 ${new Date(project.updatedAt).toLocaleDateString("zh-CN")}`}</span>
      </div>
      <div className="top-actions">
        <button className="text-button" disabled={!desktop} title={desktop ? "管理知识文档与索引" : "知识管理仅在桌面端可用"} onClick={() => setKnowledgeManagerOpen(true)}><BookOpen size={16} />知识管理</button>
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
        <IconButton title="设置" onClick={() => setSettingsOpen(true)}><Settings size={18} /></IconButton>
        <div className="file-menu" ref={fileMenuRef}>
          <IconButton title="文件操作" active={fileMenu} onClick={() => setFileMenu(value => !value)}><MoreHorizontal size={18} /></IconButton>
          {fileMenu && <div className="file-dropdown">
            <button type="button" onClick={() => { setFileMenu(false); void createNewFile(); }}><FilePlus2 size={15} />新建</button>
            <button type="button" onClick={() => { setFileMenu(false); void importFromDialog(); }}><Download size={15} />导入</button>
            <button type="button" disabled={!desktop || !project.filePath} onClick={() => { setFileMenu(false); void reloadCurrentMarkdown(); }}><RefreshCw size={15} />重新加载</button>
            <button type="button" disabled={!desktop || !project.filePath} onClick={() => { setFileMenu(false); void renameCurrentFile(); }}><Pencil size={15} />重命名</button>
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
            <span className="toc-actions-label-sep">展开到</span>
            <span className="toc-action-btn-group">
              {[2, 3, 4].map(l => <button key={`e${l}`} className="toc-action-btn" onClick={() => expandToLevel(l)}>{l}级</button>)}
              <button type="button" className="toc-action-btn" onClick={expandAll}>全部</button>
            </span>
          </div>
          <div className="toc-actions-row">
            <span className="toc-actions-label-sep">收起到</span>
            <span className="toc-action-btn-group">
              {[2, 3, 4].map(l => <button key={`c${l}`} className="toc-action-btn" onClick={() => collapseToLevel(l)}>{l}级</button>)}
              <button type="button" className="toc-action-btn" onClick={collapseAll}>全部</button>
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
                <button
                  key={doc.path}
                  type="button"
                  className={`workspace-doc-item ${project.filePath === doc.path ? "selected" : ""}`}
                  title={doc.path}
                  onClick={() => void openMarkdownPath(doc.path)}
                >
                  <b>{doc.title}</b>
                  <span>{doc.path.split(/[\\/]/).pop()}</span>
                </button>
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
          <div className="toolbar-history">
            <IconButton title="撤销 (Ctrl+Z)" onClick={undo}><Undo2 size={16} /></IconButton>
            <IconButton title="重做 (Ctrl+Y / Ctrl+Shift+Z)" onClick={redo}><Redo2 size={16} /></IconButton>
          </div>
          <span className="format-divider" />
          <span className="heading-toolbar-label">设置标题</span>
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
          <button type="button" className="heading-renumber-btn" onClick={renumberAllHeadings}>重编号</button>
          <span className="format-divider" />
          <button type="button" className="format-btn" onClick={() => wrapSelection("**", "**")} title="加粗 (Ctrl+B)"><Bold size={14} /></button>
          <button type="button" className="format-btn" onClick={() => wrapSelection("*", "*")} title="斜体 (Ctrl+I)"><Italic size={14} /></button>
          <button type="button" className="format-btn" onClick={() => wrapSelection("~~", "~~")} title="删除线"><Strikethrough size={14} /></button>
          <button type="button" className="format-btn" onClick={() => wrapSelection("`", "`")} title="行内代码"><Code2 size={14} /></button>
          <button type="button" className="format-btn" onClick={() => wrapSelection("==", "==")} title="标黄高亮"><Highlighter size={14} /></button>
          <span className="heading-toolbar-spacer" />
          <button type="button" className="heading-renumber-btn" onClick={() => openFindBar(false)} title="查找 (Ctrl+F)">
            <Search size={14} /> 查找
          </button>
          <button type="button" className="heading-renumber-btn" onClick={() => openFindBar(true)} title="替换 (Ctrl+H)">
            <Replace size={14} /> 替换
          </button>
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
        <RightPanel
          tab={rightTab}
          setTab={setRightTab}
          project={project}
          block={activeBlock}
          updateProject={updateProject}
          updateBlock={updateActiveBlock}
          notify={notify}
          openSettings={() => setSettingsOpen(true)}
          close={() => setRightOpen(false)}
          openSource={() => setSourceOpen(true)}
          refreshLibrary={() => void refreshLibrary()}
          terminalCwd={workspace?.root || "."}
          previewSource={previewSource}
          setPreviewSource={setPreviewSource}
          previewMarkdown={previewMarkdown}
          setPreviewMarkdown={setPreviewMarkdown}
          previewLoading={previewLoading}
          setPreviewLoading={setPreviewLoading}
          previewError={previewError}
          setPreviewError={setPreviewError}
        />
      </> : (
        <button className="right-rail" title="打开右侧面板" onClick={() => setRightOpen(true)}>
          <PanelRightOpen size={16} />
          <span>侧栏</span>
        </button>
      )}
    </div>
    {previewSource && <SourcePreviewModal
      source={previewSource}
      markdown={previewMarkdown}
      loading={previewLoading}
      error={previewError}
      workspaceRoot={project.workspace?.root}
      notify={notify}
      close={() => { setPreviewSource(null); setPreviewMarkdown(""); setPreviewError(""); }}
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
          const conn = connectionsFromProject(next);
          await saveWorkspaceConnections(root, conn);
          await syncConnectionSecrets(conn);
          setProject({
            ...next,
            workspace: workspacePaths ?? next.workspace,
            model: conn.model,
            search: conn.search,
          });
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
      notify={notify}
      close={() => setKnowledgeManagerOpen(false)}
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
            notify("资料已写入历史资料目录并加载");
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
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </div>;
}

function KnowledgeManagerModal({ project, updateProject, updateBlock, notify, close }: any) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [pending, setPending] = useState<KnowledgeScanItem[]>([]);
  const [sections, setSections] = useState<Record<string, KnowledgeSection[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<KnowledgeProgress | null>(null);
  const [headingReview, setHeadingReview] = useState<HeadingDetectionResult | null>(null);
  const [headingCandidates, setHeadingCandidates] = useState<HeadingCandidate[]>([]);
  const [preview, setPreview] = useState<{ source: SourceRecord; markdown: string; loading: boolean; error: string } | null>(null);

  const reload = async () => {
    if (!project.workspace?.root) return;
    const [nextDocuments, scanned] = await Promise.all([listKnowledge(project.workspace), scanKnowledge(project.workspace)]);
    setDocuments(nextDocuments);
    setPending(scanned.filter((item: KnowledgeScanItem) => item.state !== "indexed"));
  };

  useEffect(() => { void reload().catch((e: any) => notify(e?.message ?? "知识库加载失败")); }, [project.workspace?.root]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onKnowledgeProgress(setProgress).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  const analyze = async (path: string) => {
    if (!project.workspace) return;
    setBusy(true);
    try { const result = await analyzeKnowledgeMarkdown(project.workspace, path, project.model); setHeadingReview(result); setHeadingCandidates(result.candidates); }
    catch (e: any) { notify(e?.message ?? "文档结构识别失败"); }
    finally { setBusy(false); }
  };
  const importFile = async () => {
    if (!project.workspace) return notify("请先配置工作目录");
    const path = await pickMarkdownFile("上传知识 Markdown", project.workspace.historyDir);
    if (path) await analyze(path);
  };
  const confirmReview = async () => {
    if (!project.workspace || !headingReview) return;
    setBusy(true);
    const decisions: HeadingReviewDecision[] = headingCandidates.map(item => ({ id: item.id, line: item.line, selected: item.selected, level: item.level, source: item.source, confidence: item.confidence }));
    try { await applyKnowledgeHeadings(project.workspace, headingReview, decisions, project.model); setHeadingReview(null); setHeadingCandidates([]); await reload(); notify("文档结构已确认并入库"); }
    catch (e: any) { notify(e?.message ?? "规范化入库失败"); }
    finally { setBusy(false); }
  };
  const toggleDocument = async (documentId: string) => {
    const next = new Set(expanded);
    if (next.has(documentId)) next.delete(documentId); else {
      next.add(documentId);
      if (!sections[documentId] && project.workspace) {
        try { const value = await listKnowledgeSections(project.workspace, documentId); setSections(current => ({ ...current, [documentId]: value })); }
        catch (e: any) { notify(e?.message ?? "读取文档结构失败"); }
      }
    }
    setExpanded(next);
  };
  const rebuild = async (document: KnowledgeDocument) => {
    if (!project.workspace) return;
    setBusy(true);
    try { await importKnowledgeMarkdown(project.workspace, document.location, project.model); await reload(); notify("索引已重建"); }
    catch (e: any) { notify(e?.message ?? "重建索引失败"); }
    finally { setBusy(false); }
  };
  const restore = async (document: KnowledgeDocument) => {
    if (!project.workspace) return;
    setBusy(true);
    try {
      const backups = await listKnowledgeBackups(project.workspace, document.id);
      if (!backups.length) return notify("该文档没有可恢复的原始快照");
      if (!confirm(`恢复“${document.title}”到 ${backups[0].name}？当前规范化内容会被替换。`)) return;
      await restoreKnowledgeBackup(project.workspace, document.id, backups[0].path, project.model); await reload(); notify("已恢复原始版本并重建索引");
    } catch (e: any) { notify(e?.message ?? "恢复原文失败"); }
    finally { setBusy(false); }
  };
  const deletePending = async (item: KnowledgeScanItem) => {
    if (!project.workspace || !confirm(`彻底删除“${item.title}”？\n\n将删除 history 中的 Markdown 副本，此操作无法撤销。`)) return;
    setBusy(true);
    try { await deleteKnowledgeFile(project.workspace, item.path, item.documentId); await reload(); notify("知识文档已删除"); }
    catch (e: any) { notify(e?.message ?? "删除失败"); }
    finally { setBusy(false); }
  };
  const deleteIndexed = async (document: KnowledgeDocument) => {
    if (!project.workspace || !confirm(`彻底删除“${document.title}”？\n\n将同时删除索引和 history 中的 Markdown 副本，此操作无法撤销。`)) return;
    setBusy(true);
    try {
      await deleteKnowledgeFile(project.workspace, document.location, document.id);
      const removedIds = new Set((project.sources as SourceRecord[]).filter(source => source.location === `knowledge:${document.id}`).map(source => source.id));
      updateProject((value: Project) => ({ ...value, sources: value.sources.filter(source => !removedIds.has(source.id)) }));
      updateBlock((value: DocumentBlock) => ({ ...value, sourceRefs: value.sourceRefs.filter(id => !removedIds.has(id)) }));
      await reload(); notify("知识文档及索引已删除");
    } catch (e: any) { notify(e?.message ?? "删除失败"); }
    finally { setBusy(false); }
  };
  const previewDocument = async (document: KnowledgeDocument) => {
    const source: SourceRecord = { id: document.id, kind: "local", title: document.title, location: document.location, excerpt: "", fingerprint: document.fingerprint, accessedAt: new Date().toISOString() };
    setPreview({ source, markdown: "", loading: true, error: "" });
    try { const markdown = await readTextFile(document.location); setPreview({ source, markdown, loading: false, error: "" }); }
    catch (e: any) { setPreview({ source, markdown: "", loading: false, error: e?.message ?? "读取文档失败" }); }
  };
  const previewSection = async (document: KnowledgeDocument, section: KnowledgeSection) => {
    if (!project.workspace) return;
    const source: SourceRecord = { id: section.id, kind: "local", title: `${document.title} / ${section.title}`, location: document.location, excerpt: section.summary, fingerprint: section.id, accessedAt: new Date().toISOString(), heading: section.headingPath };
    setPreview({ source, markdown: "", loading: true, error: "" });
    try {
      const chunks = await listKnowledgeSectionChunks(project.workspace, section.id);
      const markdown = chunks.map(chunk => chunk.content).filter(Boolean).join("\n\n---\n\n");
      setPreview({ source, markdown: markdown || `# ${section.title}\n\n（该章节暂无正文）`, loading: false, error: "" });
    } catch (e: any) { setPreview({ source, markdown: "", loading: false, error: e?.message ?? "读取知识片段失败" }); }
  };
  const groups = [
    { id: "local", label: "本地 Markdown", documents: documents.filter(item => item.sourceType === "markdown") },
    { id: "web", label: "网页知识", documents: documents.filter(item => item.sourceType === "web") },
  ].filter(group => group.documents.length);
  const headingSourceLabel = (source: KnowledgeSection["headingSource"]) => ({ markdown: "原生标题", toc: "目录匹配", numbering: "编号识别", model: "模型识别", user: "人工确认" }[source] ?? source);

  return <div className="modal-backdrop knowledge-manager-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <div className="modal knowledge-manager-modal" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title"><div><BookOpen size={19} /><span>知识管理</span></div><IconButton title="关闭" onClick={() => !busy && close()}><X size={18} /></IconButton></div>
      <div className="knowledge-manager-toolbar">
        <div><b>{documents.length}</b><span>已入库</span><b>{pending.length}</b><span>待处理</span></div>
        <div><button disabled={busy} onClick={() => void reload()}><RefreshCw size={14} />扫描目录</button><button className="primary" disabled={busy} onClick={() => void importFile()}><FilePlus2 size={15} />导入 Markdown</button></div>
      </div>
      {progress && busy && <div className="knowledge-progress"><span>{progress.message}</span><b>{progress.total ? `${progress.current}/${progress.total}` : progress.stage}</b></div>}
      <div className="knowledge-manager-body">
        <section className="knowledge-manager-column">
          <div className="knowledge-manager-heading"><span>待处理</span><b>{pending.length}</b></div>
          <div className="knowledge-manager-scroll">
            {pending.map(item => <article className="knowledge-manager-pending" key={item.path}>
              <div><b>{item.title}</b><span title={item.path}>{item.path}</span></div>
              <em className={`knowledge-file-state ${item.state}`}>{item.state === "changed" ? "内容已更新" : "尚未索引"}</em>
              <div><button disabled={busy} onClick={() => void analyze(item.path)}>识别结构</button><IconButton title="删除工作区副本" onClick={() => void deletePending(item)}><Trash2 size={13} /></IconButton></div>
            </article>)}
            {!pending.length && <div className="knowledge-manager-empty"><Check size={20} /><span>没有待处理文档</span></div>}
          </div>
        </section>
        <section className="knowledge-manager-column indexed">
          <div className="knowledge-manager-heading"><span>已入库</span><b>{documents.length}</b></div>
          <div className="knowledge-manager-scroll">
            {groups.map(group => <div className="knowledge-manager-group" key={group.id}>
              <div className="knowledge-section-heading"><div>{group.id === "local" ? <FolderSearch size={14} /> : <Globe2 size={14} />}<b>{group.label}</b><span>{group.documents.length}</span></div></div>
              {group.documents.map(document => <article className="knowledge-document" key={document.id}>
                <div className="knowledge-document-head">
                  <button className="knowledge-expand" title="展开章节" onClick={() => void toggleDocument(document.id)}>{expanded.has(document.id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
                  <div><b>{document.title}</b><span>{document.sectionCount} 章 · {document.chunkCount} 片</span><code title={document.location}>{document.location}</code></div>
                  <em className={`knowledge-status ${document.status}`}>{document.status === "ready" ? "已就绪" : document.status === "partial" ? "部分失败" : "待增强"}</em>
                </div>
                {document.error && <p className="knowledge-error">{document.error}</p>}
                <div className="source-item-actions knowledge-actions">
                  <button onClick={() => void previewDocument(document)}><Eye size={12} />预览全文</button>
                  {document.sourceUrl && <button onClick={() => void openExternalUrl(document.sourceUrl!)}><ExternalLink size={12} />原网页</button>}
                  {document.sourceType === "markdown" && <button disabled={busy} onClick={() => void analyze(document.location)}>重新识别</button>}
                  {document.sourceType === "markdown" && <button disabled={busy} onClick={() => void rebuild(document)}>重建索引</button>}
                  {document.sourceType === "markdown" && <button disabled={busy} onClick={() => void restore(document)}>恢复原文</button>}
                  {document.status !== "ready" && <button disabled={busy} onClick={() => { if (!project.workspace) return; setBusy(true); void retryKnowledgeEnrichment(project.workspace, document.id, project.model).then(reload).catch((e: any) => notify(e?.message ?? "重试失败")).finally(() => setBusy(false)); }}>重试增强</button>}
                  <button onClick={() => { if (!project.workspace || !confirm(`从知识库移出“${document.title}”？原始 Markdown 会保留。`)) return; void removeKnowledgeDocument(project.workspace, document.id).then(reload).catch((e: any) => notify(e?.message ?? "移出失败")); }}>移出</button>
                  <button className="danger" disabled={busy} onClick={() => void deleteIndexed(document)}><Trash2 size={12} />删除</button>
                </div>
                {expanded.has(document.id) && <div className="knowledge-tree">{(sections[document.id] ?? []).map(section => <div className="knowledge-manager-section" key={section.id} style={{ paddingLeft: `${8 + Math.max(0, section.level - 1) * 14}px` }}><i>H{section.level || 1}</i><span>{section.title}</span><small>{headingSourceLabel(section.headingSource)}</small><IconButton title="预览知识片段" onClick={() => void previewSection(document, section)}><Eye size={13} /></IconButton><em>{section.chunkCount}</em></div>)}</div>}
              </article>)}
            </div>)}
            {!documents.length && <div className="knowledge-manager-empty"><BookOpen size={20} /><span>暂无已入库文档</span></div>}
          </div>
        </section>
      </div>
    </div>
    {headingReview && <HeadingReviewModal result={headingReview} candidates={headingCandidates} setCandidates={setHeadingCandidates} busy={busy} close={() => { if (!busy) { setHeadingReview(null); setHeadingCandidates([]); } }} confirm={() => void confirmReview()} />}
    {preview && <SourcePreviewModal source={preview.source} markdown={preview.markdown} loading={preview.loading} error={preview.error} workspaceRoot={project.workspace?.root} notify={notify} close={() => setPreview(null)} />}
  </div>;
}

function RightPanel({ tab, setTab, project, block, updateProject, updateBlock, notify, openSettings, close, openSource, refreshLibrary, terminalCwd, previewSource, setPreviewSource, previewMarkdown, setPreviewMarkdown, previewLoading, setPreviewLoading, previewError, setPreviewError }: any) {
  const [instruction, setInstruction] = useState("使表述更专业、具体，并补充必要的实施约束");
  const [aiUseContext, setAiUseContext] = useState(true);
  const [manualContextOpen, setManualContextOpen] = useState(false);
  const [manualContextTitle, setManualContextTitle] = useState("");
  const [manualContextContent, setManualContextContent] = useState("");
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [knowledgeQualityFilters, setKnowledgeQualityFilters] = useState<Set<KnowledgeChunkQuality>>(() => new Set(["good", "normal"]));
  const [webQuery, setWebQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchAttempted, setSearchAttempted] = useState(false);
  const [sourceContents, setSourceContents] = useState<Record<string, string>>({});
  const [localSearching, setLocalSearching] = useState(false);
  const [knowledgeResults, setKnowledgeResults] = useState<KnowledgeSearchResult[]>([]);
  const [knowledgeChunks, setKnowledgeChunks] = useState<Record<string, KnowledgeChunk>>({});
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [commandOutputs, setCommandOutputs] = useState<Record<string, CommandResult | { error: string }>>({});
  const [toolPaths, setToolPaths] = useState<Record<string, string>>({});
  const [installingAgentId, setInstallingAgentId] = useState<AgentToolId | null>(null);
  const [installOutputs, setInstallOutputs] = useState<Partial<Record<AgentToolId, CommandResult | { error: string }>>>({});
  const [agentId, setAgentId] = useState<AgentToolId>("claude");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentRunning, setAgentRunning] = useState(false);
  const [cliUseContext, setCliUseContext] = useState(true);
  const [agentResult, setAgentResult] = useState<CommandResult | { error: string } | null>(null);
  const desktop = isDesktop();
  const selectedAgent = agentTools.find(t => t.id === agentId) ?? agentTools[0];
  const contextSources = useMemo(() => project.sources.filter((s: SourceRecord) => block.sourceRefs.includes(s.id)), [project.sources, block.sourceRefs]);
  const context = useMemo(() => contextSources.map((s: SourceRecord) => {
    const chunk = knowledgeChunks[s.id];
    return chunk ? `${chunk.documentTitle} / ${chunk.headingPath}:\n${chunk.content}` : `${s.title}:\n${s.content ?? s.excerpt}`;
  }), [contextSources, knowledgeChunks]);
  const filteredSources = useMemo(
    () => (project.sources as SourceRecord[]).filter(s => matchesSource(s, query, sourceContents[s.id] ?? "")),
    [project.sources, query, sourceContents],
  );

  useEffect(() => {
    if (!desktop || tab !== "sources" || !query.trim()) return;
    const pending = (project.sources as SourceRecord[]).filter(source => source.kind === "local" && !Object.prototype.hasOwnProperty.call(sourceContents, source.id));
    if (!pending.length) return;
    let cancelled = false;
    setLocalSearching(true);
    Promise.all(pending.map(async source => {
      try { return [source.id, await readTextFile(source.location)] as const; }
      catch { return [source.id, ""] as const; }
    })).then(entries => {
      if (!cancelled) setSourceContents(current => ({ ...current, ...Object.fromEntries(entries) }));
    }).finally(() => { if (!cancelled) setLocalSearching(false); });
    return () => { cancelled = true; };
  }, [desktop, tab, query, project.sources, sourceContents]);

  useEffect(() => {
    if (!desktop || !project.workspace?.root) return;
    const ids = (block.sourceRefs as string[]).filter(id => id.startsWith("kc-") && !knowledgeChunks[id]);
    if (!ids.length) return;
    void Promise.all(ids.map(id => getKnowledgeChunk(project.workspace, id).catch(() => null))).then(chunks => {
      const available = chunks.filter((chunk): chunk is KnowledgeChunk => chunk !== null);
      setKnowledgeChunks(current => ({ ...current, ...Object.fromEntries(available.map(chunk => [chunk.id, chunk])) }));
    });
  }, [desktop, project.workspace?.root, block.sourceRefs]);

  useEffect(() => {
    if (!desktop) return;
    detectTools().then(setToolPaths).catch(() => setToolPaths({}));
  }, [desktop]);
  useEffect(() => {
    setAgentPrompt(defaultAgentPrompt(project, block));
    setAgentResult(null);
  }, [block.content, project.name]);

  const runAi = async () => { setLoading(true); try { setDraft(await improveBlock(block, instruction, aiUseContext ? context : [], project.model)); } catch (e: any) { notify(e.message); } finally { setLoading(false); } };
  const runWebSearch = async () => {
    if (!webQuery.trim()) return;
    if (!confirm(`即将向 ${project.search.provider} 发送查询：\n\n${webQuery}`)) return;
    setSearching(true);
    setSearchAttempted(true);
    try { setResults(await searchWeb(webQuery, project.search)); } catch (e: any) { notify(e.message); } finally { setSearching(false); }
  };
  const updateSourceContext = (sourceId: string, source?: SourceRecord, mode: "add" | "remove" | "toggle" = "add") => {
    updateProject((p: Project) => {
      const currentRefs = p.sections[0]?.blocks[0]?.sourceRefs ?? [];
      const included = currentRefs.includes(sourceId);
      const shouldInclude = mode === "toggle" ? !included : mode === "add";
      const sourceRefs = shouldInclude
        ? (included ? currentRefs : [...currentRefs, sourceId])
        : currentRefs.filter((id: string) => id !== sourceId);
      const sources = source && !p.sources.some((item: SourceRecord) => item.id === source.id)
        ? [...p.sources, source]
        : p.sources;
      const sections = p.sections.map((section, sectionIndex) => sectionIndex === 0 ? {
        ...section,
        blocks: section.blocks.map((item, blockIndex) => blockIndex === 0 ? { ...item, sourceRefs } : item),
      } : section);
      return { ...p, sources, sections };
    });
  };
  const saveResult = (r: SearchResult, includeInContext = false) => {
    const existing = (project.sources as SourceRecord[]).find(source => source.kind === "web" && source.location === r.url);
    const source = existing ?? { id: makeId(), kind: "web" as const, title: r.title, location: r.url, excerpt: r.excerpt, fingerprint: btoa(unescape(encodeURIComponent(r.url))).slice(0, 32), accessedAt: new Date().toISOString() };
    if (includeInContext) {
      updateSourceContext(source.id, source);
      notify(existing ? "来源已加入上下文" : "来源已保存并加入上下文");
      return;
    }
    if (!existing) updateProject((p: Project) => ({ ...p, sources: [...p.sources, source] }));
    notify(existing ? "该来源已保存" : "来源已保存");
  };
  const removeFromContext = (sourceId: string) => updateSourceContext(sourceId, undefined, "remove");
  const addManualContext = () => {
    const content = manualContextContent.trim();
    if (!content) return notify("请先填写上下文内容");
    const title = manualContextTitle.trim() || "手动添加的内容";
    const source: SourceRecord = {
      id: makeId(),
      kind: "manual",
      title,
      location: "手动添加",
      excerpt: content.replace(/\s+/g, " ").slice(0, 180),
      content,
      fingerprint: `manual-${makeId()}`,
      accessedAt: new Date().toISOString(),
    };
    updateSourceContext(source.id, source);
    setManualContextTitle("");
    setManualContextContent("");
    setManualContextOpen(false);
    notify("内容已加入上下文");
  };
  const openWebSource = async (url: string) => {
    try { await openExternalUrl(url); } catch (e: any) { notify(e?.message ?? "无法打开来源链接"); }
  };
  const openSourcePreview = async (source: SourceRecord) => {
    setPreviewSource(source);
    setPreviewMarkdown("");
    setPreviewError("");
    if (source.kind === "manual") {
      setPreviewMarkdown(source.content ?? source.excerpt);
      return;
    }
    if (source.kind === "web") {
      setPreviewMarkdown(`# ${source.title}\n\n${source.excerpt || ""}\n\n[打开网页](${source.location})`);
      return;
    }
    if (!desktop) {
      setPreviewError("本地资料预览仅在桌面端可用");
      return;
    }
    if (!source.location) {
      setPreviewError("缺少资料文件路径");
      return;
    }
    setPreviewLoading(true);
    try {
      const text = await readTextFile(source.location);
      setPreviewMarkdown(text);
    } catch (e: any) {
      setPreviewError(e?.message ?? "读取资料失败");
    } finally {
      setPreviewLoading(false);
    }
  };
  const runTask = async (command: Project["commands"][number]) => {
    if (!desktop) return notify("请在 Tauri 桌面端运行此任务");
    setRunningId(command.id);
    try {
      const result = await runCommand(command);
      setCommandOutputs(prev => ({ ...prev, [command.id]: result }));
      notify(result.exitCode === 0 ? `${command.name} 完成` : `${command.name} 退出码 ${result.exitCode}`);
    } catch (e: any) {
      setCommandOutputs(prev => ({ ...prev, [command.id]: { error: e?.message ?? String(e) } }));
      notify(e?.message ?? "任务执行失败");
    } finally {
      setRunningId(null);
    }
  };
  const runAgent = async () => {
    if (!desktop) return notify("请在 Tauri 桌面端运行此任务");
    if (!agentPrompt.trim()) return notify("请先填写提示词");
    if (!toolPaths[selectedAgent.program]) return notify(`未检测到 ${selectedAgent.name}，请先安装并加入 PATH`);
    setAgentRunning(true);
    setAgentResult(null);
    try {
      const prompt = withAgentContext(agentPrompt, context, cliUseContext);
      const command = buildAgentCommand(selectedAgent, prompt, terminalCwd || ".");
      const result = await runCommand(command);
      setAgentResult(result);
      notify(result.exitCode === 0 ? `${selectedAgent.name} 完成` : `${selectedAgent.name} 退出码 ${result.exitCode}`);
    } catch (e: any) {
      setAgentResult({ error: e?.message ?? String(e) });
      notify(e?.message ?? "Agent 执行失败");
    } finally {
      setAgentRunning(false);
    }
  };
  const addKnowledgeChunkToContext = (chunk: KnowledgeChunk) => {
    const source: SourceRecord = {
      id: chunk.id,
      kind: "local",
      title: chunk.documentTitle,
      location: `knowledge:${chunk.documentId}`,
      excerpt: chunk.summary || chunk.content.slice(0, 280),
      fingerprint: chunk.id,
      accessedAt: new Date().toISOString(),
      heading: chunk.headingPath,
    };
    setKnowledgeChunks(current => ({ ...current, [chunk.id]: chunk }));
    updateSourceContext(chunk.id, source, "toggle");
  };
  const previewKnowledgeChunk = (chunk: KnowledgeChunk) => {
    setKnowledgeChunks(current => ({ ...current, [chunk.id]: chunk }));
    setPreviewSource({ id: chunk.id, kind: "local", title: chunk.documentTitle, location: `knowledge:${chunk.documentId}`, excerpt: chunk.summary, fingerprint: chunk.id, accessedAt: new Date().toISOString(), heading: chunk.headingPath });
    setPreviewMarkdown(`# ${chunk.documentTitle}\n\n## ${chunk.headingPath}\n\n${chunk.content}`);
    setPreviewError(""); setPreviewLoading(false);
  };
  const runKnowledgeSearch = async () => {
    if (!query.trim() || !project.workspace) { setKnowledgeResults([]); return; }
    setLocalSearching(true);
    try { setKnowledgeResults(await searchKnowledge(project.workspace, query, ["good", "normal", "bad"].filter((quality): quality is KnowledgeChunkQuality => knowledgeQualityFilters.has(quality as KnowledgeChunkQuality)))); }
    catch (e: any) { notify(e?.message ?? "知识库搜索失败"); }
    finally { setLocalSearching(false); }
  };
  const toggleKnowledgeQualityFilter = (quality: KnowledgeChunkQuality) => {
    setKnowledgeQualityFilters(current => {
      if (current.has(quality) && current.size === 1) return current;
      const next = new Set(current);
      if (next.has(quality)) next.delete(quality); else next.add(quality);
      return next;
    });
  };
  const markKnowledgeQuality = async (chunk: KnowledgeChunk, quality: KnowledgeChunkQuality) => {
    if (!project.workspace || chunk.quality === quality) return;
    try {
      const updated = await setKnowledgeChunkQuality(project.workspace, chunk.id, quality);
      setKnowledgeChunks(current => ({ ...current, [updated.id]: updated }));
      const qualities = (["good", "normal", "bad"] as KnowledgeChunkQuality[]).filter(item => knowledgeQualityFilters.has(item));
      setKnowledgeResults(await searchKnowledge(project.workspace, query, qualities));
      notify(`已标记为${quality === "good" ? "优质" : quality === "bad" ? "劣质" : "普通"}片段`);
    } catch (e: any) { notify(e?.message ?? "更新片段质量失败"); }
  };
  const saveWebToKnowledge = async (result: SearchResult) => {
    if (!project.workspace) return notify("请先配置工作目录");
    setKnowledgeBusy(true);
    try { await importKnowledgeWeb(project.workspace, result.url, project.model); notify("网页全文已存入知识库"); }
    catch (e: any) { notify(e?.message ?? "网页入库失败"); }
    finally { setKnowledgeBusy(false); }
  };
  const installAgent = async (tool: (typeof agentTools)[number]) => {
    if (!desktop) return notify("请在 Tauri 桌面端安装 CLI 工具");
    setInstallingAgentId(tool.id);
    setInstallOutputs(current => ({ ...current, [tool.id]: undefined }));
    try {
      const result = await runCommand(buildAgentInstallCommand(tool));
      setInstallOutputs(current => ({ ...current, [tool.id]: result }));
      if (result.exitCode !== 0) {
        notify(`${tool.name} 安装失败，退出码 ${result.exitCode}`);
        return;
      }
      setToolPaths(await detectTools());
      notify(`${tool.name} 已安装`);
    } catch (e: any) {
      const error = e?.message ?? String(e);
      setInstallOutputs(current => ({ ...current, [tool.id]: { error } }));
      notify(error);
    } finally {
      setInstallingAgentId(null);
    }
  };
  const applyAgentOutput = () => {
    if (!agentResult || "error" in agentResult) return;
    const text = (agentResult.stdout || "").trim();
    if (!text) return notify("没有可应用的输出");
    updateBlock((b: DocumentBlock) => ({ ...b, content: text, status: "review" as const }));
    notify("已写入当前章节");
  };

  return <aside className="right-panel">
    <div className="inspector-top">
      <div className="tabs">
        <button className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}><Sparkles size={15} />AI</button>
        <button className={tab === "commands" ? "active" : ""} onClick={() => setTab("commands")}><TerminalSquare size={15} />CLI</button>
        <button className={tab === "context" ? "active" : ""} onClick={() => setTab("context")}><Layers3 size={15} />上下文</button>
        <button className={tab === "sources" ? "active" : ""} onClick={() => setTab("sources")}><BookOpen size={15} />知识库</button>
        <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}><Search size={15} />联网</button>
        <button className={tab === "env" ? "active" : ""} onClick={() => setTab("env")}><Command size={15} />环境检查</button>
      </div>
      <IconButton title="关闭侧栏" onClick={close}><PanelRightClose size={17} /></IconButton>
    </div>
    {tab === "ai" && <div className="inspector-content">
      <div className="context-line"><span><Bot size={17} />{project.model.model}</span><button onClick={openSettings}>配置</button></div>
      <label>编辑要求<textarea value={instruction} onChange={e => setInstruction(e.target.value)} /></label>
      <label className="context-box context-send-toggle"><span><input type="checkbox" checked={aiUseContext} onChange={e => setAiUseContext(e.target.checked)} />发送上下文</span><b>{aiUseContext ? `${context.length} 条引用 + 当前章节` : "仅当前章节"}</b></label>
      <button className="primary" onClick={runAi} disabled={loading}>{loading ? "正在生成…" : <><Sparkles size={16} />优化当前章节</>}</button>
      {draft && <div className="diff"><div className="diff-title"><span>修改建议</span><button onClick={() => setDraft(null)}><X size={14} /></button></div><div className="removed">{draft.before || "（空内容）"}</div><div className="added">{draft.after}</div><div className="diff-actions"><button onClick={() => setDraft(null)}>拒绝</button><button onClick={() => { updateBlock((b: DocumentBlock) => ({ ...b, content: draft.after })); setDraft(null); notify("修改已应用"); }}><Check size={14} />接受修改</button></div></div>}
    </div>}
    {tab === "commands" && <div className="inspector-content cli-task-panel">
      <div className="context-line cli-task-context">
        <span><TerminalSquare size={17} />本地任务</span>
        <em title={terminalCwd}>{terminalCwd || "."}</em>
      </div>
      <div className="agent-tools" role="group" aria-label="选择 Agent CLI">
        {agentTools.map(tool => {
          const ready = Boolean(toolPaths[tool.program]);
          return <button
            type="button"
            key={tool.id}
            className={`agent-chip ${agentId === tool.id ? "active" : ""} ${ready ? "ready" : "missing"}`}
            onClick={() => setAgentId(tool.id)}
          >
            <span>{tool.name}</span><em>{ready ? "可用" : "未安装"}</em>
          </button>;
        })}
      </div>
      <label className="cli-task-prompt">任务提示词
        <textarea value={agentPrompt} onChange={e => setAgentPrompt(e.target.value)} spellCheck={false} />
      </label>
      <div className="cli-command-preview">
        <code>{selectedAgent.program} {selectedAgent.id === "claude" ? "-p" : selectedAgent.id === "codex" ? "exec" : "run"}</code>
        <span>{Math.round(selectedAgent.timeoutMs / 1000)}s</span>
      </div>
      <label className="cli-context-toggle"><span><input type="checkbox" checked={cliUseContext} onChange={e => setCliUseContext(e.target.checked)} />携带上下文</span><b>{cliUseContext ? `${context.length} 条` : "不发送"}</b></label>
      <div className="agent-actions">
        <button type="button" onClick={() => setAgentPrompt(defaultAgentPrompt(project, block))} disabled={agentRunning}>重置任务</button>
        <button className="primary" type="button" onClick={() => void runAgent()} disabled={agentRunning || !toolPaths[selectedAgent.program]}>{agentRunning ? "执行中…" : "执行本地任务"}</button>
      </div>
      {agentResult && <div className="cli-task-result">
        {"error" in agentResult ? <pre className="command-output error">{agentResult.error}</pre> : <>
          <div className="cli-result-meta"><span>退出码 {agentResult.exitCode}</span><span>{agentResult.durationMs}ms</span></div>
          {agentResult.stdout && <><b>标准输出</b><pre className="command-output">{agentResult.stdout.trim()}</pre></>}
          {agentResult.stderr && <><b>错误输出</b><pre className="command-output error">{agentResult.stderr.trim()}</pre></>}
          {!agentResult.stdout && !agentResult.stderr && <p className="muted">任务完成，无输出。</p>}
          {agentResult.exitCode === 0 && agentResult.stdout.trim() && <button type="button" className="apply-agent-output" onClick={applyAgentOutput}><Check size={14} />写入当前章节</button>}
        </>}
      </div>}
    </div>}
    {tab === "context" && <div className="inspector-content context-manager">
      <div className="context-manager-head">
        <div><Layers3 size={17} /><span>已选上下文</span><b>{contextSources.length}</b></div>
        <div className="context-manager-actions">
          <button type="button" className="context-add-action" onClick={() => setManualContextOpen(open => !open)}><Pencil size={13} />手动添加</button>
          <button type="button" className="context-clear-action" disabled={!contextSources.length} onClick={() => updateBlock((b: DocumentBlock) => ({ ...b, sourceRefs: [] }))}><Trash2 size={13} />清空</button>
        </div>
      </div>
      {manualContextOpen && <div className="manual-context-form">
        <label>名称（可选）<input value={manualContextTitle} onChange={event => setManualContextTitle(event.target.value)} placeholder="例如：客户访谈补充" /></label>
        <label>内容<textarea autoFocus value={manualContextContent} onChange={event => setManualContextContent(event.target.value)} placeholder="粘贴或输入需要随当前章节发送的内容" /></label>
        <div><button type="button" onClick={() => { setManualContextOpen(false); setManualContextTitle(""); setManualContextContent(""); }}>取消</button><button type="button" className="primary" disabled={!manualContextContent.trim()} onClick={addManualContext}><Layers3 size={13} />加入上下文</button></div>
      </div>}
      <div className="context-source-list">
        {contextSources.map((source: SourceRecord, index: number) => <article key={source.id}>
          <div className="context-source-index">{String(index + 1).padStart(2, "0")}</div>
          <div className="context-source-body">
            <span>{source.kind === "web" ? <Globe2 size={13} /> : source.kind === "manual" ? <Pencil size={13} /> : <FolderSearch size={13} />}{source.kind === "web" ? "网页来源" : source.kind === "manual" ? "手动内容" : "本地资料"}</span>
            <b>{source.title}</b>
            <p>{source.excerpt || "（无摘要）"}</p>
            <div>
              <button type="button" onClick={() => void openSourcePreview(source)}>预览</button>
              <button type="button" onClick={() => removeFromContext(source.id)}>移除</button>
            </div>
          </div>
        </article>)}
        {!contextSources.length && <div className="context-empty"><Layers3 size={24} /><span>暂无上下文</span></div>}
      </div>
    </div>}
    {tab === "sources" && <div className="inspector-content sources-panel knowledge-panel">
      {!desktop ? <div className="context-empty"><BookOpen size={24} /><span>知识库仅在桌面端可用</span></div> : <>
      <div className="knowledge-search-intro"><div><Search size={17} /><b>知识检索</b></div><span>搜索结果可预览并加入当前章节上下文</span></div>
      <div className="search-row">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && void runKnowledgeSearch()}
          placeholder="搜索正文、章节、摘要和关键词"
        />
        <button type="button" title="搜索知识库" onClick={() => void runKnowledgeSearch()}><Search size={16} /></button>
      </div>
      <div className="knowledge-quality-filter" role="group" aria-label="片段质量筛选">
        <span>片段状态</span>
        {(["good", "normal", "bad"] as KnowledgeChunkQuality[]).map(quality => <label key={quality} className={knowledgeQualityFilters.has(quality) ? "active" : ""}>
          <input type="checkbox" checked={knowledgeQualityFilters.has(quality)} onChange={() => toggleKnowledgeQualityFilter(quality)} />
          {quality === "good" ? "优质" : quality === "bad" ? "劣质" : "普通"}
        </label>)}
      </div>
      {localSearching && <div className="loading-line">正在检索知识切片…</div>}
      {!!knowledgeResults.length && <div className="source-list knowledge-results">
        {knowledgeResults.map(({ chunk, excerpt }) => <article key={chunk.id}>
          <div><FolderSearch size={14} /><span>{chunk.headingPath}</span><em className={`knowledge-quality-badge ${chunk.quality}`}>{chunk.quality === "good" ? "优质" : chunk.quality === "bad" ? "劣质" : "普通"}</em></div><b>{chunk.documentTitle}</b><p>{excerpt}</p>
          <div className="knowledge-result-footer">
            <div className="source-item-actions"><button onClick={() => previewKnowledgeChunk(chunk)}>预览</button><button className={block.sourceRefs.includes(chunk.id) ? "context-added" : ""} onClick={() => addKnowledgeChunkToContext(chunk)}>{block.sourceRefs.includes(chunk.id) ? <><Check size={12} />已加入上下文</> : <><Layers3 size={12} />加入上下文</>}</button></div>
            <div className="knowledge-quality-actions" role="group" aria-label="标记片段质量">
              <IconButton title="标记为优质" active={chunk.quality === "good"} onClick={() => void markKnowledgeQuality(chunk, "good")}><ThumbsUp size={13} /></IconButton>
              <IconButton title="标记为普通" active={chunk.quality === "normal"} onClick={() => void markKnowledgeQuality(chunk, "normal")}><Minus size={13} /></IconButton>
              <IconButton title="标记为劣质" active={chunk.quality === "bad"} onClick={() => void markKnowledgeQuality(chunk, "bad")}><ThumbsDown size={13} /></IconButton>
            </div>
          </div>
        </article>)}
      </div>
      }
      {!localSearching && !knowledgeResults.length && <div className="knowledge-search-empty"><BookOpen size={25} /><b>{query.trim() ? "没有匹配结果" : "输入关键词检索知识库"}</b><span>{query.trim() ? "尝试更短的关键词或章节名称" : "检索正文、章节、摘要和关键词"}</span></div>}
      </>}
    </div>}
    {tab === "search" && <div className="inspector-content sources-panel">
      <div className="search-row">
        <input value={webQuery} onChange={e => setWebQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && void runWebSearch()} placeholder="联网搜索关键词" />
        <button onClick={() => void runWebSearch()}><Search size={16} /></button>
      </div>
      {searching && <div className="loading-line">正在联网检索…</div>}
      {results.length > 0 && <div className="source-list">
        {results.map(r => {
          const savedSource = (project.sources as SourceRecord[]).find(source => source.kind === "web" && source.location === r.url);
          const saved = Boolean(savedSource);
          const included = Boolean(savedSource && block.sourceRefs.includes(savedSource.id));
          let host = r.url;
          try { host = new URL(r.url).hostname; } catch { /* keep raw URL */ }
          return <article key={r.url}>
            <div><Globe2 size={15} /><span>{host}</span></div>
            <b>{r.title}</b><p>{r.excerpt}</p>
            <div className="source-item-actions">
              <button type="button" onClick={() => void openWebSource(r.url)}><ExternalLink size={12} />打开网页</button>
              <button type="button" disabled={knowledgeBusy} onClick={() => void saveWebToKnowledge(r)}>存入知识库</button>
              <button type="button" disabled={included} onClick={() => saveResult(r, true)}>{included ? "已在上下文" : "加入上下文"}</button>
            </div>
          </article>;
        })}
      </div>}
      {!results.length && !searching && <p className="muted">{searchAttempted ? "搜索完成，没有返回结果（搜索引擎可能受限或超时）" : "输入关键词后按 Enter 或点击搜索图标"}</p>}
    </div>}
    {tab === "env" && <div className="inspector-content">
      <div className="agent-title system-tasks"><Download size={15} />Agent CLI</div>
      <div className="installer-list">
        {agentTools.map(tool => {
          const installed = Boolean(toolPaths[tool.program]);
          const output = installOutputs[tool.id];
          const installing = installingAgentId === tool.id;
          return <div className={`installer-item ${installed ? "ready" : "missing"}`} key={tool.id}>
            <div className="installer-status"><span /><b>{tool.name}</b><em>{installed ? "已安装" : "未检测"}</em></div>
            <code title={installed ? toolPaths[tool.program] : undefined}>{installed ? toolPaths[tool.program] : `npm i -g ${tool.installPackage}`}</code>
            <button type="button" onClick={() => void installAgent(tool)} disabled={Boolean(installingAgentId)}>{installing ? "安装中…" : installed ? "更新" : "一键安装"}</button>
            {output && !("error" in output) && <pre className={`command-output ${output.exitCode === 0 ? "" : "error"}`}>{(output.stdout || output.stderr || `exit ${output.exitCode}`).trim()}</pre>}
            {output && "error" in output && <pre className="command-output error">{output.error}</pre>}
          </div>;
        })}
      </div>
      <div className="agent-title system-tasks"><Command size={15} />环境命令</div>
      {project.commands.length === 0 && <p className="muted">暂无环境检查任务</p>}
      {project.commands.map((c: Project["commands"][number]) => {
        const output = commandOutputs[c.id];
        return <div className="command-item" key={c.id}><Command size={16} /><div><b>{c.name}{toolPaths[c.program] ? "" : " · 未检测"}</b><code>{c.program} {c.args.join(" ")}</code>
          {output && !("error" in output) && <pre className="command-output">exit {output.exitCode} · {output.durationMs}ms{"\n"}{(output.stdout || output.stderr || "(无输出)").trim()}</pre>}
          {output && "error" in output && <pre className="command-output error">{output.error}</pre>}
        </div><button onClick={() => runTask(c)} disabled={runningId === c.id}>{runningId === c.id ? "运行中…" : "运行"}</button></div>;
      })}
    </div>}
  </aside>;
}

function SettingsModal({ project, close, save }: { project: Project; close: () => void; save: (p: Project) => void | Promise<void> }) {
  const [draft, setDraft] = useState(structuredClone(project));
  const desktop = isDesktop();
  const workspace = draft.workspace ?? { root: "", historyDir: "" };

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
    const title = kind === "root" ? "选择工作目录" : "选择历史资料目录";
    const path = await pickDirectory(title);
    if (!path) return;
    if (kind === "root") setWorkspace({ root: path });
    if (kind === "history") setWorkspace({ historyDir: path });
  };

  return <div className="modal-backdrop" onMouseDown={close}>
    <div className="modal wide" onMouseDown={e => e.stopPropagation()}>
      <div className="modal-title"><div><Settings size={19} /><span>连接、工作区与隐私</span></div><IconButton title="关闭" onClick={close}><X size={18} /></IconButton></div>
      <div className="notice"><Globe2 size={18} /><div><b>联网模型已启用</b><span>当前章节和明确选择的引用会发送至此服务。连接配置保存在工作区 <code>.gouan/connections.json</code>。</span></div><input type="checkbox" checked={draft.model.enabled} onChange={e => setDraft({ ...draft, model: { ...draft.model, enabled: e.target.checked } })} /></div>
      <div className="form-grid">
        <label>API 地址<input value={draft.model.baseUrl} onChange={e => setDraft({ ...draft, model: { ...draft.model, baseUrl: e.target.value } })} /></label>
        <label>模型名称<input value={draft.model.model} onChange={e => setDraft({ ...draft, model: { ...draft.model, model: e.target.value } })} /></label>
        <label className="wide">API Key<input type="password" value={draft.model.apiKey} placeholder="写入工作区 .gouan/connections.json" onChange={e => setDraft({ ...draft, model: { ...draft.model, apiKey: e.target.value } })} /></label>
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
      <div className="workspace-settings">
        <div className="agent-title"><FolderOpen size={15} /><span>工作区目录</span></div>
        <p className="muted">工作目录根下的 `.md` 是可打开/保存的方案正文；历史资料目录仅作引用材料库。粘贴图片会保存到工作目录 `assets/`。API / 搜索配置保存在工作目录 `.gouan/connections.json`（不进 localStorage）。</p>
        <label className="wide path-field">工作目录
          <div className="path-row">
            <input value={workspace.root} onChange={e => setWorkspace({ root: e.target.value })} placeholder="例如 D:\gouan-workspace" />
            <button disabled={!desktop} onClick={() => void browse("root")}>浏览</button>
          </div>
        </label>
        <label className="wide path-field">历史资料目录
          <div className="path-row">
            <input value={workspace.historyDir} onChange={e => setWorkspace({ historyDir: e.target.value })} placeholder="默认 <工作目录>/history" />
            <button disabled={!desktop} onClick={() => void browse("history")}>浏览</button>
          </div>
        </label>
        {!desktop && <p className="muted">浏览器模式无法选择真实磁盘目录；请使用桌面端。</p>}
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
