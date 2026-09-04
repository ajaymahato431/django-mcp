/**
 * Unit tests for Sphinx object-inventory parsing and symbol search.
 *
 * The fixture is a genuine `objects.inv` — real zlib bytes and real rows taken
 * from Django 6.0 — so the binary format itself is under test, not a mock of it.
 * Offline: safe to run in CI.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  parseInventory,
  InventoryError,
  documentPages,
  sectionOf,
  groupBySection,
  scoreSymbol,
  searchSymbols,
  resolveSymbol,
  filterByRole,
  ROLE_FILTERS,
} from "../src/inventory.js";
import { repoRoot } from "./helpers/client.mjs";

const ROOT = repoRoot(import.meta.url);
const FIXTURE = readFileSync(join(ROOT, "test", "fixtures", "objects-sample.inv"));
const { project, version, entries } = parseInventory(FIXTURE);

const byName = (name) => entries.find((e) => e.name === name);

// ─── parsing ─────────────────────────────────────────────────────────────────

test("parseInventory reads the plain-text header", () => {
  assert.equal(project, "Django");
  assert.equal(version, "6.0");
});

test("parseInventory decompresses and parses every row", () => {
  assert.equal(entries.length, 12);
});

test("parseInventory splits the domain from the role", () => {
  const fk = byName("django.db.models.ForeignKey");
  assert.equal(fk.domain, "py");
  assert.equal(fk.role, "class");

  const setting = byName("DEBUG");
  assert.equal(setting.domain, "std");
  assert.equal(setting.role, "setting");
});

test("parseInventory expands the $ anchor shorthand to the object name", () => {
  // `ref/settings/#std-setting-$` means the anchor is `std-setting-DEBUG`.
  assert.equal(byName("DEBUG").anchor, "std-setting-DEBUG");
  assert.equal(byName("icontains").anchor, "std-fieldlookup-icontains");
  assert.equal(byName("django.db.models.ForeignKey").anchor, "django.db.models.ForeignKey");
});

test("parseInventory strips the trailing slash from paths", () => {
  assert.equal(byName("DEBUG").path, "ref/settings");
  assert.equal(byName("blocktrans").path, "topics/i18n/translation");
});

test("parseInventory keeps a usable short name for dotted objects", () => {
  assert.equal(byName("django.db.models.ForeignKey").shortName, "ForeignKey");
  assert.equal(
    byName("django.db.models.query.QuerySet.select_related").shortName,
    "select_related"
  );
  assert.equal(byName("DEBUG").shortName, "DEBUG");
});

test("parseInventory uses the display name as the title, or the name when absent", () => {
  assert.equal(byName("topics/db/models").title, "Models");
  assert.equal(byName("DEBUG").title, "DEBUG", "a dispname of - means 'same as the name'");
});

test("parseInventory handles names containing spaces", () => {
  const label = byName("built-in widgets");
  assert.ok(label, "labels and glossary terms may contain spaces");
  assert.equal(label.role, "label");
  assert.equal(label.anchor, "built-in-widgets");
});

test("parseInventory handles an entry with no anchor", () => {
  const page = byName("contents");
  assert.equal(page.anchor, "");
  assert.equal(page.path, "contents");
});

// ─── malformed input ─────────────────────────────────────────────────────────

test("parseInventory rejects a non-Sphinx file", () => {
  assert.throws(
    () => parseInventory(Buffer.from("not an inventory\n\n\n\n")),
    InventoryError
  );
});

test("parseInventory rejects a truncated header", () => {
  assert.throws(() => parseInventory(Buffer.from("# Sphinx inventory version 2\n")), InventoryError);
});

test("parseInventory rejects a corrupt compressed body", () => {
  const header = Buffer.from(
    "# Sphinx inventory version 2\n# Project: Django\n# Version: 6.0\n# zlib\n"
  );
  assert.throws(
    () => parseInventory(Buffer.concat([header, Buffer.from("not zlib data")])),
    InventoryError
  );
});

test("parseInventory rejects a valid but empty inventory", () => {
  const header = Buffer.from(
    "# Sphinx inventory version 2\n# Project: Django\n# Version: 6.0\n# zlib\n"
  );
  assert.throws(
    () => parseInventory(Buffer.concat([header, deflateSync(Buffer.from("\n"))])),
    InventoryError
  );
});

// ─── pages ───────────────────────────────────────────────────────────────────

test("documentPages returns only std:doc entries", () => {
  const pages = documentPages(entries);
  assert.deepEqual(
    pages.map((p) => p.path),
    ["contents", "faq/admin", "ref/settings", "topics/db/models"]
  );
  assert.equal(pages.find((p) => p.path === "faq/admin").title, "FAQ: The admin");
});

test("sectionOf and groupBySection classify pages by their top-level segment", () => {
  assert.equal(sectionOf("topics/db/models"), "topics");
  assert.equal(sectionOf("contents"), "(top-level)");

  const counts = Object.fromEntries(
    groupBySection(documentPages(entries)).map((g) => [g.section, g.count])
  );
  assert.equal(counts.topics, 1);
  assert.equal(counts.ref, 1);
  assert.equal(counts["(top-level)"], 1);
});

// ─── search ──────────────────────────────────────────────────────────────────

test("scoreSymbol treats the short name as equal to an exact match", () => {
  // People search for "ForeignKey", not "django.db.models.ForeignKey".
  const fk = byName("django.db.models.ForeignKey");
  assert.equal(scoreSymbol(fk, "ForeignKey"), 100);
  assert.equal(scoreSymbol(fk, "django.db.models.ForeignKey"), 100);
  assert.equal(scoreSymbol(fk, "zzz"), 0);
});

test("scoreSymbol is case-insensitive", () => {
  assert.equal(scoreSymbol(byName("DEBUG"), "debug"), 100);
});

test("searchSymbols resolves well-known Django names", () => {
  const cases = [
    ["ForeignKey", "class", "ref/models/fields"],
    ["INSTALLED_APPS", "setting", "ref/settings"],
    ["select_related", "method", "ref/models/querysets"],
    ["blocktrans", "templatetag", "topics/i18n/translation"],
    ["icontains", "fieldlookup", "ref/models/querysets"],
  ];

  for (const [query, role, path] of cases) {
    const [top] = searchSymbols(entries, query, { limit: 1 });
    assert.ok(top, `no result for ${query}`);
    assert.equal(top.role, role, `wrong role for ${query}`);
    assert.equal(top.path, path, `wrong page for ${query}`);
  }
});

test("searchSymbols honours the role filter", () => {
  const settings = searchSymbols(entries, "debug", { role: "setting" });
  assert.ok(settings.length > 0);
  assert.ok(settings.every((e) => e.role === "setting"));

  assert.equal(searchSymbols(entries, "ForeignKey", { role: "setting" }).length, 0);
});

test("filterByRole maps friendly aliases onto inventory roles", () => {
  // "class" covers exceptions too; "method" covers plain functions.
  assert.ok(filterByRole(entries, "class").some((e) => e.name.endsWith("ForeignKey")));
  assert.ok(filterByRole(entries, "method").some((e) => e.shortName === "select_related"));
  assert.ok(filterByRole(entries, "page").every((e) => e.role === "doc"));
});

test("every advertised role filter is usable", () => {
  for (const role of ROLE_FILTERS) {
    assert.doesNotThrow(() => filterByRole(entries, role), `role ${role} should be valid`);
  }
});

test("searchSymbols respects the limit and returns nothing for gibberish", () => {
  assert.ok(searchSymbols(entries, "e", { limit: 3 }).length <= 3);
  assert.equal(searchSymbols(entries, "zzzzzznotathing").length, 0);
});

test("resolveSymbol requires a confident match", () => {
  assert.equal(resolveSymbol(entries, "INSTALLED_APPS")?.role, "setting");
  assert.equal(resolveSymbol(entries, "zzzzzznotathing"), null);
});
