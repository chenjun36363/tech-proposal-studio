import { useRef, useState } from "react";
import { ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { MarkdownPreview } from "../features/editor/MarkdownEditor";
import { openExternalUrl } from "../services/system";
import type { SourceRecord } from "../core/types";
import { IconButton } from "./IconButton";

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
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const toggleMaximized = () => { setMaximized(value => !value); setPosition({ x: 0, y: 0 }); };
  const openOriginal = async () => {
    try { await openExternalUrl(source.location); } catch (error) { notify(error instanceof Error ? error.message : "无法打开来源链接"); }
  };

  return <div className="preview-modal-overlay" onClick={close}>
    <div className={`preview-modal ${maximized ? "maximized" : ""}`} style={maximized ? undefined : { transform: `translate(${position.x}px, ${position.y}px)` }} onClick={event => event.stopPropagation()}>
      <div
        className="preview-modal-head"
        onDoubleClick={event => { if (!(event.target as HTMLElement).closest("button")) toggleMaximized(); }}
        onPointerDown={event => {
          if (maximized || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
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
          {source.kind === "web" && <IconButton title="打开原网页" onClick={() => void openOriginal()}><ExternalLink size={16} /></IconButton>}
          <IconButton title={maximized ? "还原窗口" : "最大化窗口"} onClick={toggleMaximized}>{maximized ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</IconButton>
          <span className="preview-tool-divider" />
          <IconButton title="关闭预览" onClick={close}><X size={18} /></IconButton>
        </div>
      </div>
      {loading && <div className="loading-line preview-status">正在加载预览…</div>}
      {error && <p className="muted preview-status">{error}</p>}
      {!loading && !error && <div className="preview-modal-viewport">
        <div className="preview-modal-canvas">
          <MarkdownPreview
            markdown={markdown}
            filePath={source.kind === "local" ? source.location : undefined}
            workspaceRoot={workspaceRoot}
            onLinkClick={href => void openExternalUrl(href).catch(error => notify(error instanceof Error ? error.message : "无法打开链接"))}
          />
        </div>
      </div>}
    </div>
  </div>;
}
