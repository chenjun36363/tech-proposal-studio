import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Info,
  Layers3,
  Minus,
  Search,
  Sparkles,
  Tag,
  TerminalSquare,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { AgentConversationPanel } from "../../components/AgentConversationPanel";
import { CliAgentConversationPanel } from "../../components/CliAgentConversationPanel";
import { LongWritingPanel } from "../longWriting/LongWritingPanel";
import type { TextFileSnapshot } from "../workspace/documentSafety";
import type { AgentSearchHighlight, AgentWorkspaceRuntime } from "../../agent/proposalTools";
import type { AgentDraft, AgentEditorSelection } from "../../agent/protocol";
import { IconButton } from "../../components/IconButton";
import {
  getKnowledgeChunk,
  getKnowledgeSectionScope,
  listKnowledge,
  listKnowledgeCategories,
  searchKnowledge,
  setKnowledgeChunkQuality,
} from "../knowledge/knowledge";
import { isDesktop } from "../../services/runtime";
import type {
  DocumentBlock,
  KnowledgeCategory,
  KnowledgeChunk,
  KnowledgeChunkQuality,
  KnowledgeDocument,
  KnowledgeSearchField,
  KnowledgeSearchResult,
  KnowledgeSectionScope,
  Project,
  SourceRecord,
} from "../../core/types";
import { readTextFile } from "../workspace/workspace";
import { ContextPanel } from "./ContextPanel";

const PowerShellTerminal = lazy(() => import("../terminal/PowerShellTerminal").then(module => ({
  default: module.PowerShellTerminal,
})));

export type InspectorTab = "long-writing" | "commands" | "context" | "sources" | "terminal";
type ProjectUpdater = (updater: (project: Project) => Project, remember?: boolean) => void;
type BlockUpdater = (updater: (block: DocumentBlock) => DocumentBlock) => void;
type KnowledgeResultView = KnowledgeSearchResult & {
  scope: KnowledgeSectionScope;
  scopeHistory: KnowledgeSectionScope[];
};

const SEARCH_FIELDS: Array<{ id: KnowledgeSearchField; label: string }> = [
  { id: "documentTitle", label: "标题" },
  { id: "headingPath", label: "章节" },
  { id: "content", label: "正文" },
];

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
    content: result.chunk.content.trim()
      ? `${heading}\n\n${result.chunk.content.trim()}`
      : heading,
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

export function InspectorPanel({
  tab,
  setTab,
  project,
  block,
  updateProject,
  updateBlock,
  agentSelection,
  clearAgentSelection,
  applyAgentDraft,
  agentWorkspaceRuntime,
  onAgentDocumentSearch,
  notify,
  openSourcePreview,
  longWritingBaselineHash,
  saveBeforeLongWriting,
  onLongWritingSnapshot,
  onLongWritingLockChange,
  onLocateLongWritingChapter,
}: {
  tab: InspectorTab;
  setTab: (tab: InspectorTab) => void;
  project: Project;
  block: DocumentBlock;
  updateProject: ProjectUpdater;
  updateBlock: BlockUpdater;
  agentSelection?: AgentEditorSelection;
  clearAgentSelection: () => void;
  applyAgentDraft: (draft: AgentDraft) => void;
  agentWorkspaceRuntime?: AgentWorkspaceRuntime;
  onAgentDocumentSearch?: (search: AgentSearchHighlight) => void;
  notify: (message: string) => void;
  openSourcePreview: (source: SourceRecord) => Promise<void>;
  longWritingBaselineHash: string | null;
  saveBeforeLongWriting: (content?: string) => Promise<TextFileSnapshot | null>;
  onLongWritingSnapshot: (snapshot: TextFileSnapshot) => Promise<void> | void;
  onLongWritingLockChange: (locked: boolean) => void;
  onLocateLongWritingChapter: (titlePath: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [qualityFilters, setQualityFilters] = useState<Set<KnowledgeChunkQuality>>(
    () => new Set(["good", "normal"]),
  );
  const [searchFields, setSearchFields] = useState<Set<KnowledgeSearchField>>(
    () => new Set(SEARCH_FIELDS.map(field => field.id)),
  );
  const [sourceContents, setSourceContents] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<KnowledgeResultView[]>([]);
  const [knowledgeChunks, setKnowledgeChunks] = useState<Record<string, KnowledgeChunk>>({});
  const [terminalVisited, setTerminalVisited] = useState(tab === "terminal");
  const [agentMode, setAgentMode] = useState<"conversation" | "long-writing">("conversation");
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<KnowledgeDocument[]>([]);
  const [selectedDocuments, setSelectedDocuments] = useState<Set<string>>(new Set());
  const [docFilterOpen, setDocFilterOpen] = useState(false);
  const [docFilterQuery, setDocFilterQuery] = useState("");
  const [knowledgeCategories, setKnowledgeCategories] = useState<KnowledgeCategory[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [categoryFilterOpen, setCategoryFilterOpen] = useState(false);
  const [categoryFilterQuery, setCategoryFilterQuery] = useState("");
  const desktop = isDesktop();
  const contextSources = useMemo(
    () => project.sources.filter(source => block.sourceRefs.includes(source.id)),
    [project.sources, block.sourceRefs],
  );
  const context = useMemo(
    () => contextSources.map(source => {
      const chunk = knowledgeChunks[source.id];
      const content = chunk?.content ?? source.content ?? sourceContents[source.id] ?? source.excerpt;
      const title = chunk
        ? `${chunk.documentTitle} / ${chunk.headingPath}`
        : source.heading
          ? `${source.title} / ${source.heading}`
          : source.title;
      return `${title}:\n${content}`;
    }),
    [contextSources, knowledgeChunks, sourceContents],
  );
  const resolvedAgentContext = useMemo(
    () => contextSources.map(source => ({
      source,
      content: knowledgeChunks[source.id]?.content
        ?? source.content
        ?? sourceContents[source.id]
        ?? source.excerpt,
    })),
    [contextSources, knowledgeChunks, sourceContents],
  );

  useEffect(() => {
    if (tab === "terminal") setTerminalVisited(true);
  }, [tab]);

  useEffect(() => {
    if (!desktop || !["long-writing", "context", "commands"].includes(tab)) return;
    const pending = contextSources.filter(source =>
      source.kind === "local"
      && !source.content
      && !source.location.startsWith("knowledge:")
      && !Object.prototype.hasOwnProperty.call(sourceContents, source.id));
    if (!pending.length) return;
    let cancelled = false;
    void Promise.all(pending.map(async source => {
      try {
        return [source.id, await readTextFile(source.location)] as const;
      } catch {
        return [source.id, ""] as const;
      }
    })).then(entries => {
      if (!cancelled) {
        setSourceContents(current => ({ ...current, ...Object.fromEntries(entries) }));
      }
    });
    return () => { cancelled = true; };
  }, [desktop, tab, contextSources, sourceContents]);

  useEffect(() => {
    if (!desktop || !project.workspace?.root) return;
    const ids = block.sourceRefs.filter(id => id.startsWith("kc-") && !knowledgeChunks[id]);
    if (!ids.length) return;
    void Promise.all(ids.map(id => getKnowledgeChunk(project.workspace!, id).catch(() => null)))
      .then(chunks => {
        const available = chunks.filter((chunk): chunk is KnowledgeChunk => chunk !== null);
        setKnowledgeChunks(current => ({
          ...current,
          ...Object.fromEntries(available.map(chunk => [chunk.id, chunk])),
        }));
      });
  }, [desktop, project.workspace, block.sourceRefs, knowledgeChunks]);

  useEffect(() => {
    if (!desktop || tab !== "sources" || !project.workspace?.root) return;
    let cancelled = false;
    void listKnowledge(project.workspace)
      .then(documents => { if (!cancelled) setKnowledgeDocuments(documents); })
      .catch(() => undefined);
    void listKnowledgeCategories(project.workspace)
      .then(categories => { if (!cancelled) setKnowledgeCategories(categories); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [desktop, tab, project.workspace?.root]);

  const updateSourceContext = (
    sourceId: string,
    source?: SourceRecord,
    mode: "add" | "remove" | "toggle" = "add",
  ) => {
    updateProject(current => {
      const currentRefs = current.contextSourceRefs;
      const included = currentRefs.includes(sourceId);
      const shouldInclude = mode === "toggle" ? !included : mode === "add";
      const sourceRefs = shouldInclude
        ? included ? currentRefs : [...currentRefs, sourceId]
        : currentRefs.filter(id => id !== sourceId);
      const sources = source && !current.sources.some(item => item.id === source.id)
        ? [...current.sources, source]
        : current.sources;
      return { ...current, sources, contextSourceRefs: sourceRefs };
    });
  };

  const copyText = async (text: string, message: string) => {
    try { await navigator.clipboard.writeText(text); notify(message); }
    catch { notify("复制失败，请检查剪贴板权限"); }
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
    void openSourcePreview({
      id: scope.id,
      kind: "local",
      title: scope.documentTitle,
      location: `knowledge:${scope.documentId}`,
      excerpt: scope.content.replace(/\s+/g, " ").slice(0, 280),
      fingerprint: scope.id,
      accessedAt: new Date().toISOString(),
      heading: scope.headingPath,
      content: scope.content,
    });
  };

  const loadSearchResults = async () => {
    if (!query.trim() || !project.workspace) {
      setResults([]);
      return;
    }
    const qualities = (["good", "normal", "bad"] as KnowledgeChunkQuality[])
      .filter(quality => qualityFilters.has(quality));
    const found = await searchKnowledge(
      project.workspace,
      query,
      qualities,
      [...searchFields],
      undefined,
      selectedDocuments.size > 0 ? [...selectedDocuments] : undefined,
      selectedCategories.size > 0 ? [...selectedCategories] : undefined,
    );
    const scopes = await Promise.all(found.map(result =>
      getKnowledgeSectionScope(project.workspace!, result.scopeSectionId)
        .catch(() => scopeFromSearchResult(result))));
    setResults(found.map((result, index) => ({
      ...result,
      scope: scopes[index],
      scopeHistory: [],
    })));
  };

  const runKnowledgeSearch = async () => {
    setSearching(true);
    try {
      await loadSearchResults();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "知识库搜索失败");
    } finally {
      setSearching(false);
    }
  };

  const moveResultUp = async (index: number) => {
    const result = results[index];
    if (!project.workspace || !result?.scope.parentId || !result.scope.canMoveUp) return;
    try {
      const scope = await getKnowledgeSectionScope(project.workspace, result.scope.parentId);
      setResults(current => current.map((item, itemIndex) => itemIndex === index
        ? { ...item, scope, scopeHistory: [...item.scopeHistory, item.scope] }
        : item));
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "无法扩大章节范围");
    }
  };

  const moveResultDown = (index: number) => {
    setResults(current => current.map((item, itemIndex) => {
      if (itemIndex !== index || !item.scopeHistory.length) return item;
      return {
        ...item,
        scope: item.scopeHistory.at(-1)!,
        scopeHistory: item.scopeHistory.slice(0, -1),
      };
    }));
  };

  const toggleQuality = (quality: KnowledgeChunkQuality) => {
    setQualityFilters(current => {
      if (current.has(quality) && current.size === 1) return current;
      const next = new Set(current);
      if (next.has(quality)) next.delete(quality);
      else next.add(quality);
      return next;
    });
  };

  const toggleSearchField = (field: KnowledgeSearchField) => {
    setSearchFields(current => {
      if (current.has(field) && current.size === 1) return current;
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const toggleDocument = (id: string) => {
    setSelectedDocuments(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllDocuments = () => setSelectedDocuments(new Set(knowledgeDocuments.map(doc => doc.id)));
  const clearDocuments = () => setSelectedDocuments(new Set());

  const toggleCategory = (id: string) => {
    setSelectedCategories(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearCategories = () => setSelectedCategories(new Set());

  const markQuality = async (chunk: KnowledgeChunk, quality: KnowledgeChunkQuality) => {
    if (!project.workspace || chunk.quality === quality) return;
    try {
      const updated = await setKnowledgeChunkQuality(project.workspace, chunk.id, quality);
      setKnowledgeChunks(current => ({ ...current, [updated.id]: updated }));
      await loadSearchResults();
      notify(`已标记为${quality === "good" ? "优质" : quality === "bad" ? "劣质" : "普通"}片段`);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "更新片段质量失败");
    }
  };

  return <aside className={`right-panel ${tab === "terminal" ? "terminal-mode" : ""}`}>
    <div className="inspector-top">
      <div className="tabs">
        <button className={tab === "commands" ? "active" : ""} onClick={() => setTab("commands")}><Bot size={15} />Agent</button>
        <button className={tab === "long-writing" ? "active" : ""} onClick={() => setTab("long-writing")}><Sparkles size={15} />长任务</button>
        <button className={tab === "context" ? "active" : ""} onClick={() => setTab("context")}><Layers3 size={15} />上下文</button>
        <button className={tab === "sources" ? "active" : ""} onClick={() => setTab("sources")}><BookOpen size={15} />知识库</button>
        <button className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}><TerminalSquare size={15} />终端</button>
      </div>
    </div>
    {tab === "long-writing" && <LongWritingPanel project={project} baselineHash={longWritingBaselineHash} saveBeforeStart={saveBeforeLongWriting} onDocumentSnapshot={onLongWritingSnapshot} onLockChange={onLongWritingLockChange} onLocateChapter={onLocateLongWritingChapter} onManageReferences={() => setTab("context")} notify={notify} />}
    <div className={`agent-mode-shell ${tab === "commands" ? "" : "is-hidden"}`} aria-hidden={tab !== "commands"}>
      <div className="agent-mode-tabs"><button className={agentMode === "conversation" ? "active" : ""} onClick={() => setAgentMode("conversation")}>内置Agent</button><button className={agentMode === "long-writing" ? "active" : ""} onClick={() => setAgentMode("long-writing")}>本地Agent</button></div>
      <div className={`agent-conversation-host ${agentMode === "conversation" ? "" : "is-hidden"}`}>
        <AgentConversationPanel project={project} block={block} pinnedContext={resolvedAgentContext} editorSelection={agentSelection} clearEditorSelection={clearAgentSelection} applyDraft={applyAgentDraft} workspaceRuntime={agentWorkspaceRuntime} onDocumentSearch={onAgentDocumentSearch} notify={notify} />
      </div>
      <div className={`long-writing-host ${agentMode === "long-writing" ? "" : "is-hidden"}`}>
        <CliAgentConversationPanel project={project} block={block} pinnedContext={resolvedAgentContext} editorSelection={agentSelection} clearEditorSelection={clearAgentSelection} applyDraft={applyAgentDraft} workspaceRuntime={agentWorkspaceRuntime} onDocumentSearch={onAgentDocumentSearch} notify={notify} />
      </div>
    </div>
    {tab === "context" && <ContextPanel contextSources={contextSources} context={context} updateBlock={updateBlock} updateSourceContext={updateSourceContext} openSourcePreview={openSourcePreview} sourceContent={source => source.content ?? knowledgeChunks[source.id]?.content ?? sourceContents[source.id] ?? source.excerpt} notify={notify} />}
    {tab === "sources" && <div className="inspector-content sources-panel knowledge-panel">
      {!desktop
        ? <div className="context-empty"><BookOpen size={24} /><span>知识库仅在桌面端可用</span></div>
        : <>
          <div className="knowledge-search-tool">
            <div className="knowledge-search-intro"><div><Search size={17} /><b>知识检索</b></div><span>查找可引用的方案依据</span></div>
            <div className="knowledge-query-row">
              <Search size={15} />
              <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => event.key === "Enter" && void runKnowledgeSearch()} placeholder="搜索标题、章节和正文" />
              <button type="button" title="搜索知识库" onClick={() => void runKnowledgeSearch()} disabled={searching}>{searching ? "检索中" : "检索"}</button>
            </div>
            <div className="knowledge-filter-row">
              <span>范围</span>
              <div className="knowledge-field-filter" role="group" aria-label="知识搜索范围">{SEARCH_FIELDS.map(field => <label key={field.id} className={searchFields.has(field.id) ? "active" : ""}>
                <input type="checkbox" checked={searchFields.has(field.id)} onChange={() => toggleSearchField(field.id)} />
                <Check size={13} aria-hidden="true" />
                <span>{field.label}</span>
              </label>)}</div>
            </div>
            <div className="knowledge-filter-row">
              <span>质量</span>
              <div className="knowledge-quality-filter" role="group" aria-label="片段质量筛选">{(["good", "normal", "bad"] as KnowledgeChunkQuality[]).map(quality => <label key={quality} className={qualityFilters.has(quality) ? "active" : ""}>
                <input type="checkbox" checked={qualityFilters.has(quality)} onChange={() => toggleQuality(quality)} />
                <Check size={13} aria-hidden="true" />
                <span>{quality === "good" ? "优质" : quality === "bad" ? "劣质" : "普通"}</span>
              </label>)}</div>
            </div>
            <div className="knowledge-filter-row knowledge-doc-filter">
              <span>文档</span>
              <div className="knowledge-doc-filter-body">
                <div className="knowledge-doc-filter-head">
                  <button type="button" className="knowledge-doc-toggle" onClick={() => setDocFilterOpen(open => !open)} aria-expanded={docFilterOpen}>
                    <FileText size={13} />
                    <span>{selectedDocuments.size === 0 ? "全部文档" : `已选 ${selectedDocuments.size}/${knowledgeDocuments.length} 个`}</span>
                    <ChevronDown size={12} className={docFilterOpen ? "open" : ""} />
                  </button>
                  {selectedDocuments.size > 0 && <button type="button" className="knowledge-doc-clear" onClick={clearDocuments}>清除</button>}
                </div>
                {docFilterOpen && <div className="knowledge-doc-list">
                  <div className="knowledge-doc-list-actions">
                    <input value={docFilterQuery} onChange={event => setDocFilterQuery(event.target.value)} placeholder="筛选文档名称" />
                    <button type="button" onClick={selectAllDocuments} disabled={!knowledgeDocuments.length}>全选</button>
                  </div>
                  <div className="knowledge-doc-list-items">
                    {knowledgeDocuments.filter(doc => doc.title.toLocaleLowerCase().includes(docFilterQuery.trim().toLocaleLowerCase())).map(doc => <label key={doc.id} className={selectedDocuments.has(doc.id) ? "active" : ""}>
                      <input type="checkbox" checked={selectedDocuments.has(doc.id)} onChange={() => toggleDocument(doc.id)} />
                      <Check size={13} aria-hidden="true" />
                      <span>{doc.title}</span>
                    </label>)}
                    {!knowledgeDocuments.length && <div className="knowledge-doc-list-empty">暂无知识文档</div>}
                  </div>
                </div>}
              </div>
            </div>
            <div className="knowledge-filter-row knowledge-doc-filter">
              <span>分类</span>
              <div className="knowledge-doc-filter-body">
                <div className="knowledge-doc-filter-head">
                  <button type="button" className="knowledge-doc-toggle" onClick={() => setCategoryFilterOpen(open => !open)} aria-expanded={categoryFilterOpen}>
                    <Tag size={13} />
                    <span>{selectedCategories.size === 0 ? "全部分类" : `已选 ${selectedCategories.size}/${knowledgeCategories.length} 个`}</span>
                    <ChevronDown size={12} className={categoryFilterOpen ? "open" : ""} />
                  </button>
                  {selectedCategories.size > 0 && <button type="button" className="knowledge-doc-clear" onClick={clearCategories}>清除</button>}
                </div>
                {categoryFilterOpen && <div className="knowledge-doc-list">
                  <div className="knowledge-doc-list-actions">
                    <input value={categoryFilterQuery} onChange={event => setCategoryFilterQuery(event.target.value)} placeholder="筛选分类名称" />
                  </div>
                  <div className="knowledge-doc-list-items">
                    {knowledgeCategories.filter(category => category.name.toLocaleLowerCase().includes(categoryFilterQuery.trim().toLocaleLowerCase())).map(category => <label key={category.id} className={selectedCategories.has(category.id) ? "active" : ""}>
                      <input type="checkbox" checked={selectedCategories.has(category.id)} onChange={() => toggleCategory(category.id)} />
                      <Check size={13} aria-hidden="true" />
                      <span>{category.name}</span>
                    </label>)}
                    {!knowledgeCategories.length && <div className="knowledge-doc-list-empty">暂无分类，可在“知识管理”中创建</div>}
                  </div>
                </div>}
              </div>
            </div>
          </div>
          {searching && <div className="loading-line">正在检索知识切片…</div>}
          {!!results.length && <div className="source-list knowledge-results">
            <div className="knowledge-results-head"><span>检索结果</span><em>{results.length} 条</em></div>
            {results.map((result, index) => <article key={result.chunk.id}>
              <div className="knowledge-result-title"><span className="knowledge-result-level">H{result.scope.level}</span><b onClick={() => previewKnowledgeScope(result.scope)}>{result.scope.title}{result.scope.sectionCount > 1 ? `（含 ${result.scope.sectionCount} 个章节）` : ""}</b><span className="knowledge-path-hint" title={`H${result.scope.level} · ${result.scope.headingPath}`} aria-label={`章节路径：H${result.scope.level} · ${result.scope.headingPath}`}><Info size={13} /></span><em className={`knowledge-quality-badge ${result.chunk.quality}`}>{result.chunk.quality === "good" ? "优质" : result.chunk.quality === "bad" ? "劣质" : "普通"}</em></div>
              <p>{result.scope.content.replace(/^#{1,6}\s+.*\n*/, "").replace(/\s+/g, " ").slice(0, 220) || "（该章节暂无正文）"}</p>
              <div className="knowledge-result-source" title={`来源文档：${result.chunk.documentTitle}`}><BookOpen size={11} aria-hidden="true" /><span>来源：{result.chunk.documentTitle}</span></div>
              <div className="knowledge-result-footer">
                <div className="source-item-actions"><button onClick={() => previewKnowledgeScope(result.scope)}>预览</button><button onClick={() => void copyText(result.scope.content, `已复制“${result.scope.title}”`)}><Copy size={12} />复制</button><button className={block.sourceRefs.includes(result.scope.id) ? "context-added" : ""} onClick={() => addKnowledgeScopeToContext(result.scope)}>{block.sourceRefs.includes(result.scope.id) ? <><Check size={12} />已加入上下文</> : <><Layers3 size={12} />加入上下文</>}</button><small className="knowledge-result-char-count">{result.scope.content.replace(/\s/g, "").length.toLocaleString()} 字</small></div>
                <div className="knowledge-scope-actions" role="group" aria-label="调整章节范围">
                  <IconButton title="上移到父章节" disabled={!result.scope.canMoveUp} onClick={() => void moveResultUp(index)}><ChevronUp size={13} /></IconButton>
                  <IconButton title="返回上次范围" disabled={!result.scopeHistory.length} onClick={() => moveResultDown(index)}><ChevronDown size={13} /></IconButton>
                </div>
                <div className="knowledge-quality-actions" role="group" aria-label="标记片段质量">
                  <IconButton title="标记为优质" active={result.chunk.quality === "good"} onClick={() => void markQuality(result.chunk, "good")}><ThumbsUp size={13} /></IconButton>
                  <IconButton title="标记为普通" active={result.chunk.quality === "normal"} onClick={() => void markQuality(result.chunk, "normal")}><Minus size={13} /></IconButton>
                  <IconButton title="标记为劣质" active={result.chunk.quality === "bad"} onClick={() => void markQuality(result.chunk, "bad")}><ThumbsDown size={13} /></IconButton>
                </div>
              </div>
            </article>)}
          </div>}
          {!searching && !results.length && <div className="knowledge-search-empty"><BookOpen size={25} /><b>{query.trim() ? "没有匹配结果" : "输入关键词检索知识库"}</b><span>{query.trim() ? "尝试更短的关键词或章节名称" : "检索标题、章节和正文"}</span></div>}
        </>}
    </div>}
    <div
      className={`inspector-terminal ${tab === "terminal" ? "is-visible" : "is-hidden"}`}
      aria-hidden={tab !== "terminal"}
    >
      <div className="inspector-terminal-meta">
        <span>工作区终端</span>
        <em title={project.workspace?.root ?? ""}>{project.workspace?.root ?? "尚未选择工作区"}</em>
      </div>
      {terminalVisited && <Suspense fallback={<p className="muted">正在加载终端…</p>}>
        <PowerShellTerminal active={tab === "terminal"} cwd={project.workspace?.root ?? "."} />
      </Suspense>}
    </div>
  </aside>;
}
