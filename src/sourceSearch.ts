import type { SourceRecord } from "./types";

export function sourceSearchTokens(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesSource(source: SourceRecord, query: string, content = ""): boolean {
  const tokens = sourceSearchTokens(query);
  if (!tokens.length) return true;
  const haystack = `${source.title}\n${source.excerpt}\n${source.location}\n${source.heading ?? ""}\n${content}`.toLocaleLowerCase();
  return tokens.every(token => haystack.includes(token));
}

export function sourceMatchExcerpt(source: SourceRecord, query: string, content = "", length = 180): string {
  const token = sourceSearchTokens(query)[0];
  if (!token || !content) return source.excerpt;
  const normalized = content.replace(/\s+/g, " ").trim();
  const index = normalized.toLocaleLowerCase().indexOf(token);
  if (index < 0) return source.excerpt;
  const start = Math.max(0, index - Math.floor(length / 3));
  const end = Math.min(normalized.length, start + length);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}
