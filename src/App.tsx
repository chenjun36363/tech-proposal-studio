import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Bold, BookOpen, Bot, Check, ChevronDown, ChevronRight, ChevronUp, Code2, Command, Copy, Download, ExternalLink, Eye, FilePlus2, FolderOpen, FolderSearch, Globe2, Highlighter, Info, Italic, Layers3, Maximize2, Minimize2, Minus, Moon, MoreHorizontal, PanelRightClose, PanelRightOpen, Pencil, Redo2, RefreshCw, Replace, Save, Search, Settings, Sparkles, Strikethrough, Sun, TerminalSquare, ThumbsDown, ThumbsUp, Trash2, Undo2, X } from "lucide-react";
import { toggleTheme } from "./theme";
import { createProject, defaultWorkspaceFromRoot, makeId } from "./data";
import { exportMarkdown, loadProject, saveProject } from "./storage";
import { agentTools, buildAgentCommand, buildAgentInstallCommand, defaultAgentPrompt, withAgentContext, type AgentToolId } from "./agents";
import { detectTools, improveBlockStream, isDesktop, listModels, openExternalUrl, openWorkspacePowerShell, runCommand, runCommandStream, saveMarkdown, searchWeb } from "./services";
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
import { importWordOrPdfToWorkspace } from "./documentImport";
import {
  applyConnections,
  connectionsFromProject,
  loadWorkspaceConnections,
  saveWorkspaceConnections,
  syncConnectionSecrets,
} from "./connections";
import type { AiDraft, CommandResult, DocumentBlock, ModelOption, Project, SearchResult, SessionEvent, SourceRecord, WorkspaceMarkdownFile, WorkspacePaths } from "./types";
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

type RightTab = "ai" | "commands" | "context" | "sources" | "search";
type EditorMode = "section" | "full";
const RIGHT_PANEL_MIN = 280;
const RIGHT_PANEL_MAX = 720;
const RIGHT_PANEL_DEFAULT = 400;
const LEFT_PANEL_MIN = 180;
const LEFT_PANEL_MAX = 480;
const LEFT_PANEL_DEFAULT = 220;
const cleanCommandOutput = (value: string) => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim();
const KNOWLEDGE_SEARCH_FIELDS: Array<{ id: KnowledgeSearchField; label: string }> = [
  { id: "documentTitle", label: "标题" },
  { id: "headingPath", label: "章节" },
  { id: "content", label: "正文" },
];
type KnowledgeResultView = KnowledgeSearchResult & { scope: KnowledgeSectionScope; scopeHistory: KnowledgeSectionScope[] };

const scopeFromSearchResult = (result: KnowledgeSearchResult): KnowledgeSectionScope => {
  const title = result.chunk.headingPath.split(" > ").pop() || result.chunk.headingPath;
  const heading = result.level > 0 ? `${"#".repeat(Math.min(result.level, 6))} ${title}` : title;
  return {
    id: `kscope:${result.scopeSectionId}`,
    documentId: result.chunk.documentId,
    documentTitle: result.chunk.documentTitle,
    sectionId: result.scopeSectionId,
    parentId: result.parentId,
    title,
    headingPath: result.chunk.headingPath,
    level: result.level,
    content: result.chunk.content.trim() ? `${heading}\n\n${result.chunk.content.trim()}` : heading,
    sectionCount: 1,
    quality: result.chunk.quality,
    canMoveUp: result.canMoveUp,
  };
};

const chunkFromScope = (scope: KnowledgeSectionScope): KnowledgeChunk => ({
  id: scope.id,
  documentId: scope.documentId,
  sectionId: scope.sectionId,
  documentTitle: scope.documentTitle,
  headingPath: scope.headingPath,
  content: scope.content,
  position: 0,
  startChar: 0,
  endChar: scope.content.length,
  status: "ready",
  quality: scope.quality,
});
const resolveWorkspaceLocation = (root: string, location: string) => /^[a-zA-Z]:[\\/]|^\\\\/.test(location)
  ? location
  : `${root.replace(/[\\/]$/, "")}\\${location.replace(/\//g, "\\")}`;
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
type QuickLink = { id: string; title: string; url: string };
const QUICK_LINKS_KEY = "tech-proposal-studio.quicklinks.v1";
const DEFAULT_QUICK_LINKS: QuickLink[] = [
  { id: "mee-gov-cn", title: "生态环境部", url: "https://www.mee.gov.cn/" },
];
const loadQuickLinks = (): QuickLink[] => {
  try {
    const raw = localStorage.getItem(QUICK_LINKS_KEY);
    if (!raw) return DEFAULT_QUICK_LINKS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_QUICK_LINKS;
    return parsed as QuickLink[];
  } catch {
    return DEFAULT_QUICK_LINKS;
  }
};
const saveQuickLinks = (links: QuickLink[]) => {
  try { localStorage.setItem(QUICK_LINKS_KEY, JSON.stringify(links)); } catch { /* ignore */ }
};
const IconButton = ({ title, children, onClick, active = false, disabled = false }: { title: string; children: React.ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean }) => <button className={`icon-button ${active ? "active" : ""}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>;

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

function HeadingReviewModal({ result, candidates, setCandidates, busy, progress, busySeconds, close, confirm }: {
  result: HeadingDetectionResult;
  candidates: HeadingCandidate[];
  setCandidates: (items: HeadingCandidate[]) => void;
  busy: boolean;
  progress: KnowledgeProgress | null;
  busySeconds: number;
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
      {busy && progress && <div className="knowledge-progress heading-review-progress"><span>{progress.message}</span><b>{progress.total > 1 ? `${progress.current}/${progress.total}` : `已进行 ${busySeconds} 秒`}</b></div>}
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
  const [themeDark, setThemeDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [rightWidth, setRightWidth] = useState(RIGHT_PANEL_DEFAULT);
  const [leftWidth, setLeftWidth] = useState(LEFT_PANEL_DEFAULT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importingDoc, setImportingDoc] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [knowledgeManagerOpen, setKnowledgeManagerOpen] = useState(false);
  const [webSearchOpen, setWebSearchOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [envToolPaths, setEnvToolPaths] = useState<Record<string, string>>({});
  const [envCommandOutputs, setEnvCommandOutputs] = useState<Record<string, CommandResult | { error: string }>>({});
  const [envRunningId, setEnvRunningId] = useState<string | null>(null);
  const [envInstallingAgentId, setEnvInstallingAgentId] = useState<AgentToolId | null>(null);
  const [envInstallOutputs, setEnvInstallOutputs] = useState<Partial<Record<AgentToolId, CommandResult | { error: string }>>>({});
  const [toast, setToast] = useState("");
  const [exportMenu, setExportMenu] = useState(false);
  const [fileMenu, setFileMenu] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [workspaceDocs, setWorkspaceDocs] = useState<WorkspaceMarkdownFile[]>([]);
  const [knowledgeTransferPath, setKnowledgeTransferPath] = useState<string | null>(null);
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

  useEffect(() => {
    if (!desktop) return;
    detectTools().then(setEnvToolPaths).catch(() => setEnvToolPaths({}));
  }, [desktop]);

  const envInstallAgent = async (tool: (typeof agentTools)[number]) => {
    if (!desktop) return notify("请在 Tauri 桌面端安装 CLI 工具");
    setEnvInstallingAgentId(tool.id);
    setEnvInstallOutputs(current => ({ ...current, [tool.id]: undefined }));
    try {
      const result = await runCommand(buildAgentInstallCommand(tool));
      setEnvInstallOutputs(current => ({ ...current, [tool.id]: result }));
      if (result.exitCode !== 0) {
        notify(`${tool.name} 安装失败，退出码 ${result.exitCode}`);
        return;
      }
      setEnvToolPaths(await detectTools());
      notify(`${tool.name} 已安装`);
    } catch (e: any) {
      const error = e?.message ?? String(e);
      setEnvInstallOutputs(current => ({ ...current, [tool.id]: { error } }));
      notify(error);
    } finally {
      setEnvInstallingAgentId(null);
    }
  };

  const envRunTask = async (command: Project["commands"][number]) => {
    if (!desktop) return notify("请在 Tauri 桌面端运行此任务");
    setEnvRunningId(command.id);
    try {
      const result = await runCommand(command);
      setEnvCommandOutputs(prev => ({ ...prev, [command.id]: result }));
      notify(result.exitCode === 0 ? `${command.name} 完成` : `${command.name} 退出码 ${result.exitCode}`);
    } catch (e: any) {
      setEnvCommandOutputs(prev => ({ ...prev, [command.id]: { error: e?.message ?? String(e) } }));
      notify(e?.message ?? "任务执行失败");
    } finally {
      setEnvRunningId(null);
    }
  };

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

  const transferWorkspaceDocToKnowledge = async (doc: WorkspaceMarkdownFile) => {
    if (!desktop || !workspace) return notify("知识管理仅在桌面端可用");
    setKnowledgeTransferPath(doc.path);
    try {
      if (project.filePath === doc.path) {
        await writeTextFile(doc.path, exportMarkdown(project));
      }
      const imported = await moveWorkspaceMarkdownToKnowledge(workspace, doc.path);
      if (project.filePath === doc.path) {
        setProject(value => ({ ...value, filePath: undefined, updatedAt: new Date().toISOString() }));
      }
      await refreshWorkspaceDocs(workspace);
      await refreshLibrary(workspace);
      setKnowledgeManagerOpen(true);
      notify(`已移动到知识库：${imported.title}`);
    } catch (e: any) {
      notify(e?.message ?? "转入知识库失败");
    } finally {
      setKnowledgeTransferPath(null);
    }
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

  const importWordPdfFromDialog = async () => {
    if (!desktop) return notify("Word/PDF 导入仅在桌面端可用");
    const root = workspace?.root;
    if (!root) return notify("请先在设置中配置工作目录");
    // Reload connections from disk — project localStorage strips mineru.apiKey.
    const freshConn = await loadWorkspaceConnections(root);
    if (freshConn) {
      setProject(p => applyConnections(p, freshConn));
    }
    const sourcePath = await pickDocumentFile("选择要导入的 Word / PDF（推荐 .docx / .pdf）", root);
    if (!sourcePath) return;
    setImportingDoc(true);
    try {
      const { path, sourceFileName, assetRelativeDir } = await importWordOrPdfToWorkspace(
        sourcePath,
        root,
        freshConn?.mineru ?? project.mineru,
      );
      await openMarkdownPath(path);
      await refreshWorkspaceDocs();
      const assetsHint = assetRelativeDir ? `，图片 → ${assetRelativeDir}` : "";
      notify(`已通过 MinerU 导入：${sourceFileName} → ${path.split(/[\\/]/).pop()}${assetsHint}`);
    } catch (e: any) {
      notify(e?.message ?? "Word/PDF 导入失败");
    } finally {
      setImportingDoc(false);
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
    updateProject(p => {
      const currentMarkdown = p.markdown ?? "";
      const nextMarkdown = selectedHeading && editorMode === "section"
        ? replaceSection(currentMarkdown, selectedHeading, next.content)
        : next.content;
      // Keep sourceRefs on the first legacy block while Markdown remains body truth.
      const sections = p.sections[0]?.blocks[0]
        ? p.sections.map((section, sectionIndex) => sectionIndex === 0 ? {
          ...section,
          blocks: section.blocks.map((item, blockIndex) => blockIndex === 0 ? { ...item, sourceRefs: next.sourceRefs } : item),
        } : section)
        : p.sections;
      return {
        ...p,
        markdown: nextMarkdown,
        name: titleFromMarkdown(nextMarkdown, p.name),
        updatedAt: new Date().toISOString(),
        sections,
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
          title={themeDark ? "切换到亮色" : "切换到暗色"}
          onClick={() => setThemeDark(toggleTheme() === "dark")}
        >
          {themeDark ? <Sun size={18} /> : <Moon size={18} />}
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
            mineru: conn.mineru,
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
      refreshWorkspaceDocs={refreshWorkspaceDocs}
      openMarkdownPath={openMarkdownPath}
      notify={notify}
      close={() => setKnowledgeManagerOpen(false)}
    />}
    {webSearchOpen && <WebSearchModal
      project={project}
      block={activeBlock}
      updateProject={updateProject}
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
    {envOpen && <EnvModal
      desktop={desktop}
      project={project}
      toolPaths={envToolPaths}
      commandOutputs={envCommandOutputs}
      runningId={envRunningId}
      installingAgentId={envInstallingAgentId}
      installOutputs={envInstallOutputs}
      installAgent={envInstallAgent}
      runTask={envRunTask}
      close={() => setEnvOpen(false)}
    />}
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </div>;
}

function EnvModal({ desktop, project, toolPaths, commandOutputs, runningId, installingAgentId, installOutputs, installAgent, runTask, close }: {
  desktop: boolean;
  project: Project;
  toolPaths: Record<string, string>;
  commandOutputs: Record<string, CommandResult | { error: string }>;
  runningId: string | null;
  installingAgentId: AgentToolId | null;
  installOutputs: Partial<Record<AgentToolId, CommandResult | { error: string }>>;
  installAgent: (tool: (typeof agentTools)[number]) => void;
  runTask: (command: Project["commands"][number]) => void;
  close: () => void;
}) {
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="modal env-modal" onMouseDown={e => e.stopPropagation()}>
      <div className="modal-title">
        <div><Command size={18} /><span>环境检查</span></div>
        <IconButton title="关闭" onClick={close}><X size={17} /></IconButton>
      </div>
      <div className="env-modal-body">
        <div className="agent-title"><Download size={15} />Agent CLI</div>
        <div className="installer-list">
          {agentTools.map(tool => {
            const installed = Boolean(toolPaths[tool.program]);
            const output = installOutputs[tool.id];
            const installing = installingAgentId === tool.id;
            return <div className={`installer-item ${installed ? "ready" : "missing"}`} key={tool.id}>
              <div className="installer-status"><span /><b>{tool.name}</b><em>{installed ? "已安装" : "未检测"}</em></div>
              <code title={installed ? toolPaths[tool.program] : undefined}>{installed ? toolPaths[tool.program] : `npm i -g ${tool.installPackage}`}</code>
              <button type="button" onClick={() => installAgent(tool)} disabled={Boolean(installingAgentId)}>{installing ? "安装中…" : installed ? "更新" : "一键安装"}</button>
              {output && !("error" in output) && <pre className={`command-output ${output.exitCode === 0 ? "" : "error"}`}>{(output.stdout || output.stderr || `exit ${output.exitCode}`).trim()}</pre>}
              {output && "error" in output && <pre className="command-output error">{output.error}</pre>}
            </div>;
          })}
        </div>
        <div className="agent-title"><Command size={15} />环境命令</div>
        {project.commands.length === 0 && <p className="muted">暂无环境检查任务</p>}
        {project.commands.map((c: Project["commands"][number]) => {
          const output = commandOutputs[c.id];
          return <div className="command-item" key={c.id}><Command size={16} /><div><b>{c.name}{toolPaths[c.program] ? "" : " · 未检测"}</b><code>{c.program} {c.args.join(" ")}</code>
            {output && !("error" in output) && <pre className="command-output">exit {output.exitCode} · {output.durationMs}ms{"\n"}{(output.stdout || output.stderr || "(无输出)").trim()}</pre>}
            {output && "error" in output && <pre className="command-output error">{output.error}</pre>}
          </div><button onClick={() => runTask(c)} disabled={runningId === c.id}>{runningId === c.id ? "运行中…" : "运行"}</button></div>;
        })}
      </div>
    </div>
  </div>;
}

function KnowledgeManagerModal({ project, updateProject, updateBlock, refreshWorkspaceDocs, openMarkdownPath, notify, close }: any) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [pending, setPending] = useState<KnowledgeScanItem[]>([]);
  const [sections, setSections] = useState<Record<string, KnowledgeSection[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [busySeconds, setBusySeconds] = useState(0);
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
  useEffect(() => {
    if (!busy) { setBusySeconds(0); return; }
    const timer = window.setInterval(() => setBusySeconds(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const analyze = async (path: string) => {
    if (!project.workspace) return;
    setProgress({ documentId: "", stage: "structure_scanning", current: 0, total: 0, message: "正在本地扫描标题和章节结构…" });
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
    setProgress({ documentId: headingReview.documentId, stage: "normalization_preparing", current: 0, total: 0, message: "正在准备结构规范化…" });
    setBusy(true);
    const decisions: HeadingReviewDecision[] = headingCandidates.map(item => ({ id: item.id, line: item.line, selected: item.selected, level: item.level, source: item.source, confidence: item.confidence }));
    try { await applyKnowledgeHeadings(project.workspace, headingReview, decisions); setHeadingReview(null); setHeadingCandidates([]); await reload(); notify("文档结构已确认并入库"); }
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
  const restore = async (document: KnowledgeDocument) => {
    if (!project.workspace) return;
    setBusy(true);
    try {
      const backups = await listKnowledgeBackups(project.workspace, document.id);
      if (!backups.length) return notify("该文档没有可恢复的原始快照");
      if (!confirm(`恢复“${document.title}”到 ${backups[0].name}？当前规范化内容会被替换。`)) return;
      await restoreKnowledgeBackup(project.workspace, document.id, backups[0].path); await reload(); notify("已恢复原始版本并更新知识库");
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
  const returnPendingToWorkspace = async (item: KnowledgeScanItem) => {
    if (!project.workspace) return notify("请先配置工作目录");
    setBusy(true);
    try {
      const workspacePath = await importMarkdownToWorkspace(item.path, project.workspace.root);
      await deleteKnowledgeFile(project.workspace, item.path, item.documentId);
      await Promise.all([reload(), refreshWorkspaceDocs(project.workspace)]);
      notify(`已转回工作区：${workspacePath.split(/[\\/]/).pop()}`);
      await openMarkdownPath(workspacePath);
    } catch (e: any) {
      notify(e?.message ?? "转回工作区失败");
    } finally {
      setBusy(false);
    }
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
  const removeIndexed = async (document: KnowledgeDocument) => {
    if (!project.workspace || !confirm(`从知识库移出“${document.title}”？原始 Markdown 会保留。`)) return;
    setBusy(true);
    try {
      await removeKnowledgeDocument(project.workspace, document.id);
      await reload();
      notify("已从知识库移出，原始 Markdown 已保留");
    } catch (e: any) {
      notify(e?.message ?? "移出失败");
    } finally {
      setBusy(false);
    }
  };
  const previewDocument = async (document: KnowledgeDocument) => {
    const source: SourceRecord = { id: document.id, kind: "local", title: document.title, location: document.location, excerpt: "", fingerprint: document.fingerprint, accessedAt: new Date().toISOString() };
    setPreview({ source, markdown: "", loading: true, error: "" });
    try { const markdown = await readTextFile(resolveWorkspaceLocation(project.workspace.root, document.location)); setPreview({ source, markdown, loading: false, error: "" }); }
    catch (e: any) { setPreview({ source, markdown: "", loading: false, error: e?.message ?? "读取文档失败" }); }
  };
  const previewSection = async (document: KnowledgeDocument, section: KnowledgeSection) => {
    if (!project.workspace) return;
    const source: SourceRecord = { id: section.id, kind: "local", title: `${document.title} / ${section.title}`, location: document.location, excerpt: section.headingPath, fingerprint: section.id, accessedAt: new Date().toISOString(), heading: section.headingPath };
    setPreview({ source, markdown: "", loading: true, error: "" });
    try {
      const chunks = await listKnowledgeSectionChunks(project.workspace, section.id);
      const markdown = chunks.map(chunk => chunk.content).filter(Boolean).join("\n\n---\n\n");
      setPreview({ source, markdown: markdown || `# ${section.title}\n\n（该章节暂无正文）`, loading: false, error: "" });
    } catch (e: any) { setPreview({ source, markdown: "", loading: false, error: e?.message ?? "读取知识片段失败" }); }
  };
  const markSectionQuality = async (section: KnowledgeSection, quality: KnowledgeChunkQuality) => {
    if (!project.workspace || section.quality === quality) return;
    setBusy(true);
    try {
      await setKnowledgeSectionQuality(project.workspace, section.id, quality);
      setSections(current => ({ ...current, [section.documentId]: (current[section.documentId] ?? []).map(item => item.id === section.id ? { ...item, quality } : item) }));
      notify(`片段已标记为${quality === "good" ? "优质" : quality === "bad" ? "劣质" : "普通"}`);
    } catch (e: any) { notify(e?.message ?? "更新片段状态失败"); }
    finally { setBusy(false); }
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
      {progress && busy && !headingReview && <div className="knowledge-progress"><span>{progress.message}</span><b>{progress.stage === "structure_ai" ? `已等待 ${busySeconds} 秒` : progress.total > 1 ? `${progress.current}/${progress.total}` : `已进行 ${busySeconds} 秒`}</b></div>}
      <div className="knowledge-manager-body">
        <section className="knowledge-manager-column">
          <div className="knowledge-manager-heading"><span>待处理</span><b>{pending.length}</b></div>
          <div className="knowledge-manager-scroll">
            {pending.map(item => <article className="knowledge-manager-pending" key={item.path}>
              <div><b>{item.title}</b><span title={item.path}>{item.path}</span></div>
              <em className={`knowledge-file-state ${item.state}`}>{item.state === "changed" ? "内容已更新" : "尚未索引"}</em>
              <div className="knowledge-pending-actions">
                <button disabled={busy} onClick={() => void analyze(item.path)}>识别结构</button>
                <button disabled={busy} onClick={() => void returnPendingToWorkspace(item)}><Undo2 size={13} />转回工作区</button>
                <IconButton title="删除知识副本" disabled={busy} onClick={() => void deletePending(item)}><Trash2 size={13} /></IconButton>
              </div>
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
                  <em className="knowledge-status ready">已就绪</em>
                </div>
                {document.error && <p className="knowledge-error">{document.error}</p>}
                <div className="source-item-actions knowledge-actions">
                  <button onClick={() => void previewDocument(document)}><Eye size={12} />预览全文</button>
                  {document.sourceUrl && <button onClick={() => void openExternalUrl(document.sourceUrl!)}><ExternalLink size={12} />原网页</button>}
                  {document.sourceType === "markdown" && <button disabled={busy} onClick={() => void analyze(document.location)}>重新识别</button>}
                  {document.sourceType === "markdown" && <button disabled={busy} onClick={() => void restore(document)}>恢复原文</button>}
                  <button disabled={busy} onClick={() => void removeIndexed(document)}>移出</button>
                  <button className="danger" disabled={busy} onClick={() => void deleteIndexed(document)}><Trash2 size={12} />删除</button>
                </div>
                {expanded.has(document.id) && <div className="knowledge-tree">{(sections[document.id] ?? []).map(section => <div className="knowledge-manager-section" key={section.id} style={{ paddingLeft: `${8 + Math.max(0, section.level - 1) * 14}px` }}><i>H{section.level || 1}</i><span>{section.title}</span><small>{headingSourceLabel(section.headingSource)}</small><em className={`knowledge-quality-badge ${section.quality}`}>{section.quality === "good" ? "优质" : section.quality === "bad" ? "劣质" : "普通"}</em><div className="knowledge-manager-quality" role="group" aria-label={`${section.title}片段状态`}><IconButton title="标记为优质" active={section.quality === "good"} disabled={busy} onClick={() => void markSectionQuality(section, "good")}><ThumbsUp size={12} /></IconButton><IconButton title="标记为普通" active={section.quality === "normal"} disabled={busy} onClick={() => void markSectionQuality(section, "normal")}><Minus size={12} /></IconButton><IconButton title="标记为劣质" active={section.quality === "bad"} disabled={busy} onClick={() => void markSectionQuality(section, "bad")}><ThumbsDown size={12} /></IconButton></div><IconButton title="预览知识片段" onClick={() => void previewSection(document, section)}><Eye size={13} /></IconButton><em>{section.chunkCount}</em></div>)}</div>}
              </article>)}
            </div>)}
            {!documents.length && <div className="knowledge-manager-empty"><BookOpen size={20} /><span>暂无已入库文档</span></div>}
          </div>
        </section>
      </div>
    </div>
    {headingReview && <HeadingReviewModal result={headingReview} candidates={headingCandidates} setCandidates={setHeadingCandidates} busy={busy} progress={progress} busySeconds={busySeconds} close={() => { if (!busy) { setHeadingReview(null); setHeadingCandidates([]); } }} confirm={() => void confirmReview()} />}
    {preview && <SourcePreviewModal source={preview.source} markdown={preview.markdown} loading={preview.loading} error={preview.error} workspaceRoot={project.workspace?.root} notify={notify} close={() => setPreview(null)} />}
  </div>;
}

function WebSearchModal({ project, block, updateProject, notify, close }: any) {
  const [webQuery, setWebQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchAttempted, setSearchAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [quickLinks, setQuickLinks] = useState<QuickLink[]>(() => loadQuickLinks());
  const [showAddLink, setShowAddLink] = useState(false);
  const [newLinkTitle, setNewLinkTitle] = useState("");
  const [newLinkUrl, setNewLinkUrl] = useState("");

  const persistQuickLinks = (next: QuickLink[]) => {
    setQuickLinks(next);
    saveQuickLinks(next);
  };
  const openQuickLink = async (url: string) => {
    try { await openExternalUrl(url); } catch (e: any) { notify(e?.message ?? "无法打开链接"); }
  };
  const removeQuickLink = (id: string) => persistQuickLinks(quickLinks.filter(link => link.id !== id));
  const addQuickLink = () => {
    const url = newLinkUrl.trim();
    const title = newLinkTitle.trim() || url;
    if (!url) return;
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    if (quickLinks.some(link => link.url === normalized)) { notify("该链接已在常用列表中"); return; }
    persistQuickLinks([...quickLinks, { id: makeId(), title, url: normalized }]);
    setNewLinkTitle("");
    setNewLinkUrl("");
    setShowAddLink(false);
    notify("已添加到常用链接");
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
      const sections = p.sections.map((section: any, sectionIndex: number) => sectionIndex === 0 ? {
        ...section,
        blocks: section.blocks.map((item: any, blockIndex: number) => blockIndex === 0 ? { ...item, sourceRefs } : item),
      } : section);
      return { ...p, sources, sections };
    });
  };

  const runWebSearch = async () => {
    if (!webQuery.trim()) return;
    if (!confirm(`即将向 ${project.search.provider} 发送查询：\n\n${webQuery}`)) return;
    setSearching(true);
    setSearchAttempted(true);
    try { setResults(await searchWeb(webQuery, project.search)); } catch (e: any) { notify(e.message); } finally { setSearching(false); }
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

  const openWebSource = async (url: string) => {
    try { await openExternalUrl(url); } catch (e: any) { notify(e?.message ?? "无法打开来源链接"); }
  };

  const saveToKnowledge = async (result: SearchResult) => {
    if (!project.workspace) return notify("请先配置工作目录");
    setSaving(true);
    try { await importKnowledgeWeb(project.workspace, result.url); notify("网页全文已存入知识库"); }
    catch (e: any) { notify(e?.message ?? "网页入库失败"); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal wide web-search-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-title"><div><Globe2 size={19} /><span>联网搜索</span></div><IconButton title="关闭" onClick={close}><X size={18} /></IconButton></div>
        <div className="search-row">
          <input value={webQuery} onChange={e => setWebQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && void runWebSearch()} placeholder="联网搜索关键词" />
          <button onClick={() => void runWebSearch()}><Search size={16} /></button>
        </div>
        <section className="quick-links">
          <div className="quick-links-head">
            <span><Globe2 size={13} />常用链接</span>
            <button type="button" className="quick-link-add-btn" onClick={() => setShowAddLink(value => !value)}>{showAddLink ? "收起" : "添加"}</button>
          </div>
          <div className="quick-links-list">
            {quickLinks.map(link => {
              let host = link.url;
              try { host = new URL(link.url).hostname; } catch { /* keep raw url */ }
              return (
                <div key={link.id} className="quick-link-item" title={link.url}>
                  <button type="button" className="quick-link-open" onClick={() => void openQuickLink(link.url)}>
                    <Globe2 size={13} />
                    <span className="quick-link-title">{link.title}</span>
                    <span className="quick-link-host">{host}</span>
                  </button>
                  <button type="button" className="quick-link-remove" title="移除" onClick={() => removeQuickLink(link.id)}><X size={12} /></button>
                </div>
              );
            })}
            {quickLinks.length === 0 && <p className="muted quick-links-empty">暂无常用链接，点击“添加”加入常用网站</p>}
          </div>
          {showAddLink && (
            <div className="quick-link-form">
              <input value={newLinkTitle} onChange={e => setNewLinkTitle(e.target.value)} placeholder="名称（如 生态环境部）" />
              <input value={newLinkUrl} onChange={e => setNewLinkUrl(e.target.value)} onKeyDown={e => e.key === "Enter" && addQuickLink()} placeholder="网址 https://..." />
              <button type="button" className="primary" onClick={addQuickLink}>保存</button>
            </div>
          )}
        </section>
        <div className="web-search-body">
          {searching && <div className="loading-line">正在联网检索…</div>}
          {results.length > 0 && <div className="source-list">
            {results.map(r => {
              const savedSource = (project.sources as SourceRecord[]).find(source => source.kind === "web" && source.location === r.url);
              const included = Boolean(savedSource && block.sourceRefs.includes(savedSource.id));
              let host = r.url;
              try { host = new URL(r.url).hostname; } catch { /* keep raw URL */ }
              return <article key={r.url}>
                <div><Globe2 size={15} /><span>{host}</span></div>
                <button type="button" className="result-title" onClick={() => void openWebSource(r.url)}>{r.title}</button><p>{r.excerpt}</p>
                <div className="source-item-actions">
                  <button type="button" onClick={() => void openWebSource(r.url)}><ExternalLink size={12} />打开网页</button>
                  <button type="button" disabled={saving} onClick={() => void saveToKnowledge(r)}>存入知识库</button>
                  <button type="button" disabled={included} onClick={() => saveResult(r, true)}>{included ? "已在上下文" : "加入上下文"}</button>
                </div>
              </article>;
            })}
          </div>}
          {!results.length && !searching && <p className="muted">{searchAttempted ? "搜索完成，没有返回结果（搜索引擎可能受限或超时）" : "输入关键词后按 Enter 或点击搜索图标"}</p>}
        </div>
      </div>
    </div>
  );
}

function SessionTrace({ title, events, running }: { title: string; events: SessionEvent[]; running: boolean }) {
  const output = events.filter(event => event.kind === "output").map(event => event.content ?? "").join("");
  const steps = events.filter(event => event.kind !== "output");
  const outputRef = useRef<HTMLPreElement>(null);
  useEffect(() => { if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }, [output]);
  if (!events.length) return null;
  return <section className={`session-trace ${running ? "running" : ""}`} aria-live="polite">
    <header><span><Bot size={14} />{title}</span><em>{running ? <><RefreshCw className="spinning" size={12} />实时连接</> : "已结束"}</em></header>
    <div className="session-steps">{steps.map(event => <div className={`session-step ${event.kind}`} key={event.id}>
      <i>{event.kind === "done" ? <Check size={11} /> : event.kind === "error" ? <X size={11} /> : <span />}</i>
      <div><b>{event.label}</b>{event.content && <small>{event.content}</small>}</div>
    </div>)}</div>
    {(output || running) && <div className="session-output"><div><span>实时返回</span><b>{output.length.toLocaleString()} 字符</b></div><pre ref={outputRef}>{output || "等待首个响应片段…"}<span className="stream-caret" /></pre></div>}
  </section>;
}

function RightPanel({ tab, setTab, project, block, updateProject, updateBlock, notify, openSettings, close, openSource, refreshLibrary, terminalCwd, previewSource, setPreviewSource, previewMarkdown, setPreviewMarkdown, previewLoading, setPreviewLoading, previewError, setPreviewError }: any) {
  const [instruction, setInstruction] = useState("请结合上下文参考内容，帮我优化当前章节");
  const [aiUseContext, setAiUseContext] = useState(true);
  const [manualContextOpen, setManualContextOpen] = useState(false);
  const [manualContextTitle, setManualContextTitle] = useState("");
  const [manualContextContent, setManualContextContent] = useState("");
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [aiSession, setAiSession] = useState<SessionEvent[]>([]);
  const [query, setQuery] = useState("");
  const [knowledgeQualityFilters, setKnowledgeQualityFilters] = useState<Set<KnowledgeChunkQuality>>(() => new Set(["good", "normal"]));
  const [knowledgeSearchFields, setKnowledgeSearchFields] = useState<Set<KnowledgeSearchField>>(() => new Set(KNOWLEDGE_SEARCH_FIELDS.map(field => field.id)));
  const [sourceContents, setSourceContents] = useState<Record<string, string>>({});
  const [localSearching, setLocalSearching] = useState(false);
  const [knowledgeResults, setKnowledgeResults] = useState<KnowledgeResultView[]>([]);
  const [knowledgeChunks, setKnowledgeChunks] = useState<Record<string, KnowledgeChunk>>({});
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [toolPaths, setToolPaths] = useState<Record<string, string>>({});
  const [agentId, setAgentId] = useState<AgentToolId>("claude");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentRunning, setAgentRunning] = useState(false);
  const [cliUseContext, setCliUseContext] = useState(true);
  const [agentResult, setAgentResult] = useState<CommandResult | { error: string } | null>(null);
  const [agentSession, setAgentSession] = useState<SessionEvent[]>([]);
  const desktop = isDesktop();
  const selectedAgent = agentTools.find(t => t.id === agentId) ?? agentTools[0];
  const contextSources = useMemo(() => project.sources.filter((s: SourceRecord) => block.sourceRefs.includes(s.id)), [project.sources, block.sourceRefs]);
  const context = useMemo(() => contextSources.map((s: SourceRecord) => {
    const chunk = knowledgeChunks[s.id];
    const content = chunk?.content ?? s.content ?? sourceContents[s.id] ?? s.excerpt;
    const title = chunk ? `${chunk.documentTitle} / ${chunk.headingPath}` : s.heading ? `${s.title} / ${s.heading}` : s.title;
    return `${title}:\n${content}`;
  }), [contextSources, knowledgeChunks, sourceContents]);
  const pendingCliContext = useMemo(() => contextSources.some((source: SourceRecord) => source.kind === "local" && !source.content && !source.location.startsWith("knowledge:") && !Object.prototype.hasOwnProperty.call(sourceContents, source.id)), [contextSources, sourceContents]);
  const contextCharCount = useMemo(() => context.reduce((total: number, item: string) => total + item.replace(/\s/g, "").length, 0), [context]);
  const copyContextText = async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(successMessage);
    } catch {
      notify("复制失败，请检查剪贴板权限");
    }
  };
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
    if (!desktop || (tab !== "context" && tab !== "commands")) return;
    const pending = contextSources.filter((source: SourceRecord) => source.kind === "local" && !source.content && !source.location.startsWith("knowledge:") && !Object.prototype.hasOwnProperty.call(sourceContents, source.id));
    if (!pending.length) return;
    let cancelled = false;
    void Promise.all(pending.map(async (source: SourceRecord) => {
      try { return [source.id, await readTextFile(source.location)] as const; }
      catch { return [source.id, ""] as const; }
    })).then(entries => {
      if (!cancelled) setSourceContents(current => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => { cancelled = true; };
  }, [desktop, tab, contextSources, sourceContents]);

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

  const event = (kind: SessionEvent["kind"], label: string, content?: string): SessionEvent => ({ id: makeId(), kind, label, content, at: Date.now() });
  const appendOutput = (setter: Dispatch<SetStateAction<SessionEvent[]>>, content: string, channel: "stdout" | "stderr" = "stdout") => setter(current => {
    const last = current.at(-1);
    if (last?.kind === "output" && last.channel === channel) return [...current.slice(0, -1), { ...last, content: `${last.content ?? ""}${content}` }];
    return [...current, { ...event("output", channel === "stderr" ? "工具日志" : "模型输出", content), channel }];
  });
  const runAi = async () => {
    setLoading(true); setDraft(null);
    setAiSession([event("status", "建立当前会话", `${project.model.model} · ${aiUseContext ? `${context.length} 条上下文` : "仅当前章节"}`), event("tool", "发送章节与编辑要求")]);
    try {
      const result = await improveBlockStream(block, instruction, aiUseContext ? context : [], project.model, chunk => appendOutput(setAiSession, chunk));
      setDraft(result); setAiSession(current => [...current, event("done", "生成完成", `${result.after.length.toLocaleString()} 字符，等待确认`) ]);
    } catch (e: any) { setAiSession(current => [...current, event("error", "会话中断", e.message)]); notify(e.message); }
    finally { setLoading(false); }
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
    if (source.location.startsWith("knowledge:")) {
      const content = source.content ?? knowledgeChunks[source.id]?.content ?? source.excerpt;
      setPreviewMarkdown(`# ${source.title}\n\n${content}`);
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
  const runAgent = async () => {
    if (!desktop) return notify("请在 Tauri 桌面端运行此任务");
    if (!agentPrompt.trim()) return notify("请先填写提示词");
    if (!toolPaths[selectedAgent.program]) return notify(`未检测到 ${selectedAgent.name}，请先安装并加入 PATH`);
    setAgentRunning(true);
    setAgentResult(null);
    setAgentSession([event("status", `启动 ${selectedAgent.name}`, terminalCwd || "."), event("tool", "组装任务上下文", cliUseContext ? `${context.length} 条 · ${contextCharCount.toLocaleString()} 字` : "未携带上下文")]);
    try {
      const prompt = withAgentContext(agentPrompt, context, cliUseContext);
      const command = buildAgentCommand(selectedAgent, prompt, terminalCwd || ".");
      const result = await runCommandStream(command, (channel, content) => appendOutput(setAgentSession, content, channel));
      setAgentResult(result);
      setAgentSession(current => [...current, event(result.exitCode === 0 ? "done" : "error", result.exitCode === 0 ? "Agent 任务完成" : `Agent 退出码 ${result.exitCode}`, `${result.durationMs}ms`) ]);
      notify(result.exitCode === 0 ? `${selectedAgent.name} 完成` : `${selectedAgent.name} 退出码 ${result.exitCode}`);
    } catch (e: any) {
      setAgentResult({ error: e?.message ?? String(e) });
      setAgentSession(current => [...current, event("error", "Agent 执行失败", e?.message ?? String(e))]);
      notify(e?.message ?? "Agent 执行失败");
    } finally {
      setAgentRunning(false);
    }
  };
  const applyAgentOutput = () => {
    if (!agentResult || !("stdout" in agentResult)) return;
    updateBlock((b: DocumentBlock) => ({ ...b, content: agentResult.stdout }));
    notify("Agent 输出已写入当前章节");
  };
  const addKnowledgeScopeToContext = (scope: KnowledgeSectionScope) => {
    const chunk = chunkFromScope(scope);
    const source: SourceRecord = {
      id: scope.id,
      kind: "local",
      title: scope.documentTitle,
      location: `knowledge:${scope.documentId}`,
      excerpt: scope.content.replace(/\s+/g, " ").slice(0, 280),
      content: scope.content,
      fingerprint: scope.id,
      accessedAt: new Date().toISOString(),
      heading: scope.headingPath,
    };
    setKnowledgeChunks(current => ({ ...current, [scope.id]: chunk }));
    updateSourceContext(scope.id, source, "toggle");
  };
  const previewKnowledgeScope = (scope: KnowledgeSectionScope) => {
    const chunk = chunkFromScope(scope);
    setKnowledgeChunks(current => ({ ...current, [scope.id]: chunk }));
    setPreviewSource({ id: scope.id, kind: "local", title: scope.documentTitle, location: `knowledge:${scope.documentId}`, excerpt: scope.content.replace(/\s+/g, " ").slice(0, 280), fingerprint: scope.id, accessedAt: new Date().toISOString(), heading: scope.headingPath, content: scope.content });
    setPreviewMarkdown(`# ${scope.documentTitle}\n\n${scope.content}`);
    setPreviewError(""); setPreviewLoading(false);
  };
  const moveKnowledgeResultUp = async (index: number) => {
    const result = knowledgeResults[index];
    if (!project.workspace || !result?.scope.parentId || !result.scope.canMoveUp) return;
    try {
      const scope = await getKnowledgeSectionScope(project.workspace, result.scope.parentId);
      setKnowledgeResults(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, scope, scopeHistory: [...item.scopeHistory, item.scope] } : item));
    } catch (e: any) { notify(e?.message ?? "无法扩大章节范围"); }
  };
  const moveKnowledgeResultDown = (index: number) => {
    setKnowledgeResults(current => current.map((item, itemIndex) => {
      if (itemIndex !== index || !item.scopeHistory.length) return item;
      return { ...item, scope: item.scopeHistory[item.scopeHistory.length - 1], scopeHistory: item.scopeHistory.slice(0, -1) };
    }));
  };
  const runKnowledgeSearch = async () => {
    if (!query.trim() || !project.workspace) { setKnowledgeResults([]); return; }
    setLocalSearching(true);
    try {
      const found = await searchKnowledge(project.workspace, query, ["good", "normal", "bad"].filter((quality): quality is KnowledgeChunkQuality => knowledgeQualityFilters.has(quality as KnowledgeChunkQuality)), [...knowledgeSearchFields]);
      const scopes = await Promise.all(found.map(result => getKnowledgeSectionScope(project.workspace!, result.scopeSectionId).catch(() => scopeFromSearchResult(result))));
      setKnowledgeResults(found.map((result, index) => ({ ...result, scope: scopes[index], scopeHistory: [] })));
    }
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
  const toggleKnowledgeSearchField = (field: KnowledgeSearchField) => {
    setKnowledgeSearchFields(current => {
      if (current.has(field) && current.size === 1) return current;
      const next = new Set(current);
      if (next.has(field)) next.delete(field); else next.add(field);
      return next;
    });
  };
  const markKnowledgeQuality = async (chunk: KnowledgeChunk, quality: KnowledgeChunkQuality) => {
    if (!project.workspace || chunk.quality === quality) return;
    try {
      const updated = await setKnowledgeChunkQuality(project.workspace, chunk.id, quality);
      setKnowledgeChunks(current => ({ ...current, [updated.id]: updated }));
      const qualities = (["good", "normal", "bad"] as KnowledgeChunkQuality[]).filter(item => knowledgeQualityFilters.has(item));
      const found = await searchKnowledge(project.workspace, query, qualities, [...knowledgeSearchFields]);
      const scopes = await Promise.all(found.map(result => getKnowledgeSectionScope(project.workspace!, result.scopeSectionId).catch(() => scopeFromSearchResult(result))));
      setKnowledgeResults(found.map((result, index) => ({ ...result, scope: scopes[index], scopeHistory: [] })));
      notify(`已标记为${quality === "good" ? "优质" : quality === "bad" ? "劣质" : "普通"}片段`);
    } catch (e: any) { notify(e?.message ?? "更新片段质量失败"); }
  };
  const saveWebToKnowledge = async (result: SearchResult) => {
    if (!project.workspace) return notify("请先配置工作目录");
    setKnowledgeBusy(true);
    try { await importKnowledgeWeb(project.workspace, result.url); notify("网页全文已存入知识库"); }
    catch (e: any) { notify(e?.message ?? "网页入库失败"); }
    finally { setKnowledgeBusy(false); }
  };
  return <aside className="right-panel">
    <div className="inspector-top">
      <div className="tabs">
        <button className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}><Sparkles size={15} />AI</button>
        <button className={tab === "commands" ? "active" : ""} onClick={() => setTab("commands")}><TerminalSquare size={15} />CLI</button>
        <button className={tab === "context" ? "active" : ""} onClick={() => setTab("context")}><Layers3 size={15} />上下文</button>
        <button className={tab === "sources" ? "active" : ""} onClick={() => setTab("sources")}><BookOpen size={15} />知识库</button>
      </div>
      <IconButton title="关闭侧栏" onClick={close}><PanelRightClose size={17} /></IconButton>
    </div>
    {tab === "ai" && <div className="inspector-content">
      <div className="context-line"><span><Bot size={17} />{project.model.model}</span><button onClick={openSettings}>配置</button></div>
      <label>编辑要求<textarea value={instruction} onChange={e => setInstruction(e.target.value)} /></label>
      <label className="context-box context-send-toggle"><span><input type="checkbox" checked={aiUseContext} onChange={e => setAiUseContext(e.target.checked)} />发送上下文</span><b>{aiUseContext ? `${context.length} 条引用 + 当前章节` : "仅当前章节"}</b></label>
      <button className="primary" onClick={runAi} disabled={loading}>{loading ? "正在生成…" : <><Sparkles size={16} />优化当前章节</>}</button>
      <SessionTrace title="章节优化会话" events={aiSession} running={loading} />
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
        <code>{selectedAgent.program} {selectedAgent.id === "claude" || selectedAgent.id === "codebuddy" ? "-p" : selectedAgent.id === "codex" ? "exec" : "run"}</code>
        <span>{Math.round(selectedAgent.timeoutMs / 1000)}s</span>
      </div>
      <label className="cli-context-toggle"><span><input type="checkbox" checked={cliUseContext} onChange={e => setCliUseContext(e.target.checked)} />携带上下文</span><b>{!cliUseContext ? "不发送" : pendingCliContext ? "正在加载全文…" : `${context.length} 条 · ${contextCharCount.toLocaleString()} 字`}</b></label>
      <div className="agent-actions">
        <button type="button" onClick={() => setAgentPrompt(defaultAgentPrompt(project, block))} disabled={agentRunning}>重置任务</button>
        <button className="primary" type="button" onClick={() => void runAgent()} disabled={agentRunning || !toolPaths[selectedAgent.program] || (cliUseContext && pendingCliContext)}>{agentRunning ? "执行中…" : "执行本地任务"}</button>
      </div>
      <SessionTrace title={`${selectedAgent.name} 当前会话`} events={agentSession} running={agentRunning} />
      {agentResult && <div className="cli-task-result">
        {"error" in agentResult ? <pre className="command-output error">{agentResult.error}</pre> : <>
          <div className="cli-result-meta"><span>退出码 {agentResult.exitCode}</span><span>{agentResult.durationMs}ms</span></div>
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
          <button type="button" className="context-add-action" disabled={!context.length} onClick={() => void copyContextText(context.join("\n\n---\n\n"), "已复制全部上下文")}><Copy size={13} />复制全部</button>
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
            <span>{source.kind === "web" ? <Globe2 size={13} /> : source.kind === "manual" ? <Pencil size={13} /> : <FolderSearch size={13} />}{source.kind === "web" ? "网页来源" : source.kind === "manual" ? "手动内容" : "本地资料"}<small className="context-source-char-count">{(source.content ?? knowledgeChunks[source.id]?.content ?? sourceContents[source.id] ?? source.excerpt).replace(/\s/g, "").length.toLocaleString()} 字</small></span>
            <b>{source.title}</b>
            <p>{source.excerpt || "（无摘要）"}</p>
            <div>
              <button type="button" onClick={() => void openSourcePreview(source)}>预览</button>
              <button type="button" onClick={() => void copyContextText(source.content ?? knowledgeChunks[source.id]?.content ?? sourceContents[source.id] ?? source.excerpt, `已复制“${source.title}”`)}><Copy size={11} />复制</button>
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
          placeholder="搜索标题、章节和正文"
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
      <div className="knowledge-field-filter" role="group" aria-label="知识搜索范围">
        <span>搜索范围</span>
        <div>{KNOWLEDGE_SEARCH_FIELDS.map(field => <label key={field.id} className={knowledgeSearchFields.has(field.id) ? "active" : ""}>
          <input type="checkbox" checked={knowledgeSearchFields.has(field.id)} onChange={() => toggleKnowledgeSearchField(field.id)} />
          {field.label}
        </label>)}</div>
      </div>
      {localSearching && <div className="loading-line">正在检索知识切片…</div>}
      {!!knowledgeResults.length && <div className="source-list knowledge-results">
        {knowledgeResults.map((result, index) => <article key={result.chunk.id}>
          <div className="knowledge-result-title"><span className="knowledge-result-level">H{result.scope.level}</span><b onClick={() => previewKnowledgeScope(result.scope)}>{result.scope.title}{result.scope.sectionCount > 1 ? `（含 ${result.scope.sectionCount} 个章节）` : ""}</b><span className="knowledge-path-hint" title={`H${result.scope.level} · ${result.scope.headingPath}`} aria-label={`章节路径：H${result.scope.level} · ${result.scope.headingPath}`}><Info size={13} /></span><em className={`knowledge-quality-badge ${result.chunk.quality}`}>{result.chunk.quality === "good" ? "优质" : result.chunk.quality === "bad" ? "劣质" : "普通"}</em></div><p>{result.scope.content.replace(/^#{1,6}\s+.*\n*/, "").replace(/\s+/g, " ").slice(0, 220) || "（该章节暂无正文）"}</p>
          <div className="knowledge-result-footer">
            <div className="source-item-actions"><button onClick={() => previewKnowledgeScope(result.scope)}>预览</button><button className={block.sourceRefs.includes(result.scope.id) ? "context-added" : ""} onClick={() => addKnowledgeScopeToContext(result.scope)}>{block.sourceRefs.includes(result.scope.id) ? <><Check size={12} />已加入上下文</> : <><Layers3 size={12} />加入上下文</>}</button><small className="knowledge-result-char-count">{result.scope.content.replace(/\s/g, "").length.toLocaleString()} 字</small></div>
            <div className="knowledge-scope-actions" role="group" aria-label="调整章节范围">
              <IconButton title="上移到父章节" disabled={!result.scope.canMoveUp} onClick={() => void moveKnowledgeResultUp(index)}><ChevronUp size={13} /></IconButton>
              <IconButton title="返回上次范围" disabled={!result.scopeHistory.length} onClick={() => moveKnowledgeResultDown(index)}><ChevronDown size={13} /></IconButton>
            </div>
            <div className="knowledge-quality-actions" role="group" aria-label="标记片段质量">
              <IconButton title="标记为优质" active={result.chunk.quality === "good"} onClick={() => void markKnowledgeQuality(result.chunk, "good")}><ThumbsUp size={13} /></IconButton>
              <IconButton title="标记为普通" active={result.chunk.quality === "normal"} onClick={() => void markKnowledgeQuality(result.chunk, "normal")}><Minus size={13} /></IconButton>
              <IconButton title="标记为劣质" active={result.chunk.quality === "bad"} onClick={() => void markKnowledgeQuality(result.chunk, "bad")}><ThumbsDown size={13} /></IconButton>
            </div>
          </div>
        </article>)}
      </div>
      }
      {!localSearching && !knowledgeResults.length && <div className="knowledge-search-empty"><BookOpen size={25} /><b>{query.trim() ? "没有匹配结果" : "输入关键词检索知识库"}</b><span>{query.trim() ? "尝试更短的关键词或章节名称" : "检索标题、章节和正文"}</span></div>}
      </>}
    </div>}
  </aside>;
}

function SettingsModal({ project, close, save }: { project: Project; close: () => void; save: (p: Project) => void | Promise<void> }) {
  const [draft, setDraft] = useState(() => {
    const next = structuredClone(project);
    if (!next.mineru) next.mineru = createProject().mineru;
    return next;
  });
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const desktop = isDesktop();
  const workspace = draft.workspace ?? { root: "", historyDir: "" };

  const updateModel = (patch: Partial<Project["model"]>) => {
    setDraft(current => ({ ...current, model: { ...current.model, ...patch } }));
    if ("baseUrl" in patch || "apiKey" in patch) {
      setModelOptions([]);
      setModelsError("");
    }
  };

  const refreshModels = async () => {
    setModelsLoading(true);
    setModelsError("");
    try {
      setModelOptions(await listModels(draft.model));
    } catch (e: any) {
      setModelOptions([]);
      setModelsError(e?.message ?? "获取模型列表失败");
    } finally {
      setModelsLoading(false);
    }
  };

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
    <div className="modal wide settings-modal" onMouseDown={e => e.stopPropagation()}>
      <div className="modal-title"><div><Settings size={19} /><span>连接、工作区与隐私</span></div><IconButton title="关闭" onClick={close}><X size={18} /></IconButton></div>
      <div className="settings-modal-body">
      <div className="notice"><Globe2 size={18} /><div><b>联网模型已启用</b><span>当前章节和明确选择的引用会发送至此服务。连接配置保存在工作区 <code>.gouan/connections.json</code>。</span></div><input type="checkbox" checked={draft.model.enabled} onChange={e => setDraft({ ...draft, model: { ...draft.model, enabled: e.target.checked } })} /></div>
      <div className="form-grid">
        <label>API 地址<input value={draft.model.baseUrl} onChange={e => updateModel({ baseUrl: e.target.value })} /></label>
        <label className="wide">API Key<input type="password" value={draft.model.apiKey} placeholder="写入工作区 .gouan/connections.json" onChange={e => updateModel({ apiKey: e.target.value })} /></label>
        <label className="wide">模型名称
          <div className="model-picker">
            <input list="upstream-models" value={draft.model.model} placeholder="手动输入，或先获取上游模型" onChange={e => updateModel({ model: e.target.value })} />
            <button type="button" className="model-fetch-button" onClick={() => void refreshModels()} disabled={modelsLoading}>
              <RefreshCw size={13} className={modelsLoading ? "model-fetch-spinning" : undefined} />
              {modelsLoading ? "获取中…" : "从上游获取"}
            </button>
          </div>
          <datalist id="upstream-models">
            {modelOptions.map(item => <option value={item.id} label={item.displayName === item.id ? undefined : item.displayName} key={item.id} />)}
          </datalist>
          {modelsError && <span className="model-list-error">{modelsError}</span>}
          {!modelsError && modelOptions.length > 0 && <span className="model-list-hint">已发现 {modelOptions.length} 个模型，点击输入框可选择。</span>}
        </label>
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
