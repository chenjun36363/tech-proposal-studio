import { useEffect, useRef, useState } from "react";
import { Check, Columns2, X } from "lucide-react";
import type { AgentDraft } from "../agent/protocol";

export function AgentDraftReviewModal({ draft, close, reject, accept }: {
  draft: AgentDraft;
  close: () => void;
  reject: () => void;
  accept: () => void;
}) {
  const [syncScroll, setSyncScroll] = useState(true);
  const syncing = useRef(false);
  const originalRef = useRef<HTMLPreElement>(null);
  const revisedRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const synchronize = (source: HTMLPreElement, target: HTMLPreElement | null) => {
    if (!syncScroll || syncing.current || !target) return;
    syncing.current = true;
    const sourceRange = Math.max(1, source.scrollHeight - source.clientHeight);
    const targetRange = Math.max(0, target.scrollHeight - target.clientHeight);
    target.scrollTop = (source.scrollTop / sourceRange) * targetRange;
    requestAnimationFrame(() => { syncing.current = false; });
  };

  return <div className="agent-review-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="agent-review-modal" role="dialog" aria-modal="true" aria-labelledby="agent-review-title">
      <header className="agent-review-head">
        <div><span>AGENT REVIEW</span><h2 id="agent-review-title">章节优化审核</h2><p>{draft.instruction}</p></div>
        <button type="button" title="关闭审核" onClick={close}><X size={18} /></button>
      </header>
      <div className="agent-review-toolbar">
        <span><Columns2 size={14} />原文与优化稿对照</span>
        <label><input type="checkbox" checked={syncScroll} onChange={event => setSyncScroll(event.target.checked)} />同步滚动</label>
      </div>
      <div className="agent-review-columns">
        <article className="original">
          <header><div><i />优化前原文</div><span>{draft.before.length.toLocaleString()} 字</span></header>
          <pre ref={originalRef} onScroll={event => synchronize(event.currentTarget, revisedRef.current)}>{draft.before || "（当前章节为空）"}</pre>
        </article>
        <article className="revised">
          <header><div><i />Agent 优化稿</div><span>{draft.after.length.toLocaleString()} 字</span></header>
          <pre ref={revisedRef} onScroll={event => synchronize(event.currentTarget, originalRef.current)}>{draft.after}</pre>
        </article>
      </div>
      <footer>
        <span>接受后将替换当前章节内容</span>
        <div><button type="button" onClick={reject}>拒绝修改</button><button type="button" className="primary" onClick={accept}><Check size={14} />接受并插入</button></div>
      </footer>
    </section>
  </div>;
}

