import { useState } from "react";
import { Copy, FolderSearch, Globe2, Layers3, Pencil, Trash2 } from "lucide-react";
import { makeId } from "../../core/data";
import type { DocumentBlock, SourceRecord } from "../../core/types";

export function ContextPanel({ contextSources, context, updateBlock, updateSourceContext, openSourcePreview, sourceContent, notify }: {
  contextSources: SourceRecord[];
  context: string[];
  updateBlock: (updater: (block: DocumentBlock) => DocumentBlock) => void;
  updateSourceContext: (sourceId: string, source?: SourceRecord, mode?: "add" | "remove" | "toggle") => void;
  openSourcePreview: (source: SourceRecord) => Promise<void>;
  sourceContent: (source: SourceRecord) => string;
  notify: (message: string) => void;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualContent, setManualContent] = useState("");

  const copy = async (text: string, message: string) => {
    try { await navigator.clipboard.writeText(text); notify(message); }
    catch { notify("复制失败，请检查剪贴板权限"); }
  };
  const resetManual = () => { setManualOpen(false); setManualTitle(""); setManualContent(""); };
  const addManual = () => {
    const content = manualContent.trim();
    if (!content) return notify("请先填写上下文内容");
    const source: SourceRecord = {
      id: makeId(), kind: "manual", title: manualTitle.trim() || "手动添加的内容", location: "手动添加",
      excerpt: content.replace(/\s+/g, " ").slice(0, 180), content, fingerprint: `manual-${makeId()}`, accessedAt: new Date().toISOString(),
    };
    updateSourceContext(source.id, source);
    resetManual();
    notify("内容已加入上下文");
  };

  return <div className="inspector-content context-manager">
    <div className="context-manager-head"><div><Layers3 size={17} /><span>已选上下文</span><b>{contextSources.length}</b></div><div className="context-manager-actions">
      <button type="button" className="context-add-action" onClick={() => setManualOpen(open => !open)}><Pencil size={13} />手动添加</button>
      <button type="button" className="context-add-action" disabled={!context.length} onClick={() => void copy(context.join("\n\n---\n\n"), "已复制全部上下文")}><Copy size={13} />复制全部</button>
      <button type="button" className="context-clear-action" disabled={!contextSources.length} onClick={() => updateBlock(block => ({ ...block, sourceRefs: [] }))}><Trash2 size={13} />清空</button>
    </div></div>
    {manualOpen && <div className="manual-context-form">
      <label>名称（可选）<input value={manualTitle} onChange={event => setManualTitle(event.target.value)} placeholder="例如：客户访谈补充" /></label>
      <label>内容<textarea autoFocus value={manualContent} onChange={event => setManualContent(event.target.value)} placeholder="粘贴或输入需要随当前章节发送的内容" /></label>
      <div><button type="button" onClick={resetManual}>取消</button><button type="button" className="primary" disabled={!manualContent.trim()} onClick={addManual}><Layers3 size={13} />加入上下文</button></div>
    </div>}
    <div className="context-source-list">
      {contextSources.map((source, index) => <article key={source.id}><div className="context-source-index">{String(index + 1).padStart(2, "0")}</div><div className="context-source-body">
        <span>{source.kind === "web" ? <Globe2 size={13} /> : source.kind === "manual" ? <Pencil size={13} /> : <FolderSearch size={13} />}{source.kind === "web" ? "网页来源" : source.kind === "manual" ? "手动内容" : "本地资料"}<small className="context-source-char-count">{sourceContent(source).replace(/\s/g, "").length.toLocaleString()} 字</small></span>
        <b>{source.title}</b><p>{source.excerpt || "（无摘要）"}</p><div>
          <button type="button" onClick={() => void openSourcePreview(source)}>预览</button>
          <button type="button" onClick={() => void copy(sourceContent(source), `已复制“${source.title}”`)}><Copy size={11} />复制</button>
          <button type="button" onClick={() => updateSourceContext(source.id, undefined, "remove")}>移除</button>
        </div>
      </div></article>)}
      {!contextSources.length && <div className="context-empty"><Layers3 size={24} /><span>暂无上下文</span></div>}
    </div>
  </div>;
}
