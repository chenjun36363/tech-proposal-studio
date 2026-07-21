export type FindMatch = { start: number; end: number };

export function findMatches(
  text: string,
  query: string,
  opts?: { caseSensitive?: boolean },
): FindMatch[] {
  if (!query) return [];
  const caseSensitive = opts?.caseSensitive ?? false;
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (!needle) return [];

  const matches: FindMatch[] = [];
  let from = 0;
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    matches.push({ start: idx, end: idx + query.length });
    from = idx + Math.max(1, needle.length);
  }
  return matches;
}

export function replaceMatch(
  text: string,
  match: FindMatch,
  replacement: string,
): { text: string; nextCaret: number } {
  const next = text.slice(0, match.start) + replacement + text.slice(match.end);
  return { text: next, nextCaret: match.start + replacement.length };
}

export function replaceAllMatches(
  text: string,
  query: string,
  replacement: string,
  opts?: { caseSensitive?: boolean },
): { text: string; count: number } {
  const matches = findMatches(text, query, opts);
  if (!matches.length) return { text, count: 0 };

  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start) + replacement;
    cursor = m.end;
  }
  out += text.slice(cursor);
  return { text: out, count: matches.length };
}
