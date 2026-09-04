/**
 * Keyword scoring and ranking over documentation index entries.
 *
 * Vendored shared module — keep byte-identical across django-mcp, filament-mcp,
 * livewire-mcp, and frontlens-mcp so that a fix here is a copy, not a merge.
 */

const WORD_SPLIT = /[\s/._:-]+/;

function normalize(value) {
  return String(value ?? "").toLowerCase().trim();
}

/**
 * Scores one index entry against a query. Higher is better; 0 means no match.
 *
 * The ladder is deliberately coarse — exact title, prefix, substring, path —
 * with a tokenized fallback so multi-word queries such as "select filter"
 * still rank pages matching only some of the words.
 */
export function scoreMatch(entry, query) {
  const q = normalize(query);
  if (!q) return 0;

  const title = normalize(entry.title);
  const path = normalize(entry.path);
  const summary = normalize(entry.summary);
  const category = normalize(entry.category);

  if (title === q) return 100;
  if (path === q) return 95;
  if (title.startsWith(q)) return 80;
  if (title.includes(q)) return 60;
  if (path.endsWith(`/${q}`)) return 55;
  if (path.includes(q)) return 40;
  if (category === q) return 35;

  const words = q.split(WORD_SPLIT).filter(Boolean);
  if (words.length === 0) return 0;

  const matched = words.filter(
    (w) => title.includes(w) || path.includes(w) || summary.includes(w) || category.includes(w)
  ).length;
  if (matched === 0) return 0;

  // Partial coverage caps below any whole-query match above.
  return Math.round(30 * (matched / words.length));
}

/**
 * Ranks entries by score, breaking ties with shorter paths first so that
 * "forms/select" outranks "forms/select/advanced-usage" for the query "select".
 */
export function searchEntries(entries, query, { limit = 5, scorer = scoreMatch } = {}) {
  return entries
    .map((entry) => ({ ...entry, score: scorer(entry, query) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.path).length - String(b.path).length ||
        String(a.path).localeCompare(String(b.path))
    )
    .slice(0, Math.max(1, limit));
}
