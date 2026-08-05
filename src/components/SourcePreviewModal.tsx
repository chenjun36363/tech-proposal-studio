import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Maximize2, Minimize2, PanelLeft, PanelLeftClose, Search, X } from "lucide-react";
import { MarkdownPreview } from "../features/editor/MarkdownEditor";
import { openExternalUrl } from "../services/system";
import type { SourceRecord } from "../core/types";
import { IconButton } from "./IconButton";

interface TocItem {
  index: number;
  level: number;
  text: string;
}

const HEADING_SELECTOR = ".preview-modal-canvas h1, .preview-modal-canvas h2, .preview-modal-canvas h3, .preview-modal-canvas h4, .preview-modal-canvas h5, .preview-modal-canvas h6";

export function SourcePreviewModal({ source, markdown, loading, error, workspaceRoot, close, notify }: {
  source: SourceRecord;
  markdown: string;
  loading: boolean;
  error: string;
  workspaceRoot?: string;
  close: () => void;
  notify: (message: string) => void;
}) {
  const [maximized, setMaximized] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [keyword, setKeyword] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeMatch, setActiveMatch] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [activeTocIndex, setActiveTocIndex] = useState<number | null>(null);
  const [tocOpen, setTocOpen] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<TocItem[]>([]);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const toggleMaximized = () => { setMaximized(value => !value); setPosition({ x: 0, y: 0 }); };
  const openOriginal = async () => {
    try { await openExternalUrl(source.location); } catch (error) { notify(error instanceof Error ? error.message : "无法打开来源链接"); }
  };

  const setKeywordWithReset = (value: string) => {
    setKeyword(value);
    setActiveMatch(0);
    setMatchCount(0);
  };

  const moveMatch = (direction: 1 | -1) => {
    if (matchCount <= 0) return;
    setActiveMatch(current => (current + direction + matchCount) % matchCount);
  };

  // Re-apply the active match and scroll it into view whenever the search term,
  // case sensitivity, content, or active index changes. MarkdownPreview rebuilds
  // the <mark> nodes from the same HTML, so this runs after the DOM is updated.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const marks = Array.from(viewport.querySelectorAll("mark.md-search-match"));
    setMatchCount(marks.length);
    const safeActive = marks.length ? Math.min(activeMatch, marks.length - 1) : 0;
    marks.forEach((mark, index) => mark.classList.toggle("active", index === safeActive));
    const current = marks[safeActive];
    if (current) current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [keyword, caseSensitive, activeMatch, markdown, loading]);

  // Build the chapter tree from the rendered headings. We only store the
  // document-order index (not element references), because MarkdownPreview
  // rewrites its innerHTML on content/search changes and the saved nodes would
  // otherwise go stale. Clicking/scrolling always re-queries the live DOM.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) { setToc([]); return; }
    const nodes = Array.from(viewport.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
    const items: TocItem[] = nodes.map((el, index) => {
      const level = Number(el.tagName.slice(1)) || 1;
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      return { index, level, text };
    });
    tocRef.current = items;
    setToc(items);
    setActiveTocIndex(prev => (prev != null && prev < items.length ? prev : (items[0]?.index ?? null)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, loading, keyword, caseSensitive, source.location, workspaceRoot]);

  const scrollToHeading = (index: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const el = viewport.querySelectorAll<HTMLElement>(HEADING_SELECTOR)[index];
    if (!el) return;
    const top = el.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - 12;
    viewport.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    setActiveTocIndex(index);
  };

  const handleScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const items = tocRef.current;
    if (!items.length) return;
    const heads = viewport.querySelectorAll<HTMLElement>(HEADING_SELECTOR);
    const vTop = viewport.getBoundingClientRect().top;
    let active = items[0].index;
    for (const item of items) {
      const el = heads[item.index];
      if (!el) continue;
      const top = el.getBoundingClientRect().top - vTop;
      if (top <= 24) active = item.index;
      else break;
    }
    setActiveTocIndex(active);
  };

  const bodyClass = `preview-modal-body${tocOpen ? "" : " toc-collapsed"}`;

  return <div className="preview-modal-overlay" onClick={close}>
    <div className={`preview-modal ${maximized ? "maximized" : ""}`} style={maximized ? undefined : { transform: `translate(${position.x}px, ${position.y}px)` }} onClick={event => event.stopPropagation()}>
      <div
        className="preview-modal-head"
        onDoubleClick={event => { if (!(event.target as HTMLElement).closest("button,input")) toggleMaximized(); }}
        onPointerDown={event => {
          if (maximized || event.button !== 0 || (event.target as HTMLElement).closest("button,input")) return;
          dragRef.current = { x: event.clientX, y: event.clientY, left: position.x, top: position.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const drag = dragRef.current;
          if (!drag) return;
          setPosition({ x: drag.left + event.clientX - drag.x, y: drag.top + event.clientY - drag.y });
        }}
        onPointerUp={event => {
          dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { dragRef.current = null; }}
      >
        <div className="preview-modal-title">
          <strong>{source.title}</strong>
          <em title={source.location}>{source.location}</em>
        </div>
        <div className="preview-modal-tools">
          <div className="preview-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              className="preview-search-input"
              value={keyword}
              placeholder="搜索关键字"
              aria-label="在预览中搜索关键字"
              onChange={event => setKeywordWithReset(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); }
                else if (event.key === "Escape") setKeywordWithReset("");
              }}
            />
            {keyword && <span className="preview-search-count">{matchCount ? `${activeMatch + 1}/${matchCount}` : "无匹配"}</span>}
            {keyword && <button type="button" className="preview-search-nav" title="上一个匹配 (Shift+Enter)" onClick={() => moveMatch(-1)} disabled={!matchCount}><ChevronUp size={14} /></button>}
            {keyword && <button type="button" className="preview-search-nav" title="下一个匹配 (Enter)" onClick={() => moveMatch(1)} disabled={!matchCount}><ChevronDown size={14} /></button>}
            <button type="button" className={`preview-search-case ${caseSensitive ? "active" : ""}`} title="区分大小写" onClick={() => setCaseSensitive(value => !value)}>Aa</button>
            {keyword && <IconButton title="清除搜索" onClick={() => setKeywordWithReset("")}><X size={14} /></IconButton>}
          </div>
          {source.kind === "web" && <IconButton title="打开原网页" onClick={() => void openOriginal()}><ExternalLink size={16} /></IconButton>}
          <IconButton title={maximized ? "还原窗口" : "最大化窗口"} onClick={toggleMaximized}>{maximized ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</IconButton>
          <span className="preview-tool-divider" />
          <IconButton title="关闭预览" onClick={close}><X size={18} /></IconButton>
        </div>
      </div>
      <div className={bodyClass}>
        {!loading && !error && toc.length > 0 && (
          <nav className="preview-toc" aria-label="章节目录">
            <div className="preview-toc-head">
              <span>章节目录</span>
              <button type="button" className="preview-toc-toggle" title="折叠目录" onClick={() => setTocOpen(false)}><PanelLeftClose size={15} /></button>
            </div>
            <div className="preview-toc-list">
              {toc.map(item => (
                <button
                  key={item.index}
                  type="button"
                  className={`preview-toc-item level-${item.level}${activeTocIndex === item.index ? " active" : ""}`}
                  style={{ paddingLeft: 10 + (item.level - 1) * 14 }}
                  title={item.text}
                  onClick={() => scrollToHeading(item.index)}
                >
                  {item.text || `（无标题 H${item.level}）`}
                </button>
              ))}
            </div>
          </nav>
        )}
        {!tocOpen && !loading && !error && toc.length > 0 && (
          <button type="button" className="preview-toc-reopen" title="展开章节目录" onClick={() => setTocOpen(true)}><PanelLeft size={16} /></button>
        )}
        {loading && <div className="loading-line preview-status">正在加载预览…</div>}
        {error && <p className="muted preview-status">{error}</p>}
        {!loading && !error && <div className="preview-modal-viewport" ref={viewportRef} onScroll={handleScroll}>
          <div className="preview-modal-canvas">
            <MarkdownPreview
              markdown={markdown}
              filePath={source.kind === "local" ? source.location : undefined}
              workspaceRoot={workspaceRoot}
              searchQuery={keyword}
              searchCaseSensitive={caseSensitive}
              onLinkClick={href => void openExternalUrl(href).catch(error => notify(error instanceof Error ? error.message : "无法打开链接"))}
            />
          </div>
        </div>}
      </div>
    </div>
  </div>;
}
