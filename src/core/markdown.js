/**
 * Markdown post-processing shared by all three documentation servers:
 * heading discovery and precise section extraction.
 *
 * Vendored shared module — keep byte-identical across django-mcp, filament-mcp
 * and livewire-mcp so that a fix here is a copy, not a merge.
 */

/** Lines inside fenced code blocks must never be mistaken for headings. */
function* iterateLines(md) {
  const lines = md.split("\n");
  let inFence = false;
  let fenceMarker = "";

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);

    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      yield { index, line, inFence: true };
      continue;
    }

    yield { index, line, inFence };
  }
}

/** All ATX headings in document order: `{ level, title, index }`. */
export function listSections(md) {
  const headings = [];
  for (const { index, line, inFence } of iterateLines(md)) {
    if (inFence) continue;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) headings.push({ level: match[1].length, title: match[2].trim(), index });
  }
  return headings;
}

/**
 * Strips inline code and emphasis markers, and a trailing call signature, so
 * that a heading like ``` `select_related()` ``` is comparable to the plain
 * name a caller would ask for.
 */
function bareTitle(title) {
  return (
    title
      // Backticks and asterisks are formatting. Underscores are NOT stripped:
      // in these docs they are almost always part of an identifier, and removing
      // them turns `prefetch_related` into something no query can match.
      .replace(/[`*]/g, "")
      .replace(/\([^)]*\)\s*$/, "")
      .trim()
  );
}

/**
 * Ranks a heading against the requested section name.
 *
 * Ordering matters twice over. A plain `includes()` check makes a request for
 * "Fields" capture "Fields in forms" whenever that heading comes first; and
 * without stripping formatting, a request for "DEBUG" scores ``` `DEBUG` ``` as
 * a mere substring while "Debugging" wins on prefix. Exact matches win, then
 * prefix, then substring — each measured against the formatted and bare forms.
 */
function rankHeading(title, target) {
  const candidates = new Set([title.toLowerCase().trim(), bareTitle(title).toLowerCase()]);

  let best = 0;
  for (const candidate of candidates) {
    if (candidate === target) best = Math.max(best, 3);
    else if (candidate.startsWith(target)) best = Math.max(best, 2);
    else if (candidate.includes(target)) best = Math.max(best, 1);
  }
  return best;
}

/**
 * Returns the content under the best-matching heading, from that heading up to
 * the next heading of equal or higher level. Returns null when nothing matches.
 */
export function extractSection(md, sectionName) {
  const target = String(sectionName || "").toLowerCase().trim();
  if (!target) return null;

  const headings = listSections(md);
  if (headings.length === 0) return null;

  let best = null;
  for (const heading of headings) {
    const score = rankHeading(heading.title, target);
    if (score === 0) continue;
    // Best score wins; ties go to the shallower heading (more context), then to
    // whichever appears first in the document.
    if (
      !best ||
      score > best.score ||
      (score === best.score && heading.level < best.heading.level)
    ) {
      best = { score, heading };
    }
  }

  if (!best) return null;

  const lines = md.split("\n");
  const start = best.heading.index;
  let end = lines.length;

  for (const heading of headings) {
    if (heading.index > start && heading.level <= best.heading.level) {
      end = heading.index;
      break;
    }
  }

  const result = lines.slice(start, end).join("\n").trim();
  return result || null;
}

/**
 * Human-readable heading outline, used to tell the caller what *is* available
 * when their requested section does not exist — far cheaper than returning the
 * entire page as a fallback.
 */
export function renderOutline(md, { maxLevel = 3, limit = 40 } = {}) {
  const headings = listSections(md).filter((h) => h.level <= maxLevel);
  if (headings.length === 0) return "(this page has no headings)";

  const shown = headings.slice(0, limit);
  const lines = shown.map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}- ${h.title}`);
  if (headings.length > shown.length) {
    lines.push(`  … and ${headings.length - shown.length} more`);
  }
  return lines.join("\n");
}

export function stripHtmlComments(md) {
  return md.replace(/<!--[\s\S]*?-->/g, "");
}

export function collapseBlankLines(md) {
  return md.replace(/\n{3,}/g, "\n\n");
}

/** Rough token estimate (~4 chars/token) for cost reporting in tool output. */
export function estimateTokens(text) {
  return Math.ceil((text?.length ?? 0) / 4);
}
