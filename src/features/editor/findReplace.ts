export type FindMatch = { start: number; end: number };

type NormalizedText = { text: string; boundaries: number[] };

/**
 * Textarea values use LF line endings, while files opened from Windows can
 * still contain CRLF. Normalize only for matching and retain a boundary map
 * so returned ranges remain offsets into the original document.
 */
function normalizeLineEndings(value: string): NormalizedText {
  let text = "";
  const boundaries = [0];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\r") {
      if (value[index + 1] === "\n") index += 1;
      text += "\n";
      boundaries.push(index + 1);
      continue;
    }
    text += char;
    boundaries.push(index + 1);
  }
  return { text, boundaries };
}

export function findMatches(
  text: string,
  query: string,
  opts?: { caseSensitive?: boolean },
): FindMatch[] {
  if (!query) return [];
  const caseSensitive = opts?.caseSensitive ?? false;
  const normalizedHay = normalizeLineEndings(text);
  const normalizedNeedle = normalizeLineEndings(query).text;
  const hay = caseSensitive ? normalizedHay.text : normalizedHay.text.toLowerCase();
  const needle = caseSensitive ? normalizedNeedle : normalizedNeedle.toLowerCase();
  if (!needle) return [];

  const matches: FindMatch[] = [];
  let from = 0;
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    matches.push({
      start: normalizedHay.boundaries[idx],
      end: normalizedHay.boundaries[idx + needle.length],
    });
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
