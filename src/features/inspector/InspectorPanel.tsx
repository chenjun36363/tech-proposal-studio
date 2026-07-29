import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Info,
  Layers3,
  Minus,
  Search,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { AgentConversationPanel } from "../../components/AgentConversationPanel";
import type { AgentDraft, AgentEditorSelection } from "../../agent/protocol";
import { IconButton } from "../../components/IconButton";
import {
  getKnowledgeChunk,
  getKnowledgeSectionScope,
  searchKnowledge,
  setKnowledgeChunkQuality,
} from "../../knowledge";
import { isDesktop } from "../../services/runtime";
import type {
  DocumentBlock,
  KnowledgeChunk,
  KnowledgeChunkQuality,
  KnowledgeSearchField,
  KnowledgeSearchResult,
  KnowledgeSectionScope,
  Project,
  SourceRecord,
} from "../../types";
import { readTextFile } from "../../workspace";
import { AiRewritePanel } from "./AiRewritePanel";
import { ContextPanel } from "./ContextPanel";

export type InspectorTab = "ai" | "commands" | "context" | "sources";
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
  notify,
  openSettings,
  openSourcePreview,
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
  notify: (message: string) => void;
  openSettings: () => void;
  openSourcePreview: (source: SourceRecord) => Promise<void>;
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
  const contextLabels = useMemo(
    () => contextSources.map(source => source.heading ? `${source.title} / ${source.heading}` : source.title),
    [contextSources],
  );

  useEffect(() => {
    if (!desktop || !["ai", "context", "commands"].includes(tab)) return;
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

  return <aside className="right-panel">
    <div className="inspector-top">
      <div className="tabs">
        <button className={tab === "commands" ? "active" : ""} onClick={() => setTab("commands")}><Bot size={15} />Agent</button>
        <button className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}><Sparkles size={15} />AI</button>
        <button className={tab === "context" ? "active" : ""} onClick={() => setTab("context")}><Layers3 size={15} />上下文</button>
        <button className={tab === "sources" ? "active" : ""} onClick={() => setTab("sources")}><BookOpen size={15} />知识库</button>
      </div>
    </div>
    {tab === "ai" && <AiRewritePanel project={project} block={block} context={context} contextLabels={contextLabels} updateBlock={updateBlock} notify={notify} openSettings={openSettings} />}
    {tab === "commands" && <AgentConversationPanel project={project} block={block} pinnedContext={resolvedAgentContext} editorSelection={agentSelection} clearEditorSelection={clearAgentSelection} applyDraft={applyAgentDraft} notify={notify} />}
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
          </div>
          {searching && <div className="loading-line">正在检索知识切片…</div>}
          {!!results.length && <div className="source-list knowledge-results">
            {results.map((result, index) => <article key={result.chunk.id}>
              <div className="knowledge-result-title"><span className="knowledge-result-level">H{result.scope.level}</span><b onClick={() => previewKnowledgeScope(result.scope)}>{result.scope.title}{result.scope.sectionCount > 1 ? `（含 ${result.scope.sectionCount} 个章节）` : ""}</b><span className="knowledge-path-hint" title={`H${result.scope.level} · ${result.scope.headingPath}`} aria-label={`章节路径：H${result.scope.level} · ${result.scope.headingPath}`}><Info size={13} /></span><em className={`knowledge-quality-badge ${result.chunk.quality}`}>{result.chunk.quality === "good" ? "优质" : result.chunk.quality === "bad" ? "劣质" : "普通"}</em></div>
              <p>{result.scope.content.replace(/^#{1,6}\s+.*\n*/, "").replace(/\s+/g, " ").slice(0, 220) || "（该章节暂无正文）"}</p>
              <div className="knowledge-result-footer">
                <div className="source-item-actions"><button onClick={() => previewKnowledgeScope(result.scope)}>预览</button><button className={block.sourceRefs.includes(result.scope.id) ? "context-added" : ""} onClick={() => addKnowledgeScopeToContext(result.scope)}>{block.sourceRefs.includes(result.scope.id) ? <><Check size={12} />已加入上下文</> : <><Layers3 size={12} />加入上下文</>}</button><small className="knowledge-result-char-count">{result.scope.content.replace(/\s/g, "").length.toLocaleString()} 字</small></div>
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
  </aside>;
}
