import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isDesktop } from "./services/runtime";
import { saveImageToWorkspace } from "./workspace";

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
      const normalized = src.replace(/\\/g, "/");
      let abs = "";
      if (isAbsolutePath(src) || isAbsolutePath(normalized)) {
        abs = src;
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

export function MarkdownPreview({
  markdown,
  filePath,
  workspaceRoot,
  onLinkClick,
}: {
  markdown: string;
  filePath?: string;
  workspaceRoot?: string;
  onLinkClick?: (href: string) => void;
}) {
  const html = useMemo(() => {
    const raw = marked.parse(markdown || "") as string;
    return rewriteLocalImages(raw, filePath, workspaceRoot);
  }, [markdown, filePath, workspaceRoot]);
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
  placeholder?: string;
}>(function MarkdownSourceEditor({
  value,
  onChange,
  workspaceRoot,
  onImageInserted,
  placeholder,
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

  const syncHighlightScroll = () => {
    const textarea = taRef.current;
    const highlight = highlightRef.current;
    if (!textarea || !highlight) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  };

  return (
    <div className="md-source-editor">
      <div ref={highlightRef} className="md-source-highlight" aria-hidden="true">
        {draft.split("\n").map((line, index) => {
          const heading = /^(#{1,6})(?:[ \t]+|$)/.exec(line);
          return <div className={heading ? `md-source-heading heading-${heading[1].length}` : undefined} key={index}>{line || " "}</div>;
        })}
      </div>
      <textarea
        ref={taRef}
        className="md-source"
        value={draft}
        placeholder={placeholder ?? "在此编辑 Markdown…"}
        spellCheck={false}
        wrap="soft"
        onScroll={syncHighlightScroll}
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
        onPaste={(e) => void handlePaste(e)}
      />
    </div>
  );
});
