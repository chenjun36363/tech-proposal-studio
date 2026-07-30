import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { marked } from "marked";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isDesktop } from "./services/runtime";
import { saveImageToWorkspace } from "./workspace";
import type { FindMatch } from "./findReplace";

marked.setOptions({ gfm: true, breaks: true });

export type MarkdownSourceEditorHandle = {
  getSelection: () => { start: number; end: number };
  focus: () => void;
  setSelection: (start: number, end: number) => void;
  scrollToSelection: () => void;
};

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(0, i) : "";
}

function joinPath(base: string, rel: string): string {
  const clean = rel.replace(/^\.\//, "").replace(/\\/g, "/");
  if (!base) return clean;
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${clean.replace(/\//g, sep)}`;
}

function isAbsolutePath(src: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(src);
}

/** marked URL-encodes non-ASCII image destinations; filesystem APIs need the decoded path. */
export function decodeLocalImagePath(src: string): string {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

/** Resolve relative markdown images against the open file dir, else workspace root (paste → assets/). */
function rewriteLocalImages(html: string, filePath?: string, workspaceRoot?: string): string {
  if (!isDesktop()) return html;
  const bases = [
    filePath ? dirname(filePath) : "",
    workspaceRoot || "",
  ].filter(Boolean);
  if (!bases.length) return html;

  return html.replace(/<img\s+([^>]*?)src=["']([^"']+)["']([^>]*)>/gi, (full, pre, src, post) => {
    if (/^(https?:|data:|asset:|blob:|tauri:)/i.test(src)) return full;
    try {
      const decoded = decodeLocalImagePath(src);
      const normalized = decoded.replace(/\\/g, "/");
      let abs = "";
      if (isAbsolutePath(decoded) || isAbsolutePath(normalized)) {
        abs = decoded;
      } else {
        // Prefer workspace root for assets/… (paste target); else file directory
        if (/^assets\//i.test(normalized) && workspaceRoot) {
          abs = joinPath(workspaceRoot, normalized);
        } else {
          abs = joinPath(bases[0], normalized);
        }
      }
      const asset = convertFileSrc(abs);
      return `<img ${pre}src="${asset}"${post}>`;
    } catch {
      return full;
    }
  });
}

export function highlightPreviewHtml(html: string, query: string, caseSensitive = false): string {
  if (!query || typeof document === "undefined") return html;
  const root = document.createElement("div");
  root.innerHTML = html;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  for (const node of nodes) {
    if (node.parentElement?.closest("script,style")) continue;
    const source = node.data;
    const searchable = caseSensitive ? source : source.toLocaleLowerCase();
    let cursor = 0;
    let index = searchable.indexOf(needle);
    if (index < 0) continue;
    const fragment = document.createDocumentFragment();
    while (index >= 0) {
      fragment.append(source.slice(cursor, index));
      const mark = document.createElement("mark");
      mark.className = "md-search-match";
      mark.textContent = source.slice(index, index + query.length);
      fragment.append(mark);
      cursor = index + query.length;
      index = searchable.indexOf(needle, cursor);
    }
    fragment.append(source.slice(cursor));
    node.replaceWith(fragment);
  }
  return root.innerHTML;
}

export function MarkdownPreview({
  markdown,
  filePath,
  workspaceRoot,
  onLinkClick,
  searchQuery = "",
  searchCaseSensitive = false,
}: {
  markdown: string;
  filePath?: string;
  workspaceRoot?: string;
  onLinkClick?: (href: string) => void;
  searchQuery?: string;
  searchCaseSensitive?: boolean;
}) {
  const html = useMemo(() => {
    const raw = marked.parse(markdown || "") as string;
    return highlightPreviewHtml(rewriteLocalImages(raw, filePath, workspaceRoot), searchQuery, searchCaseSensitive);
  }, [markdown, filePath, workspaceRoot, searchQuery, searchCaseSensitive]);
  return <div
    className="md-preview"
    onClick={e => {
      const anchor = (e.target as HTMLElement).closest("a");
      if (!anchor || !onLinkClick) return;
      e.preventDefault();
      onLinkClick(anchor.href);
    }}
    dangerouslySetInnerHTML={{ __html: html }}
  />;
}

export const MarkdownSourceEditor = forwardRef<MarkdownSourceEditorHandle, {
  value: string;
  onChange: (v: string) => void;
  workspaceRoot?: string;
  onImageInserted?: (markdownImage: string) => void;
  onSelectionChange?: (selection: { start: number; end: number }) => void;
  placeholder?: string;
  highlights?: FindMatch[];
  activeHighlight?: number;
}>(function MarkdownSourceEditor({
  value,
  onChange,
  workspaceRoot,
  onImageInserted,
  onSelectionChange,
  placeholder,
  highlights = [],
  activeHighlight = 0,
}, ref) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!composingRef.current) setDraft(value);
  }, [value]);

  useImperativeHandle(ref, () => ({
    getSelection: () => {
      const el = taRef.current;
      if (!el) return { start: 0, end: 0 };
      return { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
    },
    focus: () => taRef.current?.focus(),
    setSelection: (start: number, end: number) => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, end);
    },
    scrollToSelection: () => {
      const el = taRef.current;
      if (!el) return;
      const start = el.selectionStart ?? 0;
      const before = el.value.slice(0, start);
      const line = before.split("\n").length;
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22;
      const paddingTop = parseFloat(getComputedStyle(el).paddingTop) || 0;
      const target = Math.max(0, (line - 2) * lineHeight + paddingTop - el.clientHeight / 3);
      el.scrollTop = target;
    },
  }), []);

  const insertAtCursor = (snippet: string) => {
    const el = taRef.current;
    if (!el) {
      const next = draft + snippet;
      setDraft(next);
      onChange(next);
      return;
    }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + snippet + draft.slice(end);
    setDraft(next);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + snippet.length;
      el.setSelectionRange(pos, pos);
    });
    onImageInserted?.(snippet);
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((it) => it.type.startsWith("image/"));
    if (!imageItem) return;
    if (!workspaceRoot || !isDesktop()) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const saved = await saveImageToWorkspace(workspaceRoot, Array.from(buf), file.name || "paste.png");
      insertAtCursor(`\n![image](${saved.relativePath.replace(/\\/g, "/")})\n`);
    } catch (err) {
      console.error(err);
    }
  };

  const highlighted = useMemo(() => {
    if (!highlights.length) return null;
    const parts: ReactNode[] = [];
    let cursor = 0;
    highlights.forEach((match, index) => {
      parts.push(<span key={`text-${index}`}>{draft.slice(cursor, match.start)}</span>);
      parts.push(<mark key={`match-${index}`} className={index === activeHighlight ? "active" : ""}>{draft.slice(match.start, match.end)}</mark>);
      cursor = match.end;
    });
    parts.push(<span key="tail">{draft.slice(cursor)}</span>);
    return parts;
  }, [draft, highlights, activeHighlight]);

  return (
    <div className="md-source-editor">
      {highlighted && <div className="md-source-highlight" aria-hidden="true"><div ref={highlightRef}>{highlighted}</div></div>}
      <textarea
        ref={taRef}
        className="md-source"
        value={draft}
        placeholder={placeholder ?? "在此编辑 Markdown…"}
        spellCheck={false}
        wrap="soft"
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          if (!composingRef.current) onChange(next);
        }}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={(e) => {
          composingRef.current = false;
          const next = e.currentTarget.value;
          setDraft(next);
          onChange(next);
        }}
        onSelect={event => onSelectionChange?.({
          start: event.currentTarget.selectionStart ?? 0,
          end: event.currentTarget.selectionEnd ?? 0,
        })}
        onPaste={(e) => void handlePaste(e)}
        onScroll={event => {
          if (highlightRef.current) highlightRef.current.style.transform = `translate(${-event.currentTarget.scrollLeft}px, ${-event.currentTarget.scrollTop}px)`;
        }}
      />
    </div>
  );
});
