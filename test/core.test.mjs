/**
 * Unit tests for the vendored core modules. Offline — safe to run in CI.
 *
 * Vendored shared test — keep byte-identical across the three servers.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DocCache, CachedError } from "../src/core/cache.js";
import { extractSection, listSections, renderOutline, collapseBlankLines } from "../src/core/markdown.js";
import { scoreMatch, searchEntries } from "../src/core/search.js";
import { parseEnv, parseFlags, resolveConfig } from "../src/core/config.js";

// ─── cache ───────────────────────────────────────────────────────────────────

test("cache stores and returns a value within its TTL", () => {
  const cache = new DocCache({ max: 10 });
  cache.set("a", "value", 1000);
  assert.equal(cache.get("a"), "value");
});

test("cache expires entries once the TTL has elapsed", () => {
  const cache = new DocCache({ max: 10 });
  cache.set("a", "value", -1); // Already expired; rejected outright.
  assert.equal(cache.get("a"), null);

  cache.set("b", "value", 1);
  const deadline = Date.now() + 5;
  while (Date.now() < deadline) {
    /* spin briefly so the entry ages past its 1ms TTL */
  }
  assert.equal(cache.get("b"), null);
});

test("cache evicts the least recently used entry when full", () => {
  const cache = new DocCache({ max: 2 });
  cache.set("a", 1, 10_000);
  cache.set("b", 2, 10_000);

  // Touch "a" so "b" becomes the least recently used.
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3, 10_000);

  assert.equal(cache.get("b"), null, "b should have been evicted");
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("cache de-duplicates concurrent requests for the same key", async () => {
  const cache = new DocCache({ max: 10 });
  let calls = 0;

  const producer = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return "result";
  };

  const results = await Promise.all([
    cache.through("k", producer, { ttl: 10_000 }),
    cache.through("k", producer, { ttl: 10_000 }),
    cache.through("k", producer, { ttl: 10_000 }),
  ]);

  assert.deepEqual(results, ["result", "result", "result"]);
  assert.equal(calls, 1, "three concurrent callers should share one upstream call");
});

test("cache remembers failures for the negative TTL instead of refetching", async () => {
  const cache = new DocCache({ max: 10 });
  let calls = 0;

  const failing = async () => {
    calls++;
    throw new Error("upstream is down");
  };

  await assert.rejects(cache.through("k", failing, { ttl: 10_000, negativeTtl: 10_000 }));
  await assert.rejects(
    cache.through("k", failing, { ttl: 10_000, negativeTtl: 10_000 }),
    (error) => error instanceof CachedError
  );

  assert.equal(calls, 1, "the second call should be served from the negative cache");
});

test("cache retries after a failure when negative caching is disabled", async () => {
  const cache = new DocCache({ max: 10 });
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error("nope");
  };

  await assert.rejects(cache.through("k", failing, { ttl: 1000, negativeTtl: 0 }));
  await assert.rejects(cache.through("k", failing, { ttl: 1000, negativeTtl: 0 }));
  assert.equal(calls, 2);
});

// ─── markdown ────────────────────────────────────────────────────────────────

const SAMPLE = `# Page

Intro text.

## Fields in forms

Wrong section — this heading merely *contains* the word "Fields".

## Fields

The exact section.

### Nested

Nested content.

## Authorization

Auth content.
`;

test("extractSection prefers an exact heading over an earlier partial match", () => {
  const section = extractSection(SAMPLE, "Fields");
  assert.match(section, /^## Fields$/m);
  assert.match(section, /The exact section\./);
  assert.doesNotMatch(
    section,
    /Wrong section/,
    "a plain includes() match would have returned 'Fields in forms'"
  );
});

test("extractSection includes nested subsections but stops at the next peer heading", () => {
  const section = extractSection(SAMPLE, "Fields");
  assert.match(section, /### Nested/);
  assert.doesNotMatch(section, /## Authorization/);
});

test("extractSection is case-insensitive and falls back to substring matches", () => {
  assert.match(extractSection(SAMPLE, "authorization"), /Auth content/);
  assert.match(extractSection(SAMPLE, "in forms"), /Wrong section/);
});

test("extractSection returns null when nothing matches", () => {
  assert.equal(extractSection(SAMPLE, "Nonexistent"), null);
});

test("listSections ignores headings inside fenced code blocks", () => {
  const md = ["# Real", "", "```bash", "# not a heading", "```", "", "## Also real"].join("\n");
  assert.deepEqual(
    listSections(md).map((h) => h.title),
    ["Real", "Also real"]
  );
});

test("renderOutline lists available headings", () => {
  const outline = renderOutline(SAMPLE);
  assert.match(outline, /- Page/);
  assert.match(outline, /- Authorization/);
});

test("collapseBlankLines reduces runs of blank lines to one", () => {
  assert.equal(collapseBlankLines("a\n\n\n\n\nb"), "a\n\nb");
});

// ─── search ──────────────────────────────────────────────────────────────────

test("scoreMatch ranks exact titles above prefix, substring and path matches", () => {
  const exact = scoreMatch({ title: "Select", path: "forms/select" }, "select");
  const prefix = scoreMatch({ title: "Select column", path: "tables/columns/select" }, "select");
  const substring = scoreMatch({ title: "Custom select", path: "x/y" }, "select");
  const pathOnly = scoreMatch({ title: "Overview", path: "forms/select/extra" }, "select");

  assert.ok(exact > prefix, "exact should outrank prefix");
  assert.ok(prefix > substring, "prefix should outrank substring");
  assert.ok(substring > pathOnly, "title substring should outrank path-only");
  assert.equal(scoreMatch({ title: "Tables", path: "tables" }, "zzz"), 0);
});

test("scoreMatch gives partial credit for multi-word queries", () => {
  const score = scoreMatch({ title: "Select filters", path: "tables/filters/select" }, "select filter");
  assert.ok(score > 0);
});

test("searchEntries ranks results and honours the limit", () => {
  const entries = [
    { title: "Overview", path: "forms/overview" },
    { title: "Select", path: "forms/select" },
    { title: "Select column", path: "tables/columns/select" },
  ];

  const results = searchEntries(entries, "select", { limit: 2 });
  assert.equal(results.length, 2);
  assert.equal(results[0].path, "forms/select");
});

test("searchEntries breaks score ties with the shorter path", () => {
  const entries = [
    { title: "Select", path: "tables/columns/select/advanced" },
    { title: "Select", path: "forms/select" },
  ];
  assert.equal(searchEntries(entries, "select", { limit: 1 })[0].path, "forms/select");
});

// ─── config ──────────────────────────────────────────────────────────────────

test("parseEnv handles comments, quotes, export and inline comments", () => {
  const parsed = parseEnv(
    [
      "# a comment",
      "",
      "PLAIN=value",
      "export EXPORTED=other",
      'QUOTED="spaced value"',
      "SINGLE='literal'",
      "INLINE=value # trailing comment",
      'ESCAPED="line1\\nline2"',
      "EMPTY=",
    ].join("\n")
  );

  assert.equal(parsed.PLAIN, "value");
  assert.equal(parsed.EXPORTED, "other");
  assert.equal(parsed.QUOTED, "spaced value");
  assert.equal(parsed.SINGLE, "literal");
  assert.equal(parsed.INLINE, "value");
  assert.equal(parsed.ESCAPED, "line1\nline2");
  assert.equal(parsed.EMPTY, "");
});

test("parseFlags understands --flag value, --flag=value and boolean flags", () => {
  const { flags, positionals } = parseFlags(
    ["--timeout", "5000", "--docs-version=4.x", "--verbose", "extra"],
    { booleanFlags: ["verbose"] }
  );

  assert.equal(flags.timeout, "5000");
  assert.equal(flags["docs-version"], "4.x");
  assert.equal(
    flags.verbose,
    true,
    "a declared boolean flag must not swallow the following argument"
  );
  assert.deepEqual(positionals, ["extra"]);
});

test("parseFlags always treats --help and --version as boolean", () => {
  const { flags, positionals } = parseFlags(["--help", "somearg"]);
  assert.equal(flags.help, true);
  assert.deepEqual(positionals, ["somearg"]);
});

const SCHEMA = {
  timeout: { flag: "timeout", env: "REQUEST_TIMEOUT_MS", type: "number", default: 15000 },
  version: { flag: "docs-version", env: "DOCS_VERSION", type: "string", default: "5.x" },
  debug: { flag: "debug", env: "DEBUG_MODE", type: "boolean", default: false },
};

test("config precedence is CLI flag over environment variable over default", () => {
  const fromDefault = resolveConfig(SCHEMA, { flags: {}, env: {} });
  assert.equal(fromDefault.config.timeout, 15000);
  assert.equal(fromDefault.sources.timeout, "default");

  const fromEnv = resolveConfig(SCHEMA, { flags: {}, env: { REQUEST_TIMEOUT_MS: "2000" } });
  assert.equal(fromEnv.config.timeout, 2000);
  assert.equal(fromEnv.sources.timeout, "env");

  const fromFlag = resolveConfig(SCHEMA, {
    flags: { timeout: "3000" },
    env: { REQUEST_TIMEOUT_MS: "2000" },
  });
  assert.equal(fromFlag.config.timeout, 3000, "the CLI flag must win over the environment");
  assert.equal(fromFlag.sources.timeout, "flag");
});

test("config treats an empty environment variable as unset", () => {
  const { config } = resolveConfig(SCHEMA, { flags: {}, env: { DOCS_VERSION: "" } });
  assert.equal(config.version, "5.x");
});

test("config coerces booleans and rejects malformed numbers", () => {
  assert.equal(resolveConfig(SCHEMA, { flags: { debug: true }, env: {} }).config.debug, true);
  assert.equal(resolveConfig(SCHEMA, { flags: {}, env: { DEBUG_MODE: "yes" } }).config.debug, true);
  assert.equal(resolveConfig(SCHEMA, { flags: {}, env: { DEBUG_MODE: "off" } }).config.debug, false);

  assert.throws(
    () => resolveConfig(SCHEMA, { flags: { timeout: "abc" }, env: {} }),
    /Invalid number/
  );
});
