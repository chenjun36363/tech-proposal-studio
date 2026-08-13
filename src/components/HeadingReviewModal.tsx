import { BookOpen, X } from "lucide-react";
import type { HeadingCandidate, HeadingDetectionResult, KnowledgeProgress } from "../core/types";
import { IconButton } from "./IconButton";

export function HeadingReviewModal({ result, candidates, setCandidates, busy, progress, busySeconds, close, confirm }: {
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
            <select value={item.level} disabled={!item.selected || item.source === "markdown"} onChange={event => update(item.id, { level: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6].map(level => <option value={level} key={level}>H{level}</option>)}</select>
            <div><b>{item.text}</b><span>第 {item.line + 1} 行 · {item.reason}</span><code>{item.selected && !item.original.trimStart().startsWith("#") ? `${"#".repeat(item.level)} ${item.original.trimStart()}` : item.original}</code></div>
            <em>{Math.round(item.confidence * 100)}%</em>
          </div>)}
          {!candidates.length && <p className="muted">未发现标题候选，将按文档根节点切片。</p>}
        </section>
        <section className="heading-tree-preview">
          <div className="heading-review-column-title">章节树预览（仅用于索引，不修改原文）</div>
          {selected.map(item => <div key={item.id} style={{ paddingLeft: `${(item.level - 1) * 14}px` }}><span>H{item.level}</span><b>{item.text}</b></div>)}
          {!selected.length && <p className="muted">没有选中的标题</p>}
        </section>
      </div>
      {busy && progress && <div className="knowledge-progress heading-review-progress"><span>{progress.message}</span><b>{progress.total > 1 ? `${progress.current}/${progress.total}` : `已进行 ${busySeconds} 秒`}</b></div>}
      <div className="modal-actions"><button onClick={close} disabled={busy}>取消</button><button className="primary" onClick={confirm} disabled={busy}>{busy ? "正在建立章节索引…" : "确认结构并入库"}</button></div>
    </div>
  </div>;
}
