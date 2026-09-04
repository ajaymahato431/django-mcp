# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] — 2026-09-04

The first public release. The server now reads Django's Sphinx object inventory,
which makes both search and precise symbol lookup possible for the first time.

### Added

- **`search_django_docs` — the server previously had no search at all.** It reads
  Django's published object inventory (`objects.inv`): roughly 8,100 entries
  covering every page, setting, template tag, template filter, field lookup,
  class, method and attribute, each with the page and anchor it lives at. A
  `role` filter narrows results, so `INSTALLED_APPS` can be looked up as a
  setting and `icontains` as a field lookup.
- **`read_django_docs` accepts a `symbol`.** Pass `INSTALLED_APPS`,
  `select_related` or `ForeignKey` and the server resolves it through the
  inventory and returns only that section. Reading `INSTALLED_APPS` this way
  costs about 390 tokens, against roughly 27,000 for the whole settings
  reference — a 69× reduction.
- `read_django_docs` also gains `outline: true`, returning just the page's
  headings so a section can be chosen cheaply. When a requested `section` does
  not exist, the response lists the available headings rather than dumping the
  whole page.
- `list_django_docs` accepts `section`, `limit` and `offset`.
- Full configuration through CLI flags and environment variables, with `.env`
  support and documented precedence: flag > environment > default.
  See [`.env.example`](.env.example).
- `--help` and `--version`.
- `DJANGO_DOCS_VERSION` to serve a version other than 6.0 — useful when your
  project runs 5.2 or 4.2.
- Three more best-practice topics: `forms`, `performance` and `testing`.
- Published to npm with a `bin` entry, so the server runs via
  `npx -y django-mcp` with no absolute paths in your MCP configuration.
- A real test suite: 73 offline unit tests and 25 live integration tests. The
  inventory parser is tested against a genuine `objects.inv` fixture, so the
  binary format itself is covered.
- CI across Node 20/22/24 on Linux, macOS and Windows.
- `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`.

### Fixed

- **Headings no longer come out with an inverted hierarchy.** Levels were
  assigned in order of first appearance, so a page whose first underline was `-`
  had its sections promoted to `#`. Django's documented convention (`=`, `-`,
  `~`, `^`, `"`) is now used, with appearance order kept only as a fallback for
  pages that deviate. Section extraction depends on this hierarchy, so the old
  behaviour caused sections to over- or under-capture.
- **Code blocks no longer swallow the rest of the page.** `.. code-block::` was
  rewritten to an opening ``` fence with no closing fence, because reST delimits
  code by indentation. Everything after the first code block therefore looked
  like it was inside a code block, and its headings became invisible to section
  extraction. Blocks are now tracked by indentation and closed properly — on
  `ref/settings` this took the number of discoverable headings from 127 to 233.
- **Section extraction picks the right heading.** Matching was a plain substring
  test, so `DEBUG` would return the `Debugging` section. Matches are now ranked
  exact, then prefix, then substring, and compared against both the formatted
  heading and its bare form so that ``` `DEBUG` ``` matches `DEBUG`.
- **Requests can no longer hang forever.** Every fetch has a timeout (default 15s)
  and retries transient failures with exponential backoff, honouring `Retry-After`.
- **A failed startup is now reported.** `main()` was never `.catch()`-ed, so any
  startup error surfaced as a silent unhandled rejection.
- Failed fetches are cached briefly, so a missing page is not re-requested on
  every call.
- Concurrent requests for the same URL now share a single upstream fetch.
- Interpreted-text roles such as ``:ref:`Title <target>` `` now keep the title and
  drop the target, instead of leaving the angle brackets in the output.

### Changed

- **Breaking:** `list_django_docs` no longer takes a `path` and no longer walks
  `toctree` directives page by page. It serves the full page list from the
  inventory instead, and with no arguments returns a section summary (~80 tokens).
  Pass `section: "all"` for every page.
- **Breaking:** requires Node.js 20 or later.
- Migrated to the SDK's `McpServer` / `registerTool` API. Tool arguments are now
  validated, and tools are annotated as read-only.
- The brittle `<path>.txt` → `<path>/index.txt` fallback is gone; paths come from
  the inventory and are correct by construction.
- Internals split into `src/core/` (shared with the sibling servers),
  `src/inventory.js` and `src/django.js`.
- A licence was added: `package.json` previously declared none.

## [1.0.0]

- Initial version: `list_django_docs`, `read_django_docs`,
  `django_best_practices`.

[Unreleased]: https://github.com/ajaymahato431/django-mcp/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/ajaymahato431/django-mcp/releases/tag/v2.0.0
[1.0.0]: https://github.com/ajaymahato431/django-mcp/releases/tag/v1.0.0
