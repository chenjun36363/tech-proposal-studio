// Lightweight, dependency-free fuzzy string matcher.
// Used by the model picker combobox to filter providers/models by a free-text query.

/** Sentinel score for "no match at all" (e.g. query is not a subsequence of text). */
export const NO_MATCH = Number.POSITIVE_INFINITY;

/**
 * Score how well `query` matches `text`.
 * Lower scores are better. Returns {@link NO_MATCH} when the query is not a
 * subsequence of the text (so it can be filtered out).
 *
 * Ranking preference:
 *  - exact substring match  → ranked by earliest occurrence position
 *  - subsequence match      → ranked by accumulated gap distance, with a bonus
 *                             for consecutive characters; shorter texts win ties
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (!t) return NO_MATCH;

  const exact = t.indexOf(q);
  if (exact !== -1) return exact;

  let cursor = 0;
  let score = 0;
  let prevMatched = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, cursor);
    if (found === -1) return NO_MATCH;
    if (found === prevMatched + 1) {
      // consecutive hit: tiny bonus, no gap penalty
      score -= 0.5;
    } else {
      score += found - cursor + 1;
    }
    prevMatched = found;
    cursor = found + 1;
  }
  // Prefer shorter targets when scores are otherwise close.
  return score + t.length * 0.001;
}

/**
 * Return the list of entries whose combined searchable string matches `query`,
 * sorted best-first. Empty/`undefined` queries return the input unchanged.
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  toText: (item: T) => string,
): T[] {
  const q = query.trim();
  if (!q) return items;
  return items
    .map(item => ({ item, score: fuzzyScore(q, toText(item)) }))
    .filter(entry => entry.score !== NO_MATCH)
    .sort((a, b) => a.score - b.score)
    .map(entry => entry.item);
}
