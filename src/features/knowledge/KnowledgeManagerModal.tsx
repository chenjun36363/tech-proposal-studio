import { useEffect, useState } from "react";
import { BookOpen, Check, ChevronDown, ChevronRight, ExternalLink, Eye, FilePlus2, FolderSearch, Globe2, Minus, RefreshCw, ThumbsDown, ThumbsUp, Trash2, Undo2, X } from "lucide-react";
import { HeadingReviewModal } from "../../components/HeadingReviewModal";
import { IconButton } from "../../components/IconButton";
import { SourcePreviewModal } from "../../components/SourcePreviewModal";
import {
  analyzeKnowledgeMarkdown, applyKnowledgeHeadings, deleteKnowledgeFile, listKnowledgeBackups,
  listKnowledge, listKnowledgeSectionChunks, listKnowledgeSections, onKnowledgeProgress,
  removeKnowledgeDocument, restoreKnowledgeBackup, scanKnowledge, setKnowledgeSectionQuality,
} from "../../knowledge";
import { openExternalUrl } from "../../services/system";
import type {
  DocumentBlock, HeadingCandidate, HeadingDetectionResult, HeadingReviewDecision,
  KnowledgeChunkQuality, KnowledgeDocument, KnowledgeProgress, KnowledgeScanItem,
  KnowledgeSection, Project, SourceRecord, WorkspacePaths,
} from "../../types";
import { importMarkdownToWorkspace, pickMarkdownFile, readTextFile } from "../../workspace";

type ProjectUpdater = (updater: (project: Project) => Project) => void;
type BlockUpdater = (updater: (block: DocumentBlock) => DocumentBlock) => void;

const resolveWorkspaceLocation = (root: string, location: string) => /^[a-zA-Z]:[\\/]|^\\\\/.test(location)
  ? location
  : `${root.replace(/[\\/]$/, "")}\\${location.replace(/\//g, "\\")}`;

export function KnowledgeManagerModal({ project, updateProject, updateBlock, refreshWorkspaceDocs, openMarkdownPath, notify, close }: {
  project: Project;
  updateProject: ProjectUpdater;
  updateBlock: BlockUpdater;
  refreshWorkspaceDocs: (workspace?: WorkspacePaths) => Promise<void>;
  openMarkdownPath: (path: string) => Promise<void>;
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

  const reload = async () => {
    if (!project.workspace?.root) return;
    const [nextDocuments, scanned] = await Promise.all([listKnowledge(project.workspace), scanKnowledge(project.workspace)]);
    setDocuments(nextDocuments);
    setPending(scanned.filter(item => item.state !== "indexed"));
  };

  useEffect(() => { void reload().catch(error => notify(error instanceof Error ? error.message : "知识库加载失败")); }, [project.workspace?.root]);
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
    try {
      const result = await analyzeKnowledgeMarkdown(project.workspace, path, project.model);
      setHeadingReview(result);
      setHeadingCandidates(result.candidates);
    } catch (error) { notify(error instanceof Error ? error.message : "文档结构识别失败"); }
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
      const workspacePath = await importMarkdownToWorkspace(item.path, project.workspace.root);
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

  const groups = [
    { id: "local", label: "本地 Markdown", documents: documents.filter(item => item.sourceType === "markdown") },
    { id: "web", label: "网页知识", documents: documents.filter(item => item.sourceType === "web") },
  ].filter(group => group.documents.length);
  const headingSourceLabel = (source: KnowledgeSection["headingSource"]) => ({ markdown: "原生标题", toc: "目录匹配", numbering: "编号识别", model: "模型识别", user: "人工确认" }[source] ?? source);

  return <div className="modal-backdrop knowledge-manager-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <div className="modal knowledge-manager-modal" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title"><div><BookOpen size={19} /><span>知识管理</span></div><IconButton title="关闭" onClick={() => !busy && close()}><X size={18} /></IconButton></div>
      <div className="knowledge-manager-toolbar"><div><b>{documents.length}</b><span>已入库</span><b>{pending.length}</b><span>待处理</span></div><div><button disabled={busy} onClick={() => void reload()}><RefreshCw size={14} />扫描目录</button><button className="primary" disabled={busy} onClick={() => void importFile()}><FilePlus2 size={15} />导入 Markdown</button></div></div>
      {progress && busy && !headingReview && <div className="knowledge-progress"><span>{progress.message}</span><b>{progress.stage === "structure_ai" ? `已等待 ${busySeconds} 秒` : progress.total > 1 ? `${progress.current}/${progress.total}` : `已进行 ${busySeconds} 秒`}</b></div>}
      <div className="knowledge-manager-body">
        <section className="knowledge-manager-column"><div className="knowledge-manager-heading"><span>待处理</span><b>{pending.length}</b></div><div className="knowledge-manager-scroll">
          {pending.map(item => <article className="knowledge-manager-pending" key={item.path}><div><b>{item.title}</b><span title={item.path}>{item.path}</span></div><em className={`knowledge-file-state ${item.state}`}>{item.state === "changed" ? "内容已更新" : "尚未索引"}</em><div className="knowledge-pending-actions"><button disabled={busy} onClick={() => void analyze(item.path)}>识别结构</button><button disabled={busy} onClick={() => void returnPendingToWorkspace(item)}><Undo2 size={13} />转回工作区</button><IconButton title="删除知识副本" disabled={busy} onClick={() => void deletePending(item)}><Trash2 size={13} /></IconButton></div></article>)}
          {!pending.length && <div className="knowledge-manager-empty"><Check size={20} /><span>没有待处理文档</span></div>}
        </div></section>
        <section className="knowledge-manager-column indexed"><div className="knowledge-manager-heading"><span>已入库</span><b>{documents.length}</b></div><div className="knowledge-manager-scroll">
          {groups.map(group => <div className="knowledge-manager-group" key={group.id}><div className="knowledge-section-heading"><div>{group.id === "local" ? <FolderSearch size={14} /> : <Globe2 size={14} />}<b>{group.label}</b><span>{group.documents.length}</span></div></div>
            {group.documents.map(document => <article className="knowledge-document" key={document.id}><div className="knowledge-document-head"><button className="knowledge-expand" title="展开章节" onClick={() => void toggleDocument(document.id)}>{expanded.has(document.id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button><div><b>{document.title}</b><span>{document.sectionCount} 章 · {document.chunkCount} 片</span><code title={document.location}>{document.location}</code></div><em className="knowledge-status ready">已就绪</em></div>
              {document.error && <p className="knowledge-error">{document.error}</p>}
              <div className="source-item-actions knowledge-actions"><button onClick={() => void previewDocument(document)}><Eye size={12} />预览全文</button>{document.sourceUrl && <button onClick={() => void openExternalUrl(document.sourceUrl!)}><ExternalLink size={12} />原网页</button>}{document.sourceType === "markdown" && <button disabled={busy} onClick={() => void analyze(document.location)}>重新识别</button>}{document.sourceType === "markdown" && <button disabled={busy} onClick={() => void restore(document)}>恢复原文</button>}<button disabled={busy} onClick={() => void removeIndexed(document)}>移出</button><button className="danger" disabled={busy} onClick={() => void deleteIndexed(document)}><Trash2 size={12} />删除</button></div>
              {expanded.has(document.id) && <div className="knowledge-tree">{(sections[document.id] ?? []).map(section => <div className="knowledge-manager-section" key={section.id} style={{ paddingLeft: `${8 + Math.max(0, section.level - 1) * 14}px` }}><i>H{section.level || 1}</i><span>{section.title}</span><small>{headingSourceLabel(section.headingSource)}</small><em className={`knowledge-quality-badge ${section.quality}`}>{section.quality === "good" ? "优质" : section.quality === "bad" ? "劣质" : "普通"}</em><div className="knowledge-manager-quality" role="group" aria-label={`${section.title}片段状态`}><IconButton title="标记为优质" active={section.quality === "good"} disabled={busy} onClick={() => void markSectionQuality(section, "good")}><ThumbsUp size={12} /></IconButton><IconButton title="标记为普通" active={section.quality === "normal"} disabled={busy} onClick={() => void markSectionQuality(section, "normal")}><Minus size={12} /></IconButton><IconButton title="标记为劣质" active={section.quality === "bad"} disabled={busy} onClick={() => void markSectionQuality(section, "bad")}><ThumbsDown size={12} /></IconButton></div><IconButton title="预览知识片段" onClick={() => void previewSection(document, section)}><Eye size={13} /></IconButton><em>{section.chunkCount}</em></div>)}</div>}
            </article>)}
          </div>)}
          {!documents.length && <div className="knowledge-manager-empty"><BookOpen size={20} /><span>暂无已入库文档</span></div>}
        </div></section>
      </div>
    </div>
    {headingReview && <HeadingReviewModal result={headingReview} candidates={headingCandidates} setCandidates={setHeadingCandidates} busy={busy} progress={progress} busySeconds={busySeconds} close={() => { if (!busy) { setHeadingReview(null); setHeadingCandidates([]); } }} confirm={() => void confirmReview()} />}
    {preview && <SourcePreviewModal source={preview.source} markdown={preview.markdown} loading={preview.loading} error={preview.error} workspaceRoot={project.workspace?.root} notify={notify} close={() => setPreview(null)} />}
  </div>;
}
