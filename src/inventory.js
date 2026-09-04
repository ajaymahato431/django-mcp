/**
 * Sphinx object inventory (`objects.inv`) parsing.
 *
 * Django publishes a compressed inventory of every documented object — roughly
 * 8,100 entries for 6.0, covering pages, settings, template tags, field lookups,
 * classes, methods and attributes, each with the page and anchor it lives at.
 *
 * One ~110 KB request therefore replaces both the recursive table-of-contents
 * crawl the previous version used to enumerate pages, and the keyword search it
 * never had. It also gives exact anchors, which is what makes it possible to
 * return a single symbol's section rather than a whole page.
 *
 * Format (inventory version 2):
 *
 *     # Sphinx inventory version 2
 *     # Project: Django
 *     # Version: 6.0
 *     # The remainder of this file is compressed using zlib.
 *     <zlib stream of "name domain:role priority uri dispname" lines>
 */

import { inflateSync } from "node:zlib";

/**
 * Names may contain spaces (labels and glossary terms do), so the name is
 * matched non-greedily up to the domain:role field. This mirrors Sphinx's own
 * parser and accounts for all 8,101 rows in the Django 6.0 inventory.
 */
const ROW = /^(.+?)\s+(\S+)\s+(-?\d+)\s+?(\S*)\s+(.*)$/;

const HEADER_LINES = 4;

export class InventoryError extends Error {}

/** Splits the plain-text header from the zlib-compressed body. */
function splitHeader(buffer) {
  let offset = 0;
  let seen = 0;

  while (seen < HEADER_LINES && offset < buffer.length) {
    if (buffer[offset] === 0x0a) seen++;
    offset++;
  }

  if (seen < HEADER_LINES) {
    throw new InventoryError("Inventory is truncated: the header is incomplete.");
  }

  return {
    header: buffer.subarray(0, offset).toString("utf8"),
    body: buffer.subarray(offset),
  };
}

/**
 * Parses an `objects.inv` buffer.
 *
 * Returns `{ project, version, entries }` where each entry is
 * `{ name, shortName, domain, role, path, anchor, title }`.
 */
export function parseInventory(buffer) {
  const { header, body } = splitHeader(buffer);

  if (!header.startsWith("# Sphinx inventory version 2")) {
    throw new InventoryError(
      "Unsupported inventory format; expected Sphinx inventory version 2."
    );
  }

  const project = header.match(/^# Project:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const version = header.match(/^# Version:\s*(.+)$/m)?.[1]?.trim() ?? "";

  let text;
  try {
    text = inflateSync(body).toString("utf8");
  } catch (error) {
    throw new InventoryError(`Could not decompress the inventory: ${error.message}`);
  }

  const entries = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;

    const match = line.match(ROW);
    if (!match) continue;

    const [, name, domainRole, , uri, dispname] = match;
    const separator = domainRole.lastIndexOf(":");
    const domain = separator === -1 ? "" : domainRole.slice(0, separator);
    const role = separator === -1 ? domainRole : domainRole.slice(separator + 1);

    const hash = uri.indexOf("#");
    const rawPath = hash === -1 ? uri : uri.slice(0, hash);
    // A trailing `$` in the anchor is Sphinx shorthand for "the object's name".
    const anchor = hash === -1 ? "" : uri.slice(hash + 1).replace(/\$$/, name);

    entries.push({
      name,
      // Dotted paths are how Django names most objects; the trailing segment is
      // what people actually search for ("ForeignKey", not the full dotted path).
      shortName: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name,
      domain,
      role,
      path: rawPath.replace(/\/+$/, ""),
      anchor,
      title: dispname === "-" ? name : dispname,
    });
  }

  if (entries.length === 0) {
    throw new InventoryError("The inventory decompressed but contained no usable entries.");
  }

  return { project, version, entries };
}

/** Documentation pages, as `{ path, title }`, sorted by path. */
export function documentPages(entries) {
  return entries
    .filter((entry) => entry.role === "doc" && entry.path)
    .map((entry) => ({ path: entry.path, title: entry.title }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Top-level path segment, e.g. `topics/db/models` -> `topics`. */
export function sectionOf(path) {
  return path.includes("/") ? path.split("/")[0] : "(top-level)";
}

/** `{ section, count }` rows in descending size order. */
export function groupBySection(pages) {
  const counts = new Map();
  for (const page of pages) {
    const section = sectionOf(page.path);
    counts.set(section, (counts.get(section) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([section, count]) => ({ section, count }))
    .sort((a, b) => b.count - a.count || a.section.localeCompare(b.section));
}

/**
 * Roles a caller can filter by, mapped to the inventory's own role names.
 * Exposed as friendly aliases so the tool schema does not leak Sphinx jargon.
 */
export const ROLE_ALIASES = {
  page: ["doc"],
  setting: ["setting"],
  templatetag: ["templatetag"],
  templatefilter: ["templatefilter"],
  fieldlookup: ["fieldlookup"],
  class: ["class", "exception"],
  method: ["method", "function"],
  attribute: ["attribute", "data"],
  module: ["module"],
  command: ["django-admin", "cmdoption"],
  label: ["label", "term"],
};

export const ROLE_FILTERS = Object.keys(ROLE_ALIASES);

export function filterByRole(entries, role) {
  const roles = ROLE_ALIASES[role];
  if (!roles) return entries;
  const allowed = new Set(roles);
  return entries.filter((entry) => allowed.has(entry.role));
}

/**
 * Scores an inventory entry against a query.
 *
 * Django names most objects with a full dotted path, so an exact match on the
 * trailing segment must rank as highly as an exact match on the whole name —
 * people search for `ForeignKey`, not `django.db.models.ForeignKey`.
 */
export function scoreSymbol(entry, query) {
  const q = String(query).toLowerCase().trim();
  if (!q) return 0;

  const name = entry.name.toLowerCase();
  const short = entry.shortName.toLowerCase();
  const title = String(entry.title ?? "").toLowerCase();
  const path = String(entry.path ?? "").toLowerCase();

  if (name === q || short === q) return 100;
  if (short.startsWith(q)) return 85;
  if (name.startsWith(q)) return 75;
  if (title === q) return 70;
  if (short.includes(q)) return 60;
  if (name.includes(q)) return 50;
  if (title.includes(q)) return 40;
  if (path.includes(q)) return 25;

  const words = q.split(/[\s._:-]+/).filter(Boolean);
  if (words.length === 0) return 0;

  const matched = words.filter(
    (w) => name.includes(w) || title.includes(w) || path.includes(w)
  ).length;

  return matched === 0 ? 0 : Math.round(20 * (matched / words.length));
}

/** Ranked symbol search. Pages rank above members when scores tie. */
export function searchSymbols(entries, query, { limit = 10, role } = {}) {
  const pool = role ? filterByRole(entries, role) : entries;
  const rolePriority = (entry) => (entry.role === "doc" ? 0 : entry.role === "setting" ? 1 : 2);

  return pool
    .map((entry) => ({ ...entry, score: scoreSymbol(entry, query) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        rolePriority(a) - rolePriority(b) ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name)
    )
    .slice(0, Math.max(1, limit));
}

/** Resolves a symbol name to a single best entry, or null. */
export function resolveSymbol(entries, name) {
  const [best] = searchSymbols(entries, name, { limit: 1 });
  return best && best.score >= 50 ? best : null;
}
