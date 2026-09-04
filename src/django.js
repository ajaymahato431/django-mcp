/**
 * Django-specific documentation handling: converting the reStructuredText
 * sources Sphinx publishes under `_sources/` into agent-friendly markdown.
 */

import { collapseBlankLines } from "./core/markdown.js";

export const DOCS_ORIGIN = "https://docs.djangoproject.com/en";

/** Underline characters, in Django's documented heading order. */
const HEADING_LEVELS = { "=": 1, "-": 2, "~": 3, "^": 4, '"': 5, "'": 6 };

const UNDERLINE = /^([=\-~^"'`#*+.])\1{2,}\s*$/;

/** Admonitions worth keeping, rendered as markdown blockquotes. */
const ADMONITIONS = new Set([
  "note",
  "warning",
  "important",
  "caution",
  "danger",
  "tip",
  "hint",
  "admonition",
  "versionadded",
  "versionchanged",
  "deprecated",
]);

/**
 * Resolves an underline character to a heading level.
 *
 * Django follows a fixed convention (`=` title, `-` section, `~` subsection,
 * `^`, then `"`), so the level is looked up rather than inferred. The previous
 * version assigned levels in order of first appearance, which meant a page
 * opening with a `-` underline had its sections promoted to `#`, inverting the
 * hierarchy that section extraction depends on. Characters outside the
 * convention still fall back to appearance order.
 */
function createLevelResolver() {
  const discovered = new Map();
  let next = Math.max(...Object.values(HEADING_LEVELS)) + 1;

  return (char) => {
    const known = HEADING_LEVELS[char];
    if (known) return known;
    if (!discovered.has(char)) discovered.set(char, Math.min(6, next++));
    return discovered.get(char);
  };
}

/** True when `line` is a plausible heading for the following underline. */
function isHeadingText(line) {
  return line.trim().length > 0 && !/^\s/.test(line);
}

/**
 * Converts reST section headings to ATX markdown headings.
 * Handles both `text` + underline and overline + `text` + underline.
 */
function convertHeadings(text) {
  const lines = text.split("\n");
  const out = [];
  const levelFor = createLevelResolver();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const overline = line.match(UNDERLINE);

    // overline / text / underline
    if (overline) {
      const title = lines[i + 1];
      const underline = lines[i + 2];
      if (
        title !== undefined &&
        underline !== undefined &&
        isHeadingText(title) &&
        underline.trim() === line.trim()
      ) {
        out.push(`${"#".repeat(levelFor(overline[1]))} ${title.trim()}`);
        i += 2;
        continue;
      }
    }

    // text / underline
    const next = lines[i + 1];
    const underline = next?.match(UNDERLINE);
    if (underline && isHeadingText(line) && next.trim().length >= line.trim().length) {
      out.push(`${"#".repeat(levelFor(underline[1]))} ${line.trim()}`);
      i++;
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

const CODE_DIRECTIVES = new Set(["code-block", "sourcecode", "code", "highlight"]);

const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

/**
 * Rewrites reST directives line by line.
 *
 * Code blocks need this rather than a regex: reStructuredText delimits them by
 * indentation, with no closing marker. Emitting an opening ``` fence without
 * tracking where the block ends leaves the fence unbalanced, which makes every
 * later heading look like it is inside code — and silently unfindable.
 */
function convertDirectives(text) {
  const lines = text.split("\n");
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Anchor targets: `.. _some-label:`
    if (/^\s*\.\.\s+_[A-Za-z0-9_.-]+:\s*$/.test(line)) continue;

    const directive = line.match(/^([ \t]*)\.\.\s+([a-zA-Z][a-zA-Z0-9_-]*)::[ \t]*(.*)$/);
    if (!directive) {
      out.push(line);
      continue;
    }

    const [, indent, rawName, argument] = directive;
    const name = rawName.toLowerCase();

    if (ADMONITIONS.has(name)) {
      const label = name
        .replace(/^versionadded$/, "version added")
        .replace(/^versionchanged$/, "version changed");
      const suffix = argument.trim() ? `: ${argument.trim()}` : "";
      out.push(`${indent}> **${label.toUpperCase()}${suffix}**`);
      continue;
    }

    if (CODE_DIRECTIVES.has(name)) {
      const base = indent.length;
      const language = argument.trim().split(/\s+/)[0] ?? "";

      // Skip directive options (`:linenos:`) and the blank line that follows.
      let j = i + 1;
      while (j < lines.length && /^\s*:[a-zA-Z-]+:/.test(lines[j])) j++;
      while (j < lines.length && lines[j].trim() === "") j++;

      // The block runs to the next non-blank line at or left of the directive.
      let end = j;
      for (let k = j; k < lines.length; k++) {
        if (lines[k].trim() === "") continue;
        if (indentOf(lines[k]) <= base) break;
        end = k + 1;
      }

      if (end > j) {
        out.push(`${indent}\`\`\`${language}`);
        for (let k = j; k < end; k++) out.push(lines[k]);
        out.push(`${indent}\`\`\``);
        i = end - 1;
      }
      continue;
    }

    // Everything else (currentmodule, module, setting, templatetag, method,
    // class, fieldlookup, …) is scaffolding: the human-readable heading that
    // follows carries the same information. Drop the line, keep its content.
  }

  return out.join("\n");
}

/**
 * Converts Sphinx reStructuredText to markdown, dropping the machinery that
 * only exists to build the HTML site.
 */
export function cleanText(text) {
  let out = String(text).replace(/<!--[\s\S]*?-->/g, "");

  out = convertDirectives(out);

  // Interpreted-text roles: :class:`Model` -> `Model`, :setting:`DEBUG` -> `DEBUG`.
  out = out.replace(/:[a-zA-Z0-9_+-]+:`([^`]+)`/g, (_, body) => {
    // `Title <target>` keeps only the title.
    const titled = body.match(/^(.*?)\s*<[^>]+>$/);
    return `\`${(titled ? titled[1] : body).trim()}\``;
  });

  out = convertHeadings(out);

  return collapseBlankLines(out).trim();
}

/**
 * Source URL for a page. Sphinx publishes the reST source under `_sources/`,
 * which is far cheaper to parse than the rendered HTML.
 */
export function sourceUrl(version, path) {
  return `${DOCS_ORIGIN}/${version}/_sources/${path}.txt`;
}

/** Human-facing URL for a page or anchor. */
export function pageUrl(version, path, anchor = "") {
  return `${DOCS_ORIGIN}/${version}/${path}/${anchor ? `#${anchor}` : ""}`;
}

export function inventoryUrl(version) {
  return `${DOCS_ORIGIN}/${version}/objects.inv`;
}

/** Normalises a caller-supplied doc path. */
export function normalizePath(path) {
  return String(path)
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.txt$/, "");
}
