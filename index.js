#!/usr/bin/env node
/**
 * django-mcp — Model Context Protocol server for Django documentation.
 *
 * Fetches, cleans and serves Django docs to AI agents over stdio, with an
 * emphasis on returning the smallest useful slice of a page.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { bootstrap } from "./src/core/config.js";
import { createHttpClient } from "./src/core/http.js";
import { extractSection, renderOutline } from "./src/core/markdown.js";
import { runMain, serveStdio, textResult, errorResult, safeHandler } from "./src/core/runtime.js";
import {
  parseInventory,
  documentPages,
  groupBySection,
  sectionOf,
  searchSymbols,
  resolveSymbol,
  ROLE_FILTERS,
} from "./src/inventory.js";
import { cleanText, sourceUrl, pageUrl, inventoryUrl, normalizePath } from "./src/django.js";
import { ALL_TOPICS, renderBestPractices } from "./src/best-practices.js";
import { NAME, VERSION, SCHEMA } from "./src/settings.js";

const { config } = bootstrap({
  name: NAME,
  version: VERSION,
  description: "Serves Django documentation to AI agents over the Model Context Protocol.",
  schema: SCHEMA,
  importMetaUrl: import.meta.url,
  examples: [`${NAME} --docs-version 5.2`, `${NAME} --timeout 30000`],
});

const http = createHttpClient({
  userAgent: `${NAME}/${VERSION} (+https://github.com/ajaymahato431/django-mcp)`,
  timeoutMs: config.requestTimeoutMs,
  retries: config.retries,
  cacheMax: config.cacheMax,
  defaultTtl: config.docTtlMs,
  negativeTtl: config.negativeTtlMs,
});

/**
 * Loads Django's Sphinx object inventory.
 *
 * One ~110 KB request yields every page, setting, template tag, field lookup,
 * class, method and attribute, each with its page and anchor. It replaces both
 * the recursive table-of-contents crawl the previous version used to list pages
 * and the keyword search it never had.
 */
async function loadInventory() {
  const buffer = await http.fetchBuffer(inventoryUrl(config.docsVersion), {
    ttl: config.indexTtlMs,
  });

  try {
    return parseInventory(buffer);
  } catch (error) {
    throw new Error(
      `Could not read the Django ${config.docsVersion} object inventory: ${error.message}\n` +
        `Check that DJANGO_DOCS_VERSION names a published version, such as 6.0, 5.2 or stable.`
    );
  }
}

async function readPage(path) {
  const raw = await http.fetchText(sourceUrl(config.docsVersion, path), { ttl: config.docTtlMs });
  return cleanText(raw);
}

const server = new McpServer({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const NETWORK_HINT = "Check network access to docs.djangoproject.com, then try again.";

// ─── list_django_docs ────────────────────────────────────────────────────────

server.registerTool(
  "list_django_docs",
  {
    title: "List Django documentation pages",
    description:
      "Browses the Django documentation index. Called with no arguments it returns a " +
      "section summary (~50 tokens) — start here. Pass `section` to list that section's " +
      'pages. Note that `releases` holds hundreds of release-note pages; prefer ' +
      "search_django_docs over listing it.",
    inputSchema: {
      section: z
        .string()
        .optional()
        .describe(
          'Section to list, e.g. "topics", "ref", "howto", "intro", "faq". ' +
            'Use "all" for every page. Omit for the section summary.'
        ),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum pages to return."),
      offset: z.number().int().min(0).optional().describe("Pages to skip, for paging."),
    },
    annotations: READ_ONLY,
  },
  safeHandler(async ({ section, limit, offset = 0 }) => {
    const { entries, version } = await loadInventory();
    const pages = documentPages(entries);

    if (!section) {
      const groups = groupBySection(pages);
      const rows = groups.map((g) => `  ${g.section} — ${g.count} pages`).join("\n");
      return textResult(
        `# Django ${version || config.docsVersion} documentation\n` +
          `${pages.length} pages across ${groups.length} sections.\n\n${rows}\n\n` +
          `Next: call again with a section, or use search_django_docs to find a page or symbol.`
      );
    }

    const wantsAll = String(section).toLowerCase() === "all";
    const selected = wantsAll
      ? pages
      : pages.filter((p) => sectionOf(p.path).toLowerCase() === String(section).toLowerCase());

    if (selected.length === 0) {
      const available = groupBySection(pages)
        .map((g) => g.section)
        .join(", ");
      return errorResult(
        `No section "${section}" in the Django docs.\nAvailable sections: ${available}`
      );
    }

    const page = selected.slice(offset, offset + (limit ?? selected.length));
    const more =
      offset + page.length < selected.length
        ? `\n\nMore available: call again with offset ${offset + page.length}.`
        : "";

    return textResult(
      `# Django ${version || config.docsVersion} — ${wantsAll ? "all pages" : section}\n` +
        `Showing ${page.length} of ${selected.length}\n\n` +
        `${page.map((p) => `${p.path} — ${p.title}`).join("\n")}${more}`
    );
  }, NETWORK_HINT)
);

// ─── search_django_docs ──────────────────────────────────────────────────────

server.registerTool(
  "search_django_docs",
  {
    title: "Search Django documentation and symbols",
    description:
      "Searches Django's object inventory — every page, setting, template tag, template " +
      "filter, field lookup, class, method and attribute, each with the page it lives on. " +
      'Use it to answer "where is X documented?". Filter with `role` to disambiguate, ' +
      'e.g. role "setting" for INSTALLED_APPS or role "fieldlookup" for icontains.',
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe('What to look for, e.g. "ForeignKey", "select_related", "INSTALLED_APPS".'),
      role: z
        .enum(ROLE_FILTERS)
        .optional()
        .describe("Restrict results to one kind of object. Omit to search everything."),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Result count. Default 10."),
    },
    annotations: READ_ONLY,
  },
  safeHandler(async ({ query, role, maxResults }) => {
    const { entries, version } = await loadInventory();
    const results = searchSymbols(entries, query, {
      limit: maxResults ?? config.maxResults,
      role,
    });

    if (results.length === 0) {
      return textResult(
        `Nothing in the Django ${version || config.docsVersion} inventory matched "${query}"` +
          `${role ? ` with role "${role}"` : ""}.\n` +
          `Try a broader term, drop the role filter, or browse with list_django_docs.`
      );
    }

    const rows = results
      .map((entry, i) => {
        const where = entry.anchor ? `${entry.path}#${entry.anchor}` : entry.path;
        return `${i + 1}. **${entry.name}** (${entry.role}) — \`${where}\``;
      })
      .join("\n");

    return textResult(
      `# Search: "${query}"${role ? ` (role: ${role})` : ""}\n${results.length} results:\n\n${rows}\n\n` +
        `Read one with read_django_docs, passing \`symbol\` for the exact section ` +
        `(e.g. { "symbol": "${results[0].name}" }).`
    );
  }, NETWORK_HINT)
);

// ─── read_django_docs ────────────────────────────────────────────────────────

server.registerTool(
  "read_django_docs",
  {
    title: "Read a Django documentation page",
    description:
      "Reads one Django documentation page. Pass `symbol` to jump straight to a setting, " +
      "method or class and return only its section — by far the cheapest way to answer a " +
      "specific question. Otherwise pass `path`, optionally with `section`.",
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe('Page path, e.g. "topics/db/models" or "ref/settings". Required unless `symbol` is given.'),
      symbol: z
        .string()
        .optional()
        .describe(
          'A documented name, e.g. "INSTALLED_APPS", "select_related", "ForeignKey". ' +
            "Resolves to its page and returns just that section."
        ),
      section: z
        .string()
        .optional()
        .describe('Heading to extract, e.g. "Field options". Greatly reduces output size.'),
      outline: z
        .boolean()
        .optional()
        .describe("Return only the page's heading outline, to choose a section cheaply."),
    },
    annotations: READ_ONLY,
  },
  safeHandler(async ({ path, symbol, section, outline }) => {
    if (!path && !symbol) {
      return errorResult(
        'Pass either "path" (e.g. "topics/db/models") or "symbol" (e.g. "INSTALLED_APPS"). ' +
          "Use search_django_docs or list_django_docs to discover both."
      );
    }

    let targetPath = path ? normalizePath(path) : null;
    let targetSection = section;
    let resolved = null;

    if (symbol) {
      const { entries } = await loadInventory();
      resolved = resolveSymbol(entries, symbol);

      if (!resolved) {
        const near = searchSymbols(entries, symbol, { limit: 5 });
        const suggestion = near.length
          ? `\n\nDid you mean:\n${near.map((e) => `  ${e.name} (${e.role})`).join("\n")}`
          : "\n\nUse search_django_docs to find the right name.";
        return errorResult(`No documented symbol named "${symbol}".${suggestion}`);
      }

      targetPath = resolved.path;
      // The heading is the symbol's own short name; the inventory anchor exists
      // for the rendered HTML, which is not what is being parsed here.
      targetSection = section ?? resolved.shortName;
    }

    let content;
    try {
      content = await readPage(targetPath);
    } catch (error) {
      if (error?.status === 404) {
        return errorResult(
          `No such page: ${targetPath}\n` +
            `Use list_django_docs or search_django_docs to find a valid path.`
        );
      }
      throw error;
    }

    const source = pageUrl(config.docsVersion, targetPath, resolved?.anchor ?? "");

    if (outline) {
      return textResult(`# Outline — ${targetPath}\n\n${renderOutline(content)}`);
    }

    if (targetSection) {
      const extracted = extractSection(content, targetSection);
      if (extracted) {
        const header = resolved
          ? `Source: ${source}\n${resolved.name} (${resolved.role})\n\n`
          : `Source: ${source}\n\n`;
        return textResult(header + extracted);
      }

      // Returning the whole page would be the opposite of what was asked; the
      // outline lets the caller retry precisely and cheaply.
      return textResult(
        `Section "${targetSection}" was not found on ${targetPath}. Available headings:\n\n` +
          `${renderOutline(content)}\n\n` +
          `Re-read with one of these, or omit "section" for the full page.`
      );
    }

    return textResult(`Source: ${source}\n\n${content}`);
  }, NETWORK_HINT)
);

// ─── django_best_practices ───────────────────────────────────────────────────

server.registerTool(
  "django_best_practices",
  {
    title: "Django best practices",
    description:
      "Returns curated Django coding guidelines and anti-patterns. Answers instantly with " +
      "no network access. Read this before writing or refactoring Django code.",
    inputSchema: {
      topic: z.enum(ALL_TOPICS).optional().describe("Single topic to return. Omit for all topics."),
    },
    annotations: { ...READ_ONLY, openWorldHint: false },
  },
  safeHandler(async ({ topic }) => textResult(renderBestPractices(topic)))
);

// ─── Start ───────────────────────────────────────────────────────────────────

runMain(async () => {
  await serveStdio(server, { name: NAME, version: VERSION });
});
