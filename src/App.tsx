import { useEffect, useMemo, useRef, useState } from "react";
import { Bold, BookOpen, Bot, Braces, Check, ChevronDown, ChevronRight, ChevronUp, Code2, Command, Download, FilePlus2, FolderOpen, FolderSearch, Globe2, Highlighter, Italic, MoreHorizontal, PanelRightClose, PanelRightOpen, Pencil, Redo2, RefreshCw, Replace, Save, Search, Settings, Sparkles, Strikethrough, TerminalSquare, Undo2, X } from "lucide-react";
import { createProject, defaultWorkspaceFromRoot, makeId } from "./data";
import { exportMarkdown, loadProject, saveProject } from "./storage";
import { agentTools, buildAgentCommand, defaultAgentPrompt, type AgentToolId } from "./agents";
import { detectTools, improveBlock, isDesktop, runCommand, saveMarkdown, searchWeb } from "./services";
import { downloadDocx } from "./docxExport";
import { findMatches, replaceAllMatches, replaceMatch, type FindMatch } from "./findReplace";
import { PowerShellTerminal } from "./terminal";
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

type RightTab = "ai" | "sources" | "search" | "commands";
type EditorMode = "section" | "full";
const RIGHT_PANEL_MIN = 280;
const RIGHT_PANEL_MAX = 720;
const RIGHT_PANEL_DEFAULT = 360;
const LEFT_PANEL_MIN = 180;
const LEFT_PANEL_MAX = 480;
const LEFT_PANEL_DEFAULT = 240;
const IconButton = ({ title, children, onClick, active = false }: { title: string; children: React.ReactNode; onClick?: () => void; active?: boolean }) => <button className={`icon-button ${active ? "active" : ""}`} title={title} aria-label={title} onClick={onClick}>{children}</button>;

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
  const [toast, setToast] = useState("");
  const [exportMenu, setExportMenu] = useState(false);
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

  const openTerminalPanel = () => {
    setRightOpen(true);
    setRightTab("commands");
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
        <IconButton title="撤销 (Ctrl+Z)" onClick={undo}><Undo2 size={17} /></IconButton>
        <IconButton title="重做 (Ctrl+Y / Ctrl+Shift+Z)" onClick={redo}><Redo2 size={17} /></IconButton>
        <span className="divider" />
        <button className="text-button" onClick={() => void createNewFile()}><FilePlus2 size={16} />新建</button>
        <button className="text-button" onClick={() => void openFromDialog()}><FolderOpen size={16} />打开</button>
        <button
          className="text-button"
          onClick={() => void reloadCurrentMarkdown()}
          disabled={!desktop || !project.filePath}
          title={project.filePath ? "从磁盘重新加载当前 Markdown" : "请先打开或保存关联的 .md 文件"}
        >
          <RefreshCw size={16} />重新加载
        </button>
        <button className="text-button" onClick={() => void saveToWorkspace()}><Save size={16} />保存</button>
        <button
          className="text-button"
          onClick={() => void renameCurrentFile()}
          disabled={!desktop || !project.filePath}
          title={project.filePath ? "重命名当前文件" : "请先打开或保存关联的 .md 文件"}
        >
          <Pencil size={16} />重命名
        </button>
        <div className="export-menu" ref={exportMenuRef}>
          <button className="text-button" disabled={exporting} onClick={() => setExportMenu(v => !v)}>
            <Download size={16} />{exporting ? "导出中…" : "导出"}<ChevronDown size={14} />
          </button>
          {exportMenu && <div className="export-dropdown">
            <button onClick={() => void exportAsMarkdown()}>导出 Markdown (.md)</button>
            <button onClick={() => void exportAsWord()}>导出 Word (.docx)</button>
          </div>}
        </div>
        <IconButton title="终端" active={rightOpen && rightTab === "commands"} onClick={openTerminalPanel}><TerminalSquare size={18} /></IconButton>
        <IconButton
          title={rightOpen ? "收起右侧面板" : "打开右侧面板"}
          active={rightOpen}
          onClick={() => setRightOpen(v => !v)}
        >
          {rightOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </IconButton>
        <IconButton title="设置" onClick={() => setSettingsOpen(true)}><Settings size={18} /></IconButton>
        <IconButton title="更多"><MoreHorizontal size={18} /></IconButton>
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
          terminalActive={rightOpen && rightTab === "commands"}
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
    {previewSource && (
      <div className="preview-modal-overlay" onClick={() => { setPreviewSource(null); setPreviewMarkdown(""); setPreviewError(""); }}>
        <div className="preview-modal" onClick={e => e.stopPropagation()}>
          <div className="preview-modal-head">
            <div>
              <strong>{previewSource.title}</strong>
              <em title={previewSource.location}>{previewSource.location}</em>
            </div>
            <IconButton title="关闭预览" onClick={() => { setPreviewSource(null); setPreviewMarkdown(""); setPreviewError(""); }}><X size={18} /></IconButton>
          </div>
          {previewLoading && <div className="loading-line">正在加载预览…</div>}
          {previewError && <p className="muted">{previewError}</p>}
          {!previewLoading && !previewError && (
            <div className="preview-modal-body">
              <MarkdownPreview
                markdown={previewMarkdown}
                filePath={previewSource.kind === "local" ? previewSource.location : undefined}
                workspaceRoot={project.workspace?.root}
              />
            </div>
          )}
        </div>
      </div>
    )}
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

function matchSourceKeywords(source: SourceRecord, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const tokens = q.split(/\s+/).filter(Boolean);
  const hay = `${source.title}\n${source.excerpt}\n${source.location}\n${source.heading ?? ""}`.toLowerCase();
  return tokens.every(t => hay.includes(t));
}

function RightPanel({ tab, setTab, project, block, updateProject, updateBlock, notify, openSettings, close, openSource, refreshLibrary, terminalCwd, terminalActive, previewSource, setPreviewSource, previewMarkdown, setPreviewMarkdown, previewLoading, setPreviewLoading, previewError, setPreviewError }: any) {
  const [instruction, setInstruction] = useState("使表述更专业、具体，并补充必要的实施约束");
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [webQuery, setWebQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchAttempted, setSearchAttempted] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [commandOutputs, setCommandOutputs] = useState<Record<string, CommandResult | { error: string }>>({});
  const [toolPaths, setToolPaths] = useState<Record<string, string>>({});
  const [agentId, setAgentId] = useState<AgentToolId>("claude");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentResult, setAgentResult] = useState<CommandResult | { error: string } | null>(null);
  const desktop = isDesktop();
  const selectedAgent = agentTools.find(t => t.id === agentId) ?? agentTools[0];
  const context = useMemo(() => project.sources.filter((s: SourceRecord) => block.sourceRefs.includes(s.id)).map((s: SourceRecord) => `${s.title}: ${s.excerpt}`), [project.sources, block.sourceRefs]);
  const filteredSources = useMemo(
    () => (project.sources as SourceRecord[]).filter(s => matchSourceKeywords(s, query)),
    [project.sources, query],
  );

  useEffect(() => {
    if (!desktop) return;
    detectTools().then(setToolPaths).catch(() => setToolPaths({}));
  }, [desktop]);
  useEffect(() => {
    setAgentPrompt(defaultAgentPrompt(project, block));
    setAgentResult(null);
  }, [block.content, project.name]);

  const runAi = async () => { setLoading(true); try { setDraft(await improveBlock(block, instruction, context, project.model)); } catch (e: any) { notify(e.message); } finally { setLoading(false); } };
  const runWebSearch = async () => {
    if (!webQuery.trim()) return;
    if (!confirm(`即将向 ${project.search.provider} 发送查询：\n\n${webQuery}`)) return;
    setSearching(true);
    setSearchAttempted(true);
    try { setResults(await searchWeb(webQuery, project.search)); } catch (e: any) { notify(e.message); } finally { setSearching(false); }
  };
  const addResult = (r: SearchResult) => {
    const source: SourceRecord = { id: makeId(), kind: "web", title: r.title, location: r.url, excerpt: r.excerpt, fingerprint: btoa(unescape(encodeURIComponent(r.url))).slice(0, 32), accessedAt: new Date().toISOString() };
    updateProject((p: Project) => ({ ...p, sources: [...p.sources, source] }));
    notify("来源已保存");
  };
  const openSourcePreview = async (source: SourceRecord) => {
    setPreviewSource(source);
    setPreviewMarkdown("");
    setPreviewError("");
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
    if (!confirm(`将调用 ${selectedAgent.name} 处理当前章节。\n\n程序：${selectedAgent.program}\n超时：${Math.round(selectedAgent.timeoutMs / 1000)} 秒`)) return;
    setAgentRunning(true);
    setAgentResult(null);
    try {
      const command = buildAgentCommand(selectedAgent, agentPrompt.trim());
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
  const applyAgentOutput = () => {
    if (!agentResult || "error" in agentResult) return;
    const text = (agentResult.stdout || "").trim();
    if (!text) return notify("没有可应用的输出");
    updateBlock((b: DocumentBlock) => ({ ...b, content: text, status: "review" as const }));
    notify("已写入当前章节");
  };

  return <aside className={`right-panel ${tab === "commands" ? "terminal-mode" : ""}`}>
    <div className="inspector-top">
      <div className="tabs">
        <button className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}><Sparkles size={15} />AI</button>
        <button className={tab === "commands" ? "active" : ""} onClick={() => setTab("commands")}><TerminalSquare size={15} />CLI</button>
        <button className={tab === "sources" ? "active" : ""} onClick={() => setTab("sources")}><BookOpen size={15} />资料</button>
        <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}><Search size={15} />联网</button>
        <button className={tab === "env" ? "active" : ""} onClick={() => setTab("env")}><Command size={15} />环境检查</button>
      </div>
      <IconButton title="关闭侧栏" onClick={close}><PanelRightClose size={17} /></IconButton>
    </div>
    {tab === "ai" && <div className="inspector-content">
      <div className="context-line"><span><Bot size={17} />{project.model.model}</span><button onClick={openSettings}>配置</button></div>
      <label>编辑要求<textarea value={instruction} onChange={e => setInstruction(e.target.value)} /></label>
      <div className="context-box"><span>发送上下文</span><b>{context.length} 条引用 + 当前章节</b></div>
      <button className="primary" onClick={runAi} disabled={loading}>{loading ? "正在生成…" : <><Sparkles size={16} />优化当前章节</>}</button>
      {draft && <div className="diff"><div className="diff-title"><span>修改建议</span><button onClick={() => setDraft(null)}><X size={14} /></button></div><div className="removed">{draft.before || "（空内容）"}</div><div className="added">{draft.after}</div><div className="diff-actions"><button onClick={() => setDraft(null)}>拒绝</button><button onClick={() => { updateBlock((b: DocumentBlock) => ({ ...b, content: draft.after })); setDraft(null); notify("修改已应用"); }}><Check size={14} />接受修改</button></div></div>}
    </div>}
    {tab === "sources" && <div className="inspector-content sources-panel">
      <div className="search-row">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="关键词筛选本地/已保存资料"
        />
        <button type="button" title="清空" onClick={() => setQuery("")}><X size={16} /></button>
      </div>
      <p className="muted">本地筛选仅匹配标题、摘要与路径关键词，不做向量检索。</p>
      <div className="source-actions">
        <button className="import-link" onClick={openSource}><FilePlus2 size={16} />导入 Markdown 到历史资料</button>
        <button className="import-link" onClick={refreshLibrary}><RefreshCw size={15} />刷新本地资料</button>
      </div>
      {project.workspace?.historyDir && <p className="muted path-line">历史资料目录：{project.workspace.historyDir}</p>}
      <div className="source-list">
        {filteredSources.map((s: SourceRecord) => (
          <article key={s.id} className={previewSource?.id === s.id ? "active" : ""}>
            <div>{s.kind === "web" ? <Globe2 size={15} /> : <FolderSearch size={15} />}<span>{s.kind === "web" ? "网页来源" : "本地资料"}</span></div>
            <b>{s.title}</b>
            <p>{s.excerpt}</p>
            <div className="source-item-actions">
              <button type="button" onClick={() => void openSourcePreview(s)}>预览</button>
              <button type="button" onClick={() => updateBlock((b: DocumentBlock) => ({ ...b, sourceRefs: b.sourceRefs.includes(s.id) ? b.sourceRefs.filter((x: string) => x !== s.id) : [...b.sourceRefs, s.id] }))}>{block.sourceRefs.includes(s.id) ? "移除上下文" : "加入上下文"}</button>
            </div>
          </article>
        ))}
        {!filteredSources.length && <p className="muted">{query.trim() ? "无匹配资料" : "暂无资料"}</p>}
      </div>
    </div>}
    {tab === "search" && <div className="inspector-content sources-panel">
      <div className="search-row">
        <input value={webQuery} onChange={e => setWebQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && void runWebSearch()} placeholder="联网搜索关键词" />
        <button onClick={() => void runWebSearch()}><Search size={16} /></button>
      </div>
      {searching && <div className="loading-line">正在联网检索…</div>}
      {results.length > 0 && <div className="source-list">
        {results.map(r => <article key={r.url}><div><Globe2 size={15} /><span>{new URL(r.url).hostname}</span></div><b>{r.title}</b><p>{r.excerpt}</p><button onClick={() => addResult(r)}>保存来源</button></article>)}
      </div>}
      {!results.length && !searching && <p className="muted">{searchAttempted ? "搜索完成，没有返回结果（搜索引擎可能受限或超时）" : "输入关键词后按 Enter 或点击搜索图标"}</p>}
    </div>}
    {tab === "env" && <div className="inspector-content">
      {project.commands.length === 0 && <p className="muted">暂无环境检查任务</p>}
      {project.commands.map((c: Project["commands"][number]) => {
        const output = commandOutputs[c.id];
        return <div className="command-item" key={c.id}><Command size={16} /><div><b>{c.name}{toolPaths[c.program] ? "" : " · 未检测"}</b><code>{c.program} {c.args.join(" ")}</code>
          {output && !("error" in output) && <pre className="command-output">exit {output.exitCode} · {output.durationMs}ms{"\n"}{(output.stdout || output.stderr || "(无输出)").trim()}</pre>}
          {output && "error" in output && <pre className="command-output error">{output.error}</pre>}
        </div><button onClick={() => runTask(c)} disabled={runningId === c.id}>{runningId === c.id ? "运行中…" : "运行"}</button></div>;
      })}
    </div>}
    <div className={`inspector-terminal ${tab === "commands" ? "is-visible" : "is-hidden"}`}>
      <div className="inspector-terminal-meta">
        <span>CLI · PowerShell</span>
        <em title={terminalCwd}>{terminalCwd || "项目目录"}</em>
      </div>
      <PowerShellTerminal active={Boolean(terminalActive)} cwd={terminalCwd || "."} />
    </div>
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
