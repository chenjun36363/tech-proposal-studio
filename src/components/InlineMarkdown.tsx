import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

const INLINE_TAGS = ["strong", "em", "del", "code", "br"];

export function renderInlineMarkdown(markdown: string): string {
  const rendered = marked.parseInline(markdown, { gfm: true, breaks: false }) as string;
  return DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS: INLINE_TAGS,
    ALLOWED_ATTR: [],
  });
}

export function InlineMarkdown({ children, className }: { children: string; className?: string }) {
  const html = useMemo(() => renderInlineMarkdown(children), [children]);
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
