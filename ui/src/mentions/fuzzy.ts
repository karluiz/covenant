/**
 * Subsequence fuzzy score. Returns null if `query` is not a subsequence
 * of `haystack`. Higher is better. Mirrors the Rust scorer in
 * crates/app/src/file_search.rs — two-pass (greedy from 0, greedy from
 * basename start) so basename-prefix matches are not lost when an
 * earlier mid-path char would consume the first query char.
 *
 * Bonuses: consecutive matches, post-separator matches, and basename
 * prefix on the very first query char.
 */
export function fuzzyScore(haystack: string, query: string): number | null {
  if (!query) return 0;
  const h = haystack.toLowerCase();
  const q = query.toLowerCase();
  const lastSlash = h.lastIndexOf("/");
  const basenameStart = lastSlash >= 0 ? lastSlash + 1 : 0;

  const scoreFrom = (start: number): number | null => {
    let qi = 0;
    let score = 0;
    let prevMatch = false;
    let lastSep = -1;
    for (let i = 0; i < start; i++) {
      if (h[i] === "/") lastSep = i;
    }
    for (let i = start; i < h.length; i++) {
      if (h[i] === "/") lastSep = i;
      if (qi < q.length && h[i] === q[qi]) {
        score += 1;
        if (prevMatch) score += 3;
        if (i === lastSep + 1) score += 4;
        if (i === basenameStart && qi === 0) score += 10;
        qi++;
        prevMatch = true;
      } else {
        prevMatch = false;
      }
    }
    return qi === q.length ? score : null;
  };

  const a = scoreFrom(0);
  const b = scoreFrom(basenameStart);
  if (a === null && b === null) return null;
  return Math.max(a ?? -Infinity, b ?? -Infinity);
}
