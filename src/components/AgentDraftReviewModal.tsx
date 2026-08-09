import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Columns2, GripVertical, RotateCcw, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { AgentDraft } from "../agent/protocol";
import { MarkdownDiffPane } from "./MarkdownDiffPane";
import { buildTextDiff } from "./textDiff";

function reviewCopy(draft: AgentDraft) {
  if (draft.operation === "move_section") return { title: "章节移动审核", summary: `将「${draft.target.sectionTitle ?? "源章节"}」移动到「${draft.target.destinationSectionTitle ?? "目标章节"}」${draft.target.position === "before" ? "之前" : "之后"}`, before: "待移动章节", after: "目标位置章节", emptyBefore: "（源章节为空）", emptyAfter: "（目标章节为空）", footer: "接受后将移动章节及其全部子章节并重新编号", accept: "接受并移动" };
  if (draft.operation === "replace_document") return { title: "文档修改详情", summary: "正式文件修改前后对照", before: "修改前文档", after: "修改后文档", emptyBefore: "（原文档为空）", emptyAfter: "（修改后文档为空）", footer: "确认前请检查修改是否超出目标章节", accept: "确认并应用" };
  if (draft.operation === "replace_selection") return { title: "选区修改审核", summary: "选区原文与替换稿对照", before: "选区原文", after: "替换稿", emptyBefore: "（选区为空）", emptyAfter: "（替换为空）", footer: "接受后将替换已校验的选区", accept: "接受并替换" };
  if (draft.operation === "insert_section") return { title: "章节插入审核", summary: `将在「${draft.target.sectionTitle ?? "目标章节"}」${draft.target.position === "before" ? "之前" : "之后"}插入`, before: "插入位置", after: "待插入章节", emptyBefore: "（不替换现有正文）", emptyAfter: "（插入内容为空）", footer: "接受后将插入章节并重新编号", accept: "接受并插入" };
  if (draft.operation === "delete_section") return { title: "章节删除审核", summary: "删除章节将同时删除其全部子章节", before: "待删除章节", after: "删除结果", emptyBefore: "（章节为空）", emptyAfter: "（整个章节将被删除）", footer: "接受后将删除章节并重新编号", accept: "确认删除" };
  return { title: "章节修改审核", summary: "章节原文与修改稿对照", before: "章节原文", after: "修改稿", emptyBefore: "（当前章节为空）", emptyAfter: "（修改稿为空）", footer: "接受后将替换已校验的目标章节", accept: "接受并替换" };
}

export function AgentDraftReviewModal({ draft, close, reject, accept, readonly }: {
  draft: AgentDraft;
  close: () => void;
  reject: () => void;
  accept: () => void;
  readonly?: boolean;
}) {
  const copy = reviewCopy(draft);
  const revisedContent = draft.operation === "move_section" ? draft.target.destinationSnapshot ?? "" : draft.after;
  const isMove = draft.operation === "move_section";
  const diff = useMemo(() => buildTextDiff(draft.before, revisedContent), [draft.before, revisedContent]);
  const [syncScroll, setSyncScroll] = useState(true);
  const [split, setSplit] = useState(50);
  const [stacked, setStacked] = useState(false);
  const syncing = useRef(false);
  const columnsRef = useRef<HTMLDivElement>(null);
  const originalRef = useRef<HTMLDivElement>(null);
  const revisedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setStacked(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const resizeFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = columnsRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const position = stacked
      ? (event.clientY - bounds.top) / bounds.height
      : (event.clientX - bounds.left) / bounds.width;
    setSplit(Math.min(80, Math.max(20, position * 100)));
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeFromPointer(event);
  };

  const adjustWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const decrease = stacked ? event.key === "ArrowUp" : event.key === "ArrowLeft";
    const increase = stacked ? event.key === "ArrowDown" : event.key === "ArrowRight";
    if (!decrease && !increase && event.key !== "Home") return;
    event.preventDefault();
    setSplit(current => event.key === "Home" ? 50 : Math.min(80, Math.max(20, current + (increase ? 2 : -2))));
  };

  const synchronize = (source: HTMLDivElement, target: HTMLDivElement | null) => {
    if (!syncScroll || syncing.current || !target) return;
    syncing.current = true;
    const sourceRange = Math.max(1, source.scrollHeight - source.clientHeight);
    const targetRange = Math.max(0, target.scrollHeight - target.clientHeight);
    target.scrollTop = (source.scrollTop / sourceRange) * targetRange;
    requestAnimationFrame(() => { syncing.current = false; });
  };

  const modal = <div className="agent-review-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="agent-review-modal" role="dialog" aria-modal="true" aria-labelledby="agent-review-title">
      <header className="agent-review-head">
        <div><span>AGENT REVIEW</span><h2 id="agent-review-title">{copy.title}</h2><p>{draft.instruction}</p></div>
        <button type="button" title="关闭审核" onClick={close}><X size={18} /></button>
      </header>
      <div className="agent-review-toolbar">
        <span><Columns2 size={14} />{copy.summary}{isMove ? <b className="move-note">正文未修改，仅调整位置</b> : diff.unchanged ? <b className="unchanged-note">无文本变化</b> : <><b className="deleted-stat">-{diff.deletedLines} 行</b><b className="added-stat">+{diff.addedLines} 行</b></>}</span>
        <div className="agent-review-tools">
          <button type="button" title="恢复均分" aria-label="恢复均分" onClick={() => setSplit(50)}><RotateCcw size={13} /></button>
          <label><input type="checkbox" checked={syncScroll} onChange={event => setSyncScroll(event.target.checked)} />同步滚动</label>
        </div>
      </div>
      <div ref={columnsRef} className="agent-review-columns" style={{ "--review-split": `${split}%` } as React.CSSProperties}>
        <article className="original">
          <header><div><i />{copy.before}</div><span>{draft.before.length.toLocaleString()} 字</span></header>
          <div className="agent-review-scroll" ref={originalRef} onScroll={event => synchronize(event.currentTarget, revisedRef.current)}>{isMove ? <pre>{draft.before || copy.emptyBefore}</pre> : diff.rows.length ? <MarkdownDiffPane diff={diff} side="original" /> : <div className="agent-review-empty">{copy.emptyBefore}</div>}</div>
        </article>
        <div
          className="agent-review-resizer"
          role="separator"
          aria-label="调整原文与优化稿宽度"
          aria-orientation={stacked ? "horizontal" : "vertical"}
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(split)}
          tabIndex={0}
          onDoubleClick={() => setSplit(50)}
          onKeyDown={adjustWithKeyboard}
          onPointerDown={startResize}
          onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeFromPointer(event); }}
        ><GripVertical size={14} /></div>
        <article className="revised">
          <header><div><i />{copy.after}</div><span>{revisedContent.length.toLocaleString()} 字</span></header>
          <div className="agent-review-scroll" ref={revisedRef} onScroll={event => synchronize(event.currentTarget, originalRef.current)}>{isMove ? <pre>{revisedContent || copy.emptyAfter}</pre> : diff.rows.length ? <>{!revisedContent && <div className="agent-review-empty-note">{copy.emptyAfter}</div>}<MarkdownDiffPane diff={diff} side="revised" /></> : <div className="agent-review-empty">{copy.emptyAfter}</div>}</div>
        </article>
      </div>
      <footer>
        <span>{copy.footer}</span>
        <div>{readonly
          ? <button type="button" onClick={close}>关闭</button>
          : <><button type="button" onClick={reject}>拒绝修改</button><button type="button" className="primary" onClick={accept}><Check size={14} />{copy.accept}</button></>}
        </div>
      </footer>
    </section>
  </div>;

  return typeof document === "undefined" ? modal : createPortal(modal, document.body);
}

