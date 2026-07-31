import { useEffect, useMemo, useState } from "react";
import { Check, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import type { Project } from "../core/types";
import { acceptProjectMemory, deleteProjectMemory, listProjectMemories, rebuildProjectMemory, writeProjectMemory, type MemoryType, type ProjectMemory } from "../agent/memoryService";

const TYPE_LABELS: Record<MemoryType, string> = { decision: "决策", preference: "偏好", constraint: "约束", fact: "事实", reference: "参考" };
const EMPTY = { title: "", content: "", memoryType: "fact" as MemoryType };

export function MemorySettingsPanel({ project }: { project: Project }) {
  const [entries, setEntries] = useState<ProjectMemory[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "pending_review">("all");
  const [editing, setEditing] = useState(EMPTY);
  const [creating, setCreating] = useState(false);
  const [createReturnId, setCreateReturnId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = async (keepId?: string) => {
    setBusy(true); setError("");
    try {
      const next = await listProjectMemories(project, true);
      setEntries(next);
      const id = keepId ?? selectedId;
      const selected = next.find(item => item.id === id) ?? next[0];
      setSelectedId(selected?.id ?? "");
      if (selected) setEditing({ title: selected.title, content: selected.content, memoryType: selected.memoryType });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "记忆加载失败"); }
    finally { setBusy(false); }
  };

  useEffect(() => { void reload(""); }, [project.id, project.workspace?.root]);
  const selected = entries.find(item => item.id === selectedId);
  const filtered = useMemo(() => entries.filter(item => {
    if (status !== "all" && item.status !== status) return false;
    const needle = query.trim().toLocaleLowerCase();
    return !needle || `${item.title}\n${item.content}`.toLocaleLowerCase().includes(needle);
  }), [entries, query, status]);
  const pending = entries.filter(item => item.status === "pending_review").length;

  const select = (memory: ProjectMemory) => {
    setCreating(false); setSelectedId(memory.id);
    setEditing({ title: memory.title, content: memory.content, memoryType: memory.memoryType });
  };
  const startCreate = () => { setCreateReturnId(selectedId); setCreating(true); setSelectedId(""); setEditing(EMPTY); setError(""); };
  const cancelCreate = () => {
    const previous = entries.find(item => item.id === createReturnId) ?? entries[0];
    setCreating(false); setCreateReturnId(""); setSelectedId(previous?.id ?? ""); setError("");
    setEditing(previous ? { title: previous.title, content: previous.content, memoryType: previous.memoryType } : EMPTY);
  };
  const save = async () => {
    if (!editing.title.trim() || !editing.content.trim()) return setError("标题和内容不能为空");
    setBusy(true); setError("");
    try {
      const result = await writeProjectMemory(project, { id: creating ? undefined : selected?.id, ...editing, status: selected?.status === "pending_review" ? "pending_review" : "active", confidence: selected?.confidence ?? "confirmed", sourceConversationId: selected?.sourceConversationId, sourceMessageId: selected?.sourceMessageId });
      setCreating(false); setCreateReturnId(""); await reload(result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "记忆保存失败"); }
    finally { setBusy(false); }
  };
  const accept = async () => {
    if (!selected) return;
    setBusy(true); setError("");
    try { await acceptProjectMemory(project, selected.id); await reload(selected.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "记忆确认失败"); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!selected || !window.confirm(`删除记忆“${selected.title}”？桌面端文件会移入 .trash。`)) return;
    setBusy(true); setError("");
    try { await deleteProjectMemory(project, selected.id); await reload(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "记忆删除失败"); }
    finally { setBusy(false); }
  };

  return <div className="memory-settings-panel">
    <div className="memory-settings-toolbar">
      <div><b>{entries.length}</b><span>条项目记忆</span>{pending > 0 && <em>{pending} 条待审核</em>}</div>
      <div><button type="button" title="重建记忆索引" onClick={() => void rebuildProjectMemory(project).then(() => reload()).catch(cause => setError(String(cause)))} disabled={busy}><RefreshCw size={14} className={busy ? "model-fetch-spinning" : undefined} /></button><button type="button" className="primary" onClick={startCreate}><Plus size={14} />新增记忆</button></div>
    </div>
    <p className="memory-storage-path">桌面端保存于 <code>{project.workspace?.root ? `${project.workspace.root}\\.gouan\\memory` : "请先配置工作区"}</code></p>
    {error && <div className="memory-settings-error">{error}</div>}
    <div className="memory-settings-workspace">
      <section className="memory-settings-list">
        <div className="memory-filter-row"><label><Search size={13} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索记忆" /></label><select value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">全部</option><option value="pending_review">待审核</option><option value="active">已确认</option></select></div>
        <div className="memory-entry-scroll">
          {filtered.map(item => <button type="button" className={item.id === selectedId ? "active" : ""} onClick={() => select(item)} key={item.id}>
            <span><b>{item.title}</b><small>{TYPE_LABELS[item.memoryType]}</small></span>
            <p>{item.content}</p>
            <em className={item.status}>{item.status === "pending_review" ? "待审核" : "已确认"}</em>
          </button>)}
          {!filtered.length && <div className="memory-empty">{busy ? "正在读取记忆…" : "没有符合条件的记忆"}</div>}
        </div>
      </section>
      <section className="memory-settings-editor">
        {(selected || creating) ? <>
          <header><div><b>{creating ? "新增记忆" : selected?.title}</b>{selected?.sourceConversationId && <small>来源会话：{selected.sourceConversationId}</small>}</div>{selected?.status === "pending_review" && <button type="button" onClick={() => void accept()} disabled={busy}><Check size={14} />确认记忆</button>}</header>
          <div className="memory-editor-fields">
            <label>类型<select value={editing.memoryType} onChange={event => setEditing(current => ({ ...current, memoryType: event.target.value as MemoryType }))}>{Object.entries(TYPE_LABELS).map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label className="wide">标题<input maxLength={80} value={editing.title} onChange={event => setEditing(current => ({ ...current, title: event.target.value }))} /></label>
            <label className="wide memory-content-field">内容<textarea maxLength={16384} value={editing.content} onChange={event => setEditing(current => ({ ...current, content: event.target.value }))} /></label>
          </div>
          <footer>{!creating && <button type="button" className="danger" onClick={() => void remove()} disabled={busy}><Trash2 size={14} />删除</button>}<span />{creating && <button type="button" onClick={cancelCreate} disabled={busy}><X size={14} />取消</button>}<button type="button" onClick={() => void save()} className="primary" disabled={busy || !editing.title.trim() || !editing.content.trim()}>保存</button></footer>
        </> : <div className="memory-editor-empty">选择一条记忆查看详情，或新增项目记忆</div>}
      </section>
    </div>
  </div>;
}
