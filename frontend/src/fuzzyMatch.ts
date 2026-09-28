/** Score how well `text` matches one search `word` — lower is better, null means no match at
 *  all. An exact substring always beats a fuzzy one; among substrings, an earlier and tighter
 *  match ranks first (so "oct" prefers "October" over "some october thing"). Failing that, the
 *  word's letters just need to appear in order somewhere in `text` (not necessarily together) —
 *  the same "type roughly what you mean" matching a command palette or fzf gives you, so a typo
 *  or a word out of order still finds the right row instead of nothing at all. */
function scoreWord(text: string, word: string): number | null {
  const idx = text.indexOf(word);
  if (idx !== -1) return idx;
  if (word.length < 2) return null;   // a single stray character subsequence-matches almost anything
  let ti = 0, gaps = 0;
  for (const ch of word) {
    const found = text.indexOf(ch, ti);
    if (found === -1) return null;
    gaps += found - ti;
    ti = found + 1;
  }
  return 10_000 + gaps;
}

/** Splits `query` on whitespace and requires every word to match somewhere in `haystack`
 *  (order between words doesn't matter — "oct sat" and "sat oct" match the same rows), summing
 *  each word's score for ranking. Returns null (no match) when any word fails outright. */
export function fuzzyScore(haystack: string, query: string): number | null {
  const text = haystack.toLowerCase();
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let total = 0;
  for (const w of words) {
    const s = scoreWord(text, w);
    if (s === null) return null;
    total += s;
  }
  return total;
}

/** Filters and ranks `items` by how well `keyOf(item)` matches `query`, best match first —
 *  unchanged relative order for items that score equally (a stable sort), and the original list
 *  back unfiltered when `query` is blank. */
export function fuzzyFilter<T>(items: T[], query: string, keyOf: (item: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(keyOf(item), query) }))
    .filter((r): r is { item: T; index: number; score: number } => r.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((r) => r.item);
}
