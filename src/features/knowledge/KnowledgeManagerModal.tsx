import { useEffect, useMemo, useState } from "react";
import { BookOpen, Check, ChevronDown, ChevronRight, ChevronUp, ExternalLink, Eye, FilePlus2, FolderSearch, LoaderCircle, Minus, Plus, RefreshCw, Search, Tag, Tags, ThumbsDown, ThumbsUp, Trash2, Undo2, X } from "lucide-react";
import { HeadingReviewModal } from "../../components/HeadingReviewModal";
import { IconButton } from "../../components/IconButton";
import { FileUploadPanel } from "../../components/FileUploadPanel";
import { SourcePreviewModal } from "../../components/SourcePreviewModal";
import { importWordOrPdfToWorkspace } from "../export/documentImport";
import {
  analyzeKnowledgeMarkdown, applyKnowledgeHeadings, deleteKnowledgeFile, listKnowledgeBackups,
  indexPendingKnowledge, listKnowledge, listKnowledgeCategories, listKnowledgeSectionChunks, listKnowledgeSections,
  onKnowledgeProgress, removeKnowledgeDocument, restoreKnowledgeBackup, scanKnowledge, searchKnowledge,
  setKnowledgeDocumentCategory, setKnowledgeSectionQuality, deleteKnowledgeCategory, saveKnowledgeCategory,
} from "./knowledge";
import { openExternalUrl } from "../../services/system";
import { countMarkdownWords } from "../editor/markdownDoc";
import type {
  DocumentBlock, HeadingCandidate, HeadingDetectionResult, HeadingReviewDecision,
  KnowledgeCategory, KnowledgeChunkQuality, KnowledgeDocument, KnowledgeProgress, KnowledgeScanItem, KnowledgeSearchResult,
  KnowledgeSection, Project, SourceRecord, WorkspaceMarkdownFile, WorkspacePaths,
} from "../../core/types";
import { deleteFile, importMarkdownToWorkspace, pickDocumentFile, pickMarkdownFile, readTextFile } from "../workspace/workspace";

type ProjectUpdater = (updater: (project: Project) => Project) => void;
type BlockUpdater = (updater: (block: DocumentBlock) => DocumentBlock) => void;
type KnowledgeImportKind = "markdown" | "document";
const KNOWLEDGE_MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;
const KNOWLEDGE_DOCUMENT_EXTENSIONS = [".pdf", ".doc", ".docx"] as const;
const CATEGORY_COLORS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#4b5563"] as const;

const resolveWorkspaceLocation = (root: string, location: string) => /^[a-zA-Z]:[\\/]|^\\\\/.test(location)
  ? location
  : `${root.replace(/[\\/]$/, "")}\\${location.replace(/\//g, "\\")}`;

export function KnowledgeManagerModal({ project, updateProject, updateBlock, refreshWorkspaceDocs, openMarkdownPath, notify, close }: {
  project: Project;
  updateProject: ProjectUpdater;
  updateBlock: BlockUpdater;
  refreshWorkspaceDocs: (workspace?: WorkspacePaths) => Promise<WorkspaceMarkdownFile[]>;
  openMarkdownPath: (path: string) => Promise<void | boolean>;
  notify: (message: string) => void;
  close: () => void;
}) {
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
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [importKind, setImportKind] = useState<KnowledgeImportKind | null>(null);
  const [categories, setCategories] = useState<KnowledgeCategory[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [categoryFilterOpen, setCategoryFilterOpen] = useState(false);
  const [categoryFilterQuery, setCategoryFilterQuery] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryColor, setCategoryColor] = useState<string>(CATEGORY_COLORS[0]);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [categoryBusy, setCategoryBusy] = useState(false);

  const reload = async () => {
    if (!project.workspace?.root) return;
    const [nextDocuments, scanned] = await Promise.all([listKnowledge(project.workspace), scanKnowledge(project.workspace)]);
    setDocuments(nextDocuments);
    setPending(scanned.filter(item => item.state !== "indexed"));
  };

  const changed = pending.filter(item => item.state === "changed");
  const unindexed = pending.filter(item => item.state === "unindexed");
  const pendingDocumentIds = new Set(changed.flatMap(item => item.documentId ? [item.documentId] : []));
  const readyDocuments = documents.filter(document => !pendingDocumentIds.has(document.id));

  useEffect(() => {
    void reload().catch(error => notify(error instanceof Error ? error.message : "知识库加载失败"));
    void reloadCategories().catch(() => undefined);
  }, [project.workspace?.root]);
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
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query || !project.workspace) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearchResults([]);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void searchKnowledge(
        project.workspace!,
        query,
        ["good", "normal", "bad"],
        undefined,
        50,
        undefined,
        selectedCategories.size ? [...selectedCategories] : undefined,
      )
        .then(results => { if (!cancelled) setSearchResults(results); })
        .catch(error => { if (!cancelled) notify(error instanceof Error ? error.message : "知识库搜索失败"); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [searchQuery, project.workspace?.root, selectedCategories]);

  const analyze = async (path: string): Promise<boolean> => {
    if (!project.workspace) return false;
    setProgress({ documentId: "", stage: "structure_scanning", current: 0, total: 0, message: "正在本地扫描标题和章节结构…" });
    setBusy(true);
    try {
      const result = await analyzeKnowledgeMarkdown(project.workspace, path, project.model);
      setHeadingReview(result);
      setHeadingCandidates(result.candidates);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "文档结构识别失败");
      return false;
    } finally { setBusy(false); }
  };
  const importFile = async (path: string): Promise<boolean> => {
    if (!project.workspace) { notify("请先配置工作目录"); return false; }
    return analyze(path);
  };
  const importWordPdf = async (sourcePath: string): Promise<boolean> => {
    if (!project.workspace) { notify("请先配置工作目录"); return false; }
    setBusy(true);
    setProgress({ documentId: "", stage: "document_parsing", current: 0, total: 0, message: "正在通过 MinerU 解析 Word / PDF…" });
    let temporaryPath = "";
    try {
      const converted = await importWordOrPdfToWorkspace(sourcePath, project.workspace.root, project.mineru);
      temporaryPath = converted.path;
      setProgress({ documentId: "", stage: "structure_scanning", current: 0, total: 0, message: "文档解析完成，正在识别标题和章节结构…" });
      const result = await analyzeKnowledgeMarkdown(project.workspace, converted.path, project.model);
      setHeadingReview(result);
      setHeadingCandidates(result.candidates);
      let cleanupWarning = "";
      try {
        await deleteFile(converted.path);
        temporaryPath = "";
      } catch {
        cleanupWarning = `；工作区临时文件 ${converted.path.split(/[\\/]/).pop()} 未能删除`;
      }
      await refreshWorkspaceDocs(project.workspace);
      const notes = [converted.assetRelativeDir ? `图片已保存到 ${converted.assetRelativeDir}` : ""];
      if (converted.originalPath) notes.push(`原文件已保留到 imports/${converted.originalPath.split(/[\\/]/).pop()}`);
      else if (converted.originalWarning) notes.push(`原文件未保留：${converted.originalWarning}`);
      if (cleanupWarning) notes.push(cleanupWarning);
      notify(`已解析 ${converted.sourceFileName}，请确认知识库章节结构${notes.filter(Boolean).length ? `；${notes.filter(Boolean).join("；")}` : ""}`);
      return true;
    } catch (error) {
      if (temporaryPath) await refreshWorkspaceDocs(project.workspace).catch(() => undefined);
      notify(error instanceof Error ? error.message : "Word/PDF 导入知识库失败");
      return false;
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  const rebuildChanged = async () => {
    if (!project.workspace || !changed.length) return;
    setProgress({ documentId: "", stage: "reindexing", current: 0, total: changed.length, message: `正在更新 ${changed.length} 个知识索引…` });
    setBusy(true);
    try {
      await indexPendingKnowledge(project.workspace, changed.map(item => item.path));
      await reload();
      notify(`已更新 ${changed.length} 个知识索引`);
    } catch (error) { notify(error instanceof Error ? error.message : "批量更新索引失败"); }
    finally { setBusy(false); setProgress(null); }
  };
  const confirmReview = async () => {
    if (!project.workspace || !headingReview) return;
    setProgress({ documentId: headingReview.documentId, stage: "normalization_preparing", current: 0, total: 0, message: "正在准备结构规范化…" });
    setBusy(true);
    const decisions: HeadingReviewDecision[] = headingCandidates.map(item => ({ id: item.id, line: item.line, selected: item.selected, level: item.level, source: item.source, confidence: item.confidence }));
    try {
      await applyKnowledgeHeadings(project.workspace, headingReview, decisions);
      setHeadingReview(null); setHeadingCandidates([]); await reload(); notify("文档结构已确认并入库");
    } catch (error) { notify(error instanceof Error ? error.message : "规范化入库失败"); }
    finally { setBusy(false); }
  };
  const toggleDocument = async (documentId: string) => {
    const next = new Set(expanded);
    if (next.has(documentId)) next.delete(documentId);
    else {
      next.add(documentId);
      if (!sections[documentId] && project.workspace) {
        try { const value = await listKnowledgeSections(project.workspace, documentId); setSections(current => ({ ...current, [documentId]: value })); }
        catch (error) { notify(error instanceof Error ? error.message : "读取文档结构失败"); }
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
    } catch (error) { notify(error instanceof Error ? error.message : "恢复原文失败"); }
    finally { setBusy(false); }
  };
  const deletePending = async (item: KnowledgeScanItem) => {
    if (!project.workspace || !confirm(`彻底删除“${item.title}”？\n\n将删除知识库目录中的 Markdown 副本，此操作无法撤销。`)) return;
    setBusy(true);
    try { await deleteKnowledgeFile(project.workspace, item.path, item.documentId); await reload(); notify("知识文档已删除"); }
    catch (error) { notify(error instanceof Error ? error.message : "删除失败"); }
    finally { setBusy(false); }
  };
  const returnPendingToWorkspace = async (item: KnowledgeScanItem) => {
    if (!project.workspace) return notify("请先配置工作目录");
    setBusy(true);
    try {
      const sourcePath = resolveWorkspaceLocation(project.workspace.root, item.path);
      const workspacePath = await importMarkdownToWorkspace(sourcePath, project.workspace.root);
      await deleteKnowledgeFile(project.workspace, item.path, item.documentId);
      await Promise.all([reload(), refreshWorkspaceDocs(project.workspace)]);
      notify(`已转回工作区：${workspacePath.split(/[\\/]/).pop()}`);
      await openMarkdownPath(workspacePath);
    } catch (error) { notify(error instanceof Error ? error.message : "转回工作区失败"); }
    finally { setBusy(false); }
  };
  const deleteIndexed = async (document: KnowledgeDocument) => {
    if (!project.workspace || !confirm(`彻底删除“${document.title}”？\n\n将同时删除索引和知识库目录中的 Markdown 副本，此操作无法撤销。`)) return;
    setBusy(true);
    try {
      await deleteKnowledgeFile(project.workspace, document.location, document.id);
      const removedIds = new Set(project.sources.filter(source => source.location === `knowledge:${document.id}`).map(source => source.id));
      updateProject(value => ({ ...value, sources: value.sources.filter(source => !removedIds.has(source.id)) }));
      updateBlock(value => ({ ...value, sourceRefs: value.sourceRefs.filter(id => !removedIds.has(id)) }));
      await reload(); notify("知识文档及索引已删除");
    } catch (error) { notify(error instanceof Error ? error.message : "删除失败"); }
    finally { setBusy(false); }
  };
  const removeIndexed = async (document: KnowledgeDocument) => {
    if (!project.workspace || !confirm(`从知识库移出“${document.title}”？原始 Markdown 会保留。`)) return;
    setBusy(true);
    try { await removeKnowledgeDocument(project.workspace, document.id); await reload(); notify("已从知识库移出，原始 Markdown 已保留"); }
    catch (error) { notify(error instanceof Error ? error.message : "移出失败"); }
    finally { setBusy(false); }
  };
  const previewDocument = async (document: KnowledgeDocument) => {
    const source: SourceRecord = { id: document.id, kind: "local", title: document.title, location: document.location, excerpt: "", fingerprint: document.fingerprint, accessedAt: new Date().toISOString() };
    setPreview({ source, markdown: "", loading: true, error: "" });
    try { const markdown = await readTextFile(resolveWorkspaceLocation(project.workspace!.root, document.location)); setPreview({ source, markdown, loading: false, error: "" }); }
    catch (error) { setPreview({ source, markdown: "", loading: false, error: error instanceof Error ? error.message : "读取文档失败" }); }
  };
  const previewSection = async (document: KnowledgeDocument, section: KnowledgeSection) => {
    if (!project.workspace) return;
    const source: SourceRecord = { id: section.id, kind: "local", title: `${document.title} / ${section.title}`, location: document.location, excerpt: section.headingPath, fingerprint: section.id, accessedAt: new Date().toISOString(), heading: section.headingPath };
    setPreview({ source, markdown: "", loading: true, error: "" });
    try {
      const chunks = await listKnowledgeSectionChunks(project.workspace, section.id);
      const markdown = chunks.map(chunk => chunk.content).filter(Boolean).join("\n\n---\n\n");
      setPreview({ source, markdown: markdown || `# ${section.title}\n\n（该章节暂无正文）`, loading: false, error: "" });
    } catch (error) { setPreview({ source, markdown: "", loading: false, error: error instanceof Error ? error.message : "读取知识片段失败" }); }
  };
  const previewSearchResult = (result: KnowledgeSearchResult) => {
    const source: SourceRecord = { id: result.chunk.id, kind: "local", title: `${result.chunk.documentTitle} / ${result.chunk.headingPath}`, location: `knowledge:${result.chunk.documentId}`, excerpt: result.excerpt, fingerprint: result.chunk.id, accessedAt: new Date().toISOString(), heading: result.chunk.headingPath };
    setPreview({ source, markdown: result.chunk.content, loading: false, error: "" });
  };
  const markSectionQuality = async (section: KnowledgeSection, quality: KnowledgeChunkQuality) => {
    if (!project.workspace || section.quality === quality) return;
    setBusy(true);
    try {
      await setKnowledgeSectionQuality(project.workspace, section.id, quality);
      setSections(current => ({ ...current, [section.documentId]: (current[section.documentId] ?? []).map(item => item.id === section.id ? { ...item, quality } : item) }));
      notify(`片段已标记为${quality === "good" ? "优质" : quality === "bad" ? "劣质" : "普通"}`);
    } catch (error) { notify(error instanceof Error ? error.message : "更新片段状态失败"); }
    finally { setBusy(false); }
  };

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [categories],
  );
  const categoryGroups = useMemo(() => {
    const namedGroups = sortedCategories
      .map(category => ({
        id: category.id,
        label: category.name,
        color: category.color,
        documents: readyDocuments.filter(item => item.categoryId === category.id),
      }))
      .filter(group => group.documents.length > 0);
    const uncategorized = readyDocuments.filter(item => !item.categoryId);
    const groups: typeof namedGroups = [];
    if (uncategorized.length) {
      groups.push({ id: "__uncategorized__", label: "未分类", color: "", documents: uncategorized });
    }
    groups.push(...namedGroups);
    return groups;
  }, [sortedCategories, readyDocuments]);
  const visibleGroups = useMemo(
    () => selectedCategories.size
      ? categoryGroups.filter(group => group.id !== "__uncategorized__" && selectedCategories.has(group.id))
      : categoryGroups,
    [categoryGroups, selectedCategories],
  );

  const reloadCategories = async () => {
    if (!project.workspace?.root) return;
    try { setCategories(await listKnowledgeCategories(project.workspace)); } catch { /* 知识库不可用时忽略分类加载 */ }
  };
  const addCategory = async () => {
    const name = categoryName.trim();
    if (!name || !project.workspace) return;
    setCategoryBusy(true);
    try {
      const category: KnowledgeCategory = { id: crypto.randomUUID(), name, order: categories.length, color: categoryColor };
      const saved = await saveKnowledgeCategory(project.workspace, category);
      setCategories(current => [...current, saved].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)));
      setCategoryName("");
    } catch (error) { notify(error instanceof Error ? error.message : "添加分类失败"); }
    finally { setCategoryBusy(false); }
  };
  const updateCategory = async (category: KnowledgeCategory, patch: Partial<KnowledgeCategory>) => {
    if (!project.workspace) return;
    const next = { ...category, ...patch };
    try {
      const saved = await saveKnowledgeCategory(project.workspace, next);
      setCategories(current => current.map(c => c.id === saved.id ? saved : c).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)));
    } catch (error) { notify(error instanceof Error ? error.message : "更新分类失败"); }
  };
  const removeCategory = async (category: KnowledgeCategory) => {
    if (!project.workspace) return;
    if (!confirm(`删除分类“${category.name}”？\n\n该分类下的文档会移回“未分类”，分类名称不可恢复。`)) return;
    setCategoryBusy(true);
    try {
      await deleteKnowledgeCategory(project.workspace, category.id);
      setCategories(current => current.filter(c => c.id !== category.id));
      setSelectedCategories(current => { const next = new Set(current); next.delete(category.id); return next; });
      setDocuments(current => current.map(d => d.categoryId === category.id ? { ...d, categoryId: undefined } : d));
    } catch (error) { notify(error instanceof Error ? error.message : "删除分类失败"); }
    finally { setCategoryBusy(false); }
  };
  const moveCategory = async (category: KnowledgeCategory, direction: -1 | 1) => {
    if (!project.workspace) return;
    const index = sortedCategories.findIndex(c => c.id === category.id);
    const swapWith = sortedCategories[index + direction];
    if (!swapWith) return;
    const target = { ...swapWith, order: category.order };
    const self = { ...category, order: swapWith.order };
    try {
      await Promise.all([
        saveKnowledgeCategory(project.workspace, self),
        saveKnowledgeCategory(project.workspace, target),
      ]);
      setCategories(current => current.map(c => {
        if (c.id === self.id) return self;
        if (c.id === target.id) return target;
        return c;
      }).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)));
    } catch (error) { notify(error instanceof Error ? error.message : "调整顺序失败"); }
  };
  const assignCategory = async (documentId: string, categoryId: string | null) => {
    if (!project.workspace) return;
    try {
      await setKnowledgeDocumentCategory(project.workspace, documentId, categoryId);
      setDocuments(current => current.map(d => d.id === documentId ? { ...d, categoryId: categoryId ?? undefined } : d));
    } catch (error) { notify(error instanceof Error ? error.message : "设置分类失败"); }
  };
  const headingSourceLabel = (source: KnowledgeSection["headingSource"]) => ({ markdown: "原生标题", toc: "目录匹配", numbering: "编号识别", model: "模型识别", user: "人工确认" }[source] ?? source);

  return <div className="modal-backdrop knowledge-manager-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <div className="modal knowledge-manager-modal" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title"><div><BookOpen size={19} /><span>知识管理</span></div><IconButton title="关闭" onClick={() => !busy && close()}><X size={18} /></IconButton></div>
      <div className="knowledge-manager-toolbar"><div><b>{readyDocuments.length}</b><span>已就绪</span><b>{changed.length}</b><span>待更新</span><b>{unindexed.length}</b><span>未入库</span></div><div>{changed.length > 0 && <button disabled={busy} onClick={() => void rebuildChanged()}><RefreshCw size={14} />更新索引 ({changed.length})</button>}<button disabled={busy} onClick={() => void reload()}><RefreshCw size={14} />扫描目录</button><div className="knowledge-filter-wrap"><button className={selectedCategories.size ? "active" : ""} disabled={busy} onClick={() => setCategoryFilterOpen(open => !open)} title="按分类筛选知识"><Tag size={14} />分类{selectedCategories.size ? `(${selectedCategories.size})` : ""}</button>{categoryFilterOpen && <div className="knowledge-category-pop" onMouseDown={event => { if (event.target === event.currentTarget) setCategoryFilterOpen(false); }}>
        <div className="knowledge-category-pop-actions">
          <input value={categoryFilterQuery} onChange={event => setCategoryFilterQuery(event.target.value)} placeholder="筛选分类名称" />
          {selectedCategories.size > 0 && <button type="button" onClick={() => setSelectedCategories(new Set())}>清除</button>}
        </div>
        <div className="knowledge-category-pop-items">
          {sortedCategories.filter(category => category.name.toLocaleLowerCase().includes(categoryFilterQuery.trim().toLocaleLowerCase())).map(category => <label key={category.id} className={selectedCategories.has(category.id) ? "active" : ""}>
            <input type="checkbox" checked={selectedCategories.has(category.id)} onChange={() => { const next = new Set(selectedCategories); if (next.has(category.id)) next.delete(category.id); else next.add(category.id); setSelectedCategories(next); }} />
            <Check size={13} aria-hidden="true" />
            <span>{category.name}</span>
          </label>)}
          {!sortedCategories.length && <div className="knowledge-category-pop-empty">暂无分类，可在“分类管理”中创建</div>}
        </div>
      </div>}</div><button disabled={busy} onClick={() => setManageOpen(true)} title="管理知识分类（新增 / 重命名 / 删除 / 排序）"><Tags size={14} />分类管理</button><button disabled={busy} onClick={() => setImportKind("document")} title="通过拖拽或文件路径导入 Word/PDF"><FilePlus2 size={15} />导入 Word/PDF…</button><button className="primary" disabled={busy} onClick={() => setImportKind("markdown")}><FilePlus2 size={15} />导入 Markdown…</button></div></div>
      <label className="knowledge-search"><Search size={16} /><input type="search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="搜索文档标题、章节和正文" aria-label="搜索知识库" />{searching && <LoaderCircle className="spinning" size={15} />}{searchQuery && !searching && <IconButton title="清空搜索" onClick={() => setSearchQuery("")}><X size={14} /></IconButton>}</label>
      {progress && busy && !headingReview && <div className="knowledge-progress"><span>{progress.message}</span><b>{progress.stage === "structure_ai" ? `已等待 ${busySeconds} 秒` : progress.total > 1 ? `${progress.current}/${progress.total}` : `已进行 ${busySeconds} 秒`}</b></div>}
      {searchQuery.trim() ? <section className="knowledge-search-results">
        <div className="knowledge-manager-heading"><span>搜索结果</span><b>{searchResults.length}</b></div>
        <div className="knowledge-manager-scroll">
          {searchResults.map(result => <button className="knowledge-search-result" key={result.chunk.id} onClick={() => previewSearchResult(result)}><div><b>{result.chunk.documentTitle}</b><span>{result.chunk.headingPath}</span><small>{countMarkdownWords(result.chunk.content).toLocaleString()} 字</small></div><p>{result.excerpt}</p><Eye size={14} /></button>)}
          {!searching && !searchResults.length && <div className="knowledge-manager-empty"><Search size={20} /><span>没有找到匹配的知识内容</span></div>}
        </div>
      </section> : <div className="knowledge-manager-body">
        <section className="knowledge-manager-column"><div className="knowledge-manager-heading"><span>待处理与更新</span><b>{pending.length}</b></div><div className="knowledge-manager-scroll">
          {pending.map(item => <article className="knowledge-manager-pending" key={item.path}><div><b>{item.title}</b><span title={item.path}>{item.path}</span></div><em className={`knowledge-file-state ${item.state}`}>{item.state === "changed" ? "索引待更新" : "尚未入库"}</em><div className="knowledge-pending-actions"><button disabled={busy} onClick={() => void analyze(item.path)}>{item.state === "changed" ? "重新识别" : "识别结构"}</button><button disabled={busy} onClick={() => void returnPendingToWorkspace(item)}><Undo2 size={13} />转回工作区</button><IconButton title="删除知识副本" disabled={busy} onClick={() => void deletePending(item)}><Trash2 size={13} /></IconButton></div></article>)}
          {!pending.length && <div className="knowledge-manager-empty"><Check size={20} /><span>所有知识文档均已就绪</span></div>}
        </div></section>
        <section className="knowledge-manager-column indexed"><div className="knowledge-manager-heading"><span>已就绪</span><b>{readyDocuments.length}</b></div><div className="knowledge-manager-scroll">
          {visibleGroups.map(group => <div className="knowledge-manager-group" key={group.id}><div className="knowledge-section-heading"><div>{group.color ? <span className="knowledge-group-dot" style={{ background: group.color }} /> : <FolderSearch size={14} />}<b>{group.label}</b><span>{group.documents.length}</span></div></div>
            {group.documents.map(document => <article className="knowledge-document" key={document.id}><div className="knowledge-document-head"><button className="knowledge-expand" title="展开章节" onClick={() => void toggleDocument(document.id)}>{expanded.has(document.id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button><div><b>{document.title}</b><span>{document.sectionCount} 章 · {document.chunkCount} 片 · 全文 {document.charCount.toLocaleString()} 字</span><code title={document.location}>{document.location}</code></div><select className="knowledge-category-select" value={document.categoryId ?? ""} onChange={event => void assignCategory(document.id, event.target.value || null)} title="设置知识分类" aria-label={`${document.title} 所属分类`}><option value="">未分类</option>{sortedCategories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div>
              {document.error && <p className="knowledge-error">{document.error}</p>}
              <div className="source-item-actions knowledge-actions"><button onClick={() => void previewDocument(document)}><Eye size={12} />预览全文</button>{document.sourceUrl && <button onClick={() => void openExternalUrl(document.sourceUrl!)}><ExternalLink size={12} />原网页</button>}{document.sourceType === "markdown" && <button disabled={busy} onClick={() => void analyze(document.location)}>重新识别</button>}{document.sourceType === "markdown" && <button disabled={busy} onClick={() => void restore(document)}>恢复原文</button>}<button disabled={busy} onClick={() => void removeIndexed(document)}>移出</button><button className="danger" disabled={busy} onClick={() => void deleteIndexed(document)}><Trash2 size={12} />删除</button></div>
              {expanded.has(document.id) && <div className="knowledge-tree">{(sections[document.id] ?? []).map(section => <div className="knowledge-manager-section" key={section.id} style={{ paddingLeft: `${8 + Math.max(0, section.level - 1) * 14}px` }}><i>H{section.level || 1}</i><span>{section.title}</span><small>{headingSourceLabel(section.headingSource)}</small><em className="knowledge-section-char-count">{section.charCount.toLocaleString()} 字</em><em className={`knowledge-quality-badge ${section.quality}`}>{section.quality === "good" ? "优质" : section.quality === "bad" ? "劣质" : "普通"}</em><div className="knowledge-manager-quality" role="group" aria-label={`${section.title}片段状态`}><IconButton title="标记为优质" active={section.quality === "good"} disabled={busy} onClick={() => void markSectionQuality(section, "good")}><ThumbsUp size={12} /></IconButton><IconButton title="标记为普通" active={section.quality === "normal"} disabled={busy} onClick={() => void markSectionQuality(section, "normal")}><Minus size={12} /></IconButton><IconButton title="标记为劣质" active={section.quality === "bad"} disabled={busy} onClick={() => void markSectionQuality(section, "bad")}><ThumbsDown size={12} /></IconButton></div><IconButton title="预览知识片段" onClick={() => void previewSection(document, section)}><Eye size={13} /></IconButton><em>{section.chunkCount}</em></div>)}</div>}
            </article>)}
          </div>)}
          {selectedCategories.size > 0 && !visibleGroups.length && <div className="knowledge-manager-empty"><Tags size={20} /><span>没有符合所选分类的知识文档</span></div>}
          {!readyDocuments.length && <div className="knowledge-manager-empty"><BookOpen size={20} /><span>暂无已就绪文档</span></div>}
        </div></section>
      </div>}
    </div>
    {importKind && project.workspace && <FileUploadPanel
      title={importKind === "markdown" ? "导入 Markdown 到知识库" : "导入 Word / PDF 到知识库"}
      description={importKind === "markdown"
        ? "拖入 Markdown，或选择完整文件路径。导入后将先识别章节结构，再由你确认入库。"
        : "拖入 Word / PDF，或选择完整文件路径。MinerU 转换完成后将进入章节结构确认；原始文件会复制到工作区 imports 目录保留。"}
      extensions={importKind === "markdown" ? KNOWLEDGE_MARKDOWN_EXTENSIONS : KNOWLEDGE_DOCUMENT_EXTENSIONS}
      extensionLabel={importKind === "markdown" ? "Markdown（.md / .markdown）" : "Word / PDF（.doc / .docx / .pdf）"}
      destination={project.workspace.historyDir}
      busy={busy}
      submitLabel={importKind === "markdown" ? "识别并导入" : "解析并导入"}
      choosePath={() => importKind === "markdown"
        ? pickMarkdownFile("选择要导入知识库的 Markdown", project.workspace?.historyDir)
        : pickDocumentFile("选择要导入知识库的 Word / PDF", project.workspace?.root)}
      upload={async path => {
        const succeeded = importKind === "markdown" ? await importFile(path) : await importWordPdf(path);
        if (succeeded) setImportKind(null);
        return succeeded;
      }}
      close={() => setImportKind(null)}
    />}
    {headingReview && <HeadingReviewModal result={headingReview} candidates={headingCandidates} setCandidates={setHeadingCandidates} busy={busy} progress={progress} busySeconds={busySeconds} close={() => { if (!busy) { setHeadingReview(null); setHeadingCandidates([]); } }} confirm={() => void confirmReview()} />}
    {manageOpen && project.workspace && <div className="modal-backdrop knowledge-category-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setManageOpen(false); }}>
      <div className="modal knowledge-category-modal" onMouseDown={event => event.stopPropagation()}>
        <div className="modal-title"><div><Tags size={19} /><span>知识分类管理</span></div><IconButton title="关闭" onClick={() => setManageOpen(false)}><X size={18} /></IconButton></div>
        <div className="knowledge-category-manager-body">
          <div className="knowledge-category-add">
            <input value={categoryName} onChange={event => setCategoryName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void addCategory(); }} placeholder="新分类名称" aria-label="新分类名称" />
            <div className="knowledge-category-colors">{CATEGORY_COLORS.map(color => <button key={color} type="button" className={categoryColor === color ? "active" : ""} style={{ background: color }} onClick={() => setCategoryColor(color)} aria-label={`颜色 ${color}`} />)}</div>
            <button className="primary" disabled={categoryBusy || !categoryName.trim()} onClick={() => void addCategory()}><Plus size={14} />添加</button>
          </div>
          <div className="knowledge-category-list">
            {!sortedCategories.length && <div className="knowledge-manager-empty"><Tags size={20} /><span>还没有分类，先添加一个吧</span></div>}
            {sortedCategories.map(category => <div className="knowledge-category-row" key={category.id}>
              <span className="knowledge-category-color" style={{ background: category.color }} />
              {editingCategoryId === category.id
                ? <input className="knowledge-category-edit" autoFocus value={editingCategoryName} onChange={event => setEditingCategoryName(event.target.value)} onBlur={() => { const name = editingCategoryName.trim(); setEditingCategoryId(null); if (name && name !== category.name) void updateCategory(category, { name }); else setEditingCategoryName(""); }} onKeyDown={event => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); else if (event.key === "Escape") { setEditingCategoryId(null); setEditingCategoryName(""); } }} aria-label="重命名分类" />
                : <span className="knowledge-category-name" title="点击重命名" onClick={() => { setEditingCategoryId(category.id); setEditingCategoryName(category.name); }}>{category.name}</span>}
              <div className="knowledge-category-row-actions">
                <div className="knowledge-category-colors inline">{CATEGORY_COLORS.map(color => <button key={color} type="button" className={category.color === color ? "active" : ""} style={{ background: color }} onClick={() => void updateCategory(category, { color })} aria-label={`设为颜色 ${color}`} />)}</div>
                <IconButton title="上移" disabled={categoryBusy} onClick={() => void moveCategory(category, -1)}><ChevronUp size={14} /></IconButton>
                <IconButton title="下移" disabled={categoryBusy} onClick={() => void moveCategory(category, 1)}><ChevronDown size={14} /></IconButton>
                <IconButton title="删除分类" className="danger" disabled={categoryBusy} onClick={() => void removeCategory(category)}><Trash2 size={14} /></IconButton>
              </div>
            </div>)}
          </div>
        </div>
      </div>
    </div>}
    {preview && <SourcePreviewModal source={preview.source} markdown={preview.markdown} loading={preview.loading} error={preview.error} workspaceRoot={project.workspace?.root} notify={notify} close={() => setPreview(null)} />}
  </div>;
}
