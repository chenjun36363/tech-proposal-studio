import { useEffect, useRef, type RefObject } from "react";

/** 元素滚动进度：0（顶部）~ 1（底部）。无需滚动时返回 0。 */
export function scrollRatio(el: HTMLElement): number {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, el.scrollTop / max));
}

/** 将元素滚动到指定进度。无可滚动空间时不动作。 */
export function applyScrollRatio(el: HTMLElement, ratio: number): void {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return;
  el.scrollTop = ratio * max;
}

/**
 * 分栏模式下同步「源码编辑区」与「预览区」的滚动进度。
 *
 * 采用比例同步：滚动一侧时，按 (scrollTop / 可滚动高度) 计算进度，
 * 再把另一侧滚动到相同进度。源码与渲染后的 HTML 长度必然不同，
 * 比例法是最常见且够用的近似。
 *
 * 用 syncingRef 标记 + rAF 延时复位来吸收程序化滚动触发的 scroll 事件，
 * 避免 A→B→A 反馈循环（与进度差 <1px 的短路判断双保险）。
 */
export function useSynchronizedScroll(
  sourceRef: RefObject<HTMLElement | null>,
  previewRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  const syncingRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const sourceEl = sourceRef.current;
    const previewEl = previewRef.current;
    if (!sourceEl || !previewEl) return;

    const syncFrom = (from: HTMLElement, to: HTMLElement) => {
      if (syncingRef.current) return;
      const max = from.scrollHeight - from.clientHeight;
      if (max <= 0) return;
      const ratio = Math.min(1, Math.max(0, from.scrollTop / max));
      const toMax = to.scrollHeight - to.clientHeight;
      if (toMax <= 0) return;
      const target = ratio * toMax;
      if (Math.abs(to.scrollTop - target) < 1) return;
      syncingRef.current = true;
      to.scrollTop = target;
      requestAnimationFrame(() => {
        syncingRef.current = false;
      });
    };

    const onSourceScroll = () => syncFrom(sourceEl, previewEl);
    const onPreviewScroll = () => syncFrom(previewEl, sourceEl);
    sourceEl.addEventListener("scroll", onSourceScroll, { passive: true });
    previewEl.addEventListener("scroll", onPreviewScroll, { passive: true });
    return () => {
      sourceEl.removeEventListener("scroll", onSourceScroll);
      previewEl.removeEventListener("scroll", onPreviewScroll);
      syncingRef.current = false;
    };
  }, [sourceRef, previewRef, enabled]);
}
