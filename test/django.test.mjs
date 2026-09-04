/**
 * Unit tests for the reStructuredText to markdown conversion.
 * Offline — safe to run in CI.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { cleanText, normalizePath, sourceUrl, pageUrl, inventoryUrl } from "../src/django.js";
import { extractSection, listSections } from "../src/core/markdown.js";

// ─── headings ────────────────────────────────────────────────────────────────

test("headings follow Django's underline convention, not order of appearance", () => {
  // A page whose first heading uses `-` must still put `-` at level 2. The
  // previous version numbered levels by first appearance, so such a page had its
  // sections promoted to `#`, inverting the hierarchy extraction relies on.
  const md = cleanText(
    ["Section", "-------", "", "Body.", "", "Subsection", "~~~~~~~~~~", "", "More."].join("\n")
  );

  const headings = listSections(md);
  assert.deepEqual(
    headings.map((h) => [h.level, h.title]),
    [
      [2, "Section"],
      [3, "Subsection"],
    ]
  );
});

test("all five conventional underline characters map to stable levels", () => {
  const md = cleanText(
    [
      "Title", "=====", "",
      "Section", "-------", "",
      "Subsection", "~~~~~~~~~~", "",
      "Sub-subsection", "^^^^^^^^^^^^^^", "",
      "Deepest", '"""""""', "",
    ].join("\n")
  );

  assert.deepEqual(
    listSections(md).map((h) => h.level),
    [1, 2, 3, 4, 5]
  );
});

test("an overlined title is recognised", () => {
  const md = cleanText(["=========", "Big Title", "=========", "", "Body."].join("\n"));
  assert.deepEqual(
    listSections(md).map((h) => [h.level, h.title]),
    [[1, "Big Title"]]
  );
});

test("indented text followed by dashes is not treated as a heading", () => {
  const md = cleanText(["Intro", "=====", "", "    indented", "    --------", "", "End."].join("\n"));
  assert.deepEqual(
    listSections(md).map((h) => h.title),
    ["Intro"]
  );
});

// ─── code blocks ─────────────────────────────────────────────────────────────

test("code blocks are fenced and, crucially, closed", () => {
  // reST delimits code blocks by indentation, with no closing marker. Opening a
  // ``` fence without tracking where the block ends leaves it unbalanced, which
  // makes every later heading look like it is inside code — and unfindable.
  const md = cleanText(
    [
      "Title", "=====", "",
      ".. code-block:: python", "",
      "    x = 1", "    y = 2", "",
      "After the block.", "",
      "Later Section", "-------------", "",
      "Findable.",
    ].join("\n")
  );

  const fences = md.match(/^```/gm) ?? [];
  assert.equal(fences.length % 2, 0, `unbalanced fences:\n${md}`);
  assert.match(md, /```python/);

  const titles = listSections(md).map((h) => h.title);
  assert.ok(
    titles.includes("Later Section"),
    `a heading after a code block must remain discoverable, got ${JSON.stringify(titles)}`
  );
});

test("code-block options are skipped and the language is kept", () => {
  const md = cleanText([".. code-block:: python", "   :linenos:", "", "    x = 1", "", "Done."].join("\n"));
  assert.match(md, /```python/);
  assert.ok(!md.includes(":linenos:"));
  assert.match(md, /x = 1/);
});

test("consecutive code blocks each get their own fence pair", () => {
  const md = cleanText(
    [".. code-block:: python", "", "    a = 1", "", ".. code-block:: console", "", "    $ ls", "", "End."].join("\n")
  );
  assert.equal((md.match(/^```/gm) ?? []).length, 4);
});

// ─── directives and roles ────────────────────────────────────────────────────

test("admonitions become blockquotes", () => {
  const md = cleanText([".. note:: Remember this.", "", ".. warning:: Be careful."].join("\n"));
  assert.match(md, /> \*\*NOTE: Remember this\.\*\*/);
  assert.match(md, /> \*\*WARNING: Be careful\.\*\*/);
});

test("version directives are labelled readably", () => {
  const md = cleanText(".. versionadded:: 5.1");
  assert.match(md, /VERSION ADDED: 5\.1/);
});

test("scaffolding directives are dropped but their content is kept", () => {
  const md = cleanText(
    [".. setting:: DEBUG", "", "``DEBUG``", "---------", "", "Default: False."].join("\n")
  );

  assert.ok(!md.includes(".. setting::"));
  assert.match(md, /Default: False\./);
  assert.deepEqual(
    listSections(md).map((h) => h.title),
    ["``DEBUG``"]
  );
});

test("anchor targets are removed", () => {
  const md = cleanText([".. _some-label:", "", "Heading", "=======", "", "Body."].join("\n"));
  assert.ok(!md.includes("_some-label"));
  assert.match(md, /# Heading/);
});

test("interpreted-text roles become inline code", () => {
  assert.match(cleanText(":class:`Model`"), /`Model`/);
  assert.match(cleanText(":setting:`DEBUG`"), /`DEBUG`/);
  // `Title <target>` keeps only the title.
  assert.match(cleanText(":ref:`Template inheritance <template-inheritance>`"), /`Template inheritance`/);
  assert.ok(!cleanText(":ref:`Template inheritance <template-inheritance>`").includes("<"));
});

test("blank line runs are collapsed", () => {
  assert.equal(cleanText("a\n\n\n\n\nb"), "a\n\nb");
});

// ─── section extraction over converted text ──────────────────────────────────

const SETTINGS_PAGE = cleanText(
  [
    "Settings", "========", "",
    "Debugging", "---------", "",
    "General notes about debugging.", "",
    ".. setting:: DEBUG", "",
    "``DEBUG``", "---------", "",
    "A boolean that turns debug mode on or off.", "",
    ".. setting:: DEBUG_PROPAGATE_EXCEPTIONS", "",
    "``DEBUG_PROPAGATE_EXCEPTIONS``", "------------------------------", "",
    "Propagates exceptions.",
  ].join("\n")
);

test("a symbol resolves to its own section, not a similarly named one", () => {
  // "DEBUG" must not match the earlier "Debugging" heading, and the backticks
  // around the real heading must not stop it matching.
  const section = extractSection(SETTINGS_PAGE, "DEBUG");
  assert.match(section, /A boolean that turns debug mode on or off\./);
  assert.ok(!section.includes("General notes about debugging"));
  assert.ok(!section.includes("Propagates exceptions"), "must stop at the next peer heading");
});

test("a longer sibling name does not capture a shorter query", () => {
  const section = extractSection(SETTINGS_PAGE, "DEBUG_PROPAGATE_EXCEPTIONS");
  assert.match(section, /Propagates exceptions\./);
});

test("underscores in identifiers are preserved when matching headings", () => {
  const page = cleanText(
    [
      "QuerySet API", "============", "",
      "``prefetch_related_objects()``", "------------------------------", "",
      "The helper function.", "",
      "``prefetch_related()``", "~~~~~~~~~~~~~~~~~~~~~~", "",
      "The queryset method.",
    ].join("\n")
  );

  const section = extractSection(page, "prefetch_related");
  assert.match(
    section,
    /The queryset method\./,
    "stripping underscores as emphasis would make the exact name unmatchable"
  );
});

// ─── URLs and paths ──────────────────────────────────────────────────────────

test("normalizePath trims slashes and the .txt suffix", () => {
  for (const input of ["/topics/db/models/", "topics/db/models.txt", " topics/db/models "]) {
    assert.equal(normalizePath(input), "topics/db/models");
  }
});

test("URLs are built for the configured version", () => {
  assert.equal(
    sourceUrl("6.0", "topics/db/models"),
    "https://docs.djangoproject.com/en/6.0/_sources/topics/db/models.txt"
  );
  assert.equal(
    pageUrl("5.2", "ref/settings", "std-setting-DEBUG"),
    "https://docs.djangoproject.com/en/5.2/ref/settings/#std-setting-DEBUG"
  );
  assert.equal(pageUrl("6.0", "ref/settings"), "https://docs.djangoproject.com/en/6.0/ref/settings/");
  assert.equal(inventoryUrl("6.0"), "https://docs.djangoproject.com/en/6.0/objects.inv");
});
