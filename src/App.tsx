import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, BookOpen, Bot, Braces, Check, ChevronDown, CircleDot, Command, Download, FilePlus2, FolderSearch, Globe2, LayoutTemplate, MoreHorizontal, PanelRightClose, Plus, Redo2, Search, Settings, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { blockLabels, makeId, makeSection } from "./data";
import { exportMarkdown, loadProject, saveProject } from "./storage";
import { improveBlock, saveMarkdown, searchWeb } from "./services";
import type { AiDraft, BlockType, DocumentBlock, Project, SearchResult, Section, SourceRecord } from "./types";

type RightTab = "ai" | "sources" | "commands";
const IconButton = ({ title, children, onClick, active = false }: { title: string; children: React.ReactNode; onClick?: () => void; active?: boolean }) => <button className={`icon-button ${active ? "active" : ""}`} title={title} aria-label={title} onClick={onClick}>{children}</button>;

export default function App() {
  const [project, setProject] = useState<Project>(loadProject);
  const [selectedSectionId, setSelectedSectionId] = useState(project.sections[0].id);
  const [selectedBlockId, setSelectedBlockId] = useState(project.sections[0].blocks[0].id);
  const [rightTab, setRightTab] = useState<RightTab>("ai");
  const [rightOpen, setRightOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [toast, setToast] = useState("");
  const history = useRef<Project[]>([]);
  const saveTimer = useRef<number | undefined>(undefined);
  const section = project.sections.find(s => s.id === selectedSectionId) ?? project.sections[0];
  const selectedBlock = section.blocks.find(b => b.id === selectedBlockId) ?? section.blocks[0];

  useEffect(() => { window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(() => saveProject(project), 500); return () => window.clearTimeout(saveTimer.current); }, [project]);
  const updateProject = (fn: (p: Project) => Project, remember = true) => { if (remember) history.current.push(structuredClone(project)); setProject(fn(project)); };
  const updateSection = (id: string, fn: (s: Section) => Section) => updateProject(p => ({ ...p, sections: p.sections.map(s => s.id === id ? fn(s) : s) }));
  const updateBlock = (id: string, fn: (b: DocumentBlock) => DocumentBlock) => updateSection(section.id, s => ({ ...s, blocks: s.blocks.map(b => b.id === id ? fn(b) : b) }));
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2500); };
  const undo = () => { const previous = history.current.pop(); if (previous) setProject(previous); };
  const addBlock = (type: BlockType) => { const block: DocumentBlock = { id: makeId(), sectionId: section.id, type, content: type === "mermaid" ? "graph LR\n  A[需求] --> B[设计]\n  B --> C[交付]" : "", order: section.blocks.length, status: "draft", sourceRefs: [] }; updateSection(section.id, s => ({ ...s, blocks: [...s.blocks, block] })); setSelectedBlockId(block.id); setAddMenu(false); };
  const removeBlock = (id: string) => { if (section.blocks.length === 1) return notify("每个章节至少保留一个内容块"); const next = section.blocks.filter(b => b.id !== id); updateSection(section.id, s => ({ ...s, blocks: next })); setSelectedBlockId(next[0].id); };
  const addSection = () => { const next = makeSection("新章节", project.sections.length); updateProject(p => ({ ...p, sections: [...p.sections, next] })); setSelectedSectionId(next.id); setSelectedBlockId(next.blocks[0].id); };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark"><Braces size={18} /><span>构案</span></div>
      <div className="project-identity"><input value={project.name} onChange={e => updateProject(p => ({ ...p, name: e.target.value }), false)} /><span>已自动保存 · {new Date(project.updatedAt).toLocaleDateString("zh-CN")}</span></div>
      <div className="top-actions"><IconButton title="撤销" onClick={undo}><Undo2 size={17} /></IconButton><IconButton title="重做"><Redo2 size={17} /></IconButton><span className="divider" /><button className="text-button" onClick={() => saveMarkdown(project, exportMarkdown(project))}><Download size={16} />导出</button><IconButton title="设置" onClick={() => setSettingsOpen(true)}><Settings size={18} /></IconButton><IconButton title="更多"><MoreHorizontal size={18} /></IconButton></div>
    </header>
    <div className={`workspace ${rightOpen ? "with-right" : ""}`}>
      <aside className="left-panel">
        <div className="panel-heading"><span>方案结构</span><div><IconButton title="从模板新建"><LayoutTemplate size={15} /></IconButton><IconButton title="添加章节" onClick={addSection}><Plus size={16} /></IconButton></div></div>
        <nav className="section-list">{project.sections.map((s, i) => <button key={s.id} className={s.id === section.id ? "selected" : ""} onClick={() => { setSelectedSectionId(s.id); setSelectedBlockId(s.blocks[0].id); }}><span>{String(i + 1).padStart(2, "0")}</span><b>{s.title}</b><em>{s.blocks.filter(b => b.content.trim()).length}/{s.blocks.length}</em></button>)}</nav>
        <div className="library-link"><button onClick={() => { setRightTab("sources"); setRightOpen(true); }}><Archive size={16} />历史方案库<span>{project.sources.filter(s => s.kind === "local").length}</span></button></div>
      </aside>
      <main className="editor-area">
        <div className="editor-title"><div><span>第 {section.order + 1} 章</span><input value={section.title} onChange={e => updateSection(section.id, s => ({ ...s, title: e.target.value }))} /></div><div className="completion"><span>{Math.round(section.blocks.filter(b => b.status === "done").length / section.blocks.length * 100)}%</span><i><b style={{ width: `${section.blocks.filter(b => b.status === "done").length / section.blocks.length * 100}%` }} /></i></div></div>
        <div className="document-canvas">{section.blocks.map((block, index) => <BlockEditor key={block.id} block={block} index={index} selected={block.id === selectedBlock.id} onSelect={() => setSelectedBlockId(block.id)} onChange={content => updateBlock(block.id, b => ({ ...b, content }))} onDone={() => updateBlock(block.id, b => ({ ...b, status: b.status === "done" ? "draft" : "done" }))} onDelete={() => removeBlock(block.id)} />)}
          <div className="add-wrap"><button className="add-block" onClick={() => setAddMenu(!addMenu)}><Plus size={16} />添加内容块<ChevronDown size={14} /></button>{addMenu && <div className="block-menu">{(Object.keys(blockLabels) as BlockType[]).map(type => <button key={type} onClick={() => addBlock(type)}>{blockLabels[type]}</button>)}</div>}</div>
        </div>
      </main>
      {rightOpen ? <RightPanel tab={rightTab} setTab={setRightTab} project={project} block={selectedBlock} updateProject={updateProject} updateBlock={updateBlock} notify={notify} openSettings={() => setSettingsOpen(true)} close={() => setRightOpen(false)} openSource={() => setSourceOpen(true)} /> : <button className="open-inspector" title="打开侧栏" onClick={() => setRightOpen(true)}><Bot size={18} /></button>}
    </div>
    {settingsOpen && <SettingsModal project={project} close={() => setSettingsOpen(false)} save={next => { setProject(next); setSettingsOpen(false); notify("设置已保存"); }} />}
    {sourceOpen && <SourceModal close={() => setSourceOpen(false)} add={source => { updateProject(p => ({ ...p, sources: [...p.sources, source] })); setSourceOpen(false); notify("资料已加入项目"); }} />}
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </div>;
}

function BlockEditor({ block, index, selected, onSelect, onChange, onDone, onDelete }: { block: DocumentBlock; index: number; selected: boolean; onSelect: () => void; onChange: (v: string) => void; onDone: () => void; onDelete: () => void }) {
  return <section className={`content-block ${selected ? "selected" : ""}`} onClick={onSelect}>
    <div className="block-rail"><span>{String(index + 1).padStart(2, "0")}</span><i /></div>
    <div className="block-body"><div className="block-meta"><span>{blockLabels[block.type]}</span><div><button className={block.status === "done" ? "done" : ""} title="标记完成" onClick={onDone}><CircleDot size={14} />{block.status === "done" ? "已完成" : "草稿"}</button><IconButton title="删除块" onClick={onDelete}><Trash2 size={14} /></IconButton></div></div>
      {block.type === "table" ? <textarea className="code-input" value={block.content} placeholder="| 字段 | 说明 |\n| --- | --- |" onChange={e => onChange(e.target.value)} /> : block.type === "code" || block.type === "mermaid" ? <textarea className="code-input" value={block.content} spellCheck={false} onChange={e => onChange(e.target.value)} /> : <textarea value={block.content} placeholder="在此写下这一部分的方案内容…" onChange={e => onChange(e.target.value)} />}
    </div>
  </section>;
}

function RightPanel({ tab, setTab, project, block, updateProject, updateBlock, notify, openSettings, close, openSource }: any) {
  const [instruction, setInstruction] = useState("使表述更专业、具体，并补充必要的实施约束");
  const [draft, setDraft] = useState<AiDraft | null>(null); const [loading, setLoading] = useState(false); const [query, setQuery] = useState(""); const [results, setResults] = useState<SearchResult[]>([]); const [searching, setSearching] = useState(false);
  const context = useMemo(() => project.sources.filter((s: SourceRecord) => block.sourceRefs.includes(s.id)).map((s: SourceRecord) => `${s.title}: ${s.excerpt}`), [project.sources, block.sourceRefs]);
  const runAi = async () => { setLoading(true); try { setDraft(await improveBlock(block, instruction, context, project.model)); } catch (e: any) { notify(e.message); } finally { setLoading(false); } };
  const runSearch = async () => { if (!query.trim()) return; if (!confirm(`即将向 ${project.search.provider} 发送查询：\n\n${query}`)) return; setSearching(true); try { setResults(await searchWeb(query, project.search)); } catch (e: any) { notify(e.message); } finally { setSearching(false); } };
  const addResult = (r: SearchResult) => { const source: SourceRecord = { id: makeId(), kind: "web", title: r.title, location: r.url, excerpt: r.excerpt, fingerprint: btoa(unescape(encodeURIComponent(r.url))).slice(0, 32), accessedAt: new Date().toISOString() }; updateProject((p: Project) => ({ ...p, sources: [...p.sources, source] })); notify("来源已保存"); };
  return <aside className="right-panel"><div className="inspector-top"><div className="tabs"><button className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}><Sparkles size={15} />AI</button><button className={tab === "sources" ? "active" : ""} onClick={() => setTab("sources")}><BookOpen size={15} />资料</button><button className={tab === "commands" ? "active" : ""} onClick={() => setTab("commands")}><Command size={15} />任务</button></div><IconButton title="关闭侧栏" onClick={close}><PanelRightClose size={17} /></IconButton></div>
    {tab === "ai" && <div className="inspector-content"><div className="context-line"><span><Bot size={17} />{project.model.model}</span><button onClick={openSettings}>配置</button></div><label>编辑要求<textarea value={instruction} onChange={e => setInstruction(e.target.value)} /></label><div className="context-box"><span>发送上下文</span><b>{context.length} 条引用 + 当前内容块</b></div><button className="primary" onClick={runAi} disabled={loading}>{loading ? "正在生成…" : <><Sparkles size={16} />优化当前块</>}</button>{draft && <div className="diff"><div className="diff-title"><span>修改建议</span><button onClick={() => setDraft(null)}><X size={14} /></button></div><div className="removed">{draft.before || "（空内容）"}</div><div className="added">{draft.after}</div><div className="diff-actions"><button onClick={() => setDraft(null)}>拒绝</button><button onClick={() => { updateBlock(block.id, (b: DocumentBlock) => ({ ...b, content: draft.after })); setDraft(null); notify("修改已应用"); }}><Check size={14} />接受修改</button></div></div>}</div>}
    {tab === "sources" && <div className="inspector-content"><div className="search-row"><input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && runSearch()} placeholder="搜索技术资料" /><button onClick={runSearch}><Search size={16} /></button></div><button className="import-link" onClick={openSource}><FilePlus2 size={16} />导入 Markdown 资料</button><div className="source-list">{results.map(r => <article key={r.url}><div><Globe2 size={15} /><span>{new URL(r.url).hostname}</span></div><b>{r.title}</b><p>{r.excerpt}</p><button onClick={() => addResult(r)}>保存来源</button></article>)}{!results.length && project.sources.map((s: SourceRecord) => <article key={s.id}><div>{s.kind === "web" ? <Globe2 size={15} /> : <FolderSearch size={15} />}<span>{s.kind === "web" ? "网页来源" : "本地资料"}</span></div><b>{s.title}</b><p>{s.excerpt}</p><button onClick={() => updateBlock(block.id, (b: DocumentBlock) => ({ ...b, sourceRefs: b.sourceRefs.includes(s.id) ? b.sourceRefs.filter(x => x !== s.id) : [...b.sourceRefs, s.id] }))}>{block.sourceRefs.includes(s.id) ? "移除上下文" : "加入上下文"}</button></article>)}</div>{searching && <div className="loading-line">正在检索…</div>}</div>}
    {tab === "commands" && <div className="inspector-content"><p className="muted">命令由桌面端后端受控执行，浏览器预览不会运行系统命令。</p>{project.commands.map((c: any) => <div className="command-item" key={c.id}><Command size={16} /><div><b>{c.name}</b><code>{c.program} {c.args.join(" ")}</code></div><button onClick={() => notify("请在 Tauri 桌面端运行此任务")}>运行</button></div>)}</div>}
  </aside>;
}

function SettingsModal({ project, close, save }: { project: Project; close: () => void; save: (p: Project) => void }) {
  const [draft, setDraft] = useState(structuredClone(project));
  return <div className="modal-backdrop" onMouseDown={close}><div className="modal" onMouseDown={e => e.stopPropagation()}><div className="modal-title"><div><Settings size={19} /><span>连接与隐私</span></div><IconButton title="关闭" onClick={close}><X size={18} /></IconButton></div><div className="notice"><Globe2 size={18} /><div><b>联网模型已启用</b><span>当前内容块和明确选择的引用会发送至此服务。</span></div><input type="checkbox" checked={draft.model.enabled} onChange={e => setDraft({ ...draft, model: { ...draft.model, enabled: e.target.checked } })} /></div><div className="form-grid"><label>API 地址<input value={draft.model.baseUrl} onChange={e => setDraft({ ...draft, model: { ...draft.model, baseUrl: e.target.value } })} /></label><label>模型名称<input value={draft.model.model} onChange={e => setDraft({ ...draft, model: { ...draft.model, model: e.target.value } })} /></label><label className="wide">API Key<input type="password" value={draft.model.apiKey} placeholder="仅保存在系统凭据管理器" onChange={e => setDraft({ ...draft, model: { ...draft.model, apiKey: e.target.value } })} /></label><label>搜索服务<select value={draft.search.provider} onChange={e => setDraft({ ...draft, search: { ...draft.search, provider: e.target.value as any } })}><option value="searxng">SearXNG</option><option value="brave">Brave Search</option></select></label><label>搜索地址<input value={draft.search.endpoint} onChange={e => setDraft({ ...draft, search: { ...draft.search, endpoint: e.target.value } })} /></label><label className="wide">搜索 API Key<input type="password" value={draft.search.apiKey} onChange={e => setDraft({ ...draft, search: { ...draft.search, apiKey: e.target.value } })} /></label></div><div className="modal-actions"><button onClick={close}>取消</button><button className="primary" onClick={() => save(draft)}>保存设置</button></div></div></div>;
}

function SourceModal({ close, add }: { close: () => void; add: (s: SourceRecord) => void }) {
  const [name, setName] = useState(""); const [content, setContent] = useState("");
  return <div className="modal-backdrop" onMouseDown={close}><div className="modal small" onMouseDown={e => e.stopPropagation()}><div className="modal-title"><div><FilePlus2 size={19} /><span>导入 Markdown</span></div><IconButton title="关闭" onClick={close}><X size={18} /></IconButton></div><div className="form-grid"><label className="wide">资料名称<input value={name} onChange={e => setName(e.target.value)} placeholder="例如：支付平台历史方案" /></label><label className="wide">Markdown 内容<textarea value={content} onChange={e => setContent(e.target.value)} placeholder="# 标题\n\n粘贴或输入资料内容…" /></label></div><div className="modal-actions"><button onClick={close}>取消</button><button className="primary" disabled={!content.trim()} onClick={() => add({ id: makeId(), kind: "local", title: name || "未命名资料", location: `${name || "source"}.md`, excerpt: content.replace(/[#*_`]/g, "").slice(0, 280), fingerprint: String(content.length), accessedAt: new Date().toISOString() })}>导入并索引</button></div></div></div>;
}
