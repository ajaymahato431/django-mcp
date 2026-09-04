/**
 * End-to-end tests: spawns the real server and talks JSON-RPC over stdio
 * against the live Django documentation.
 *
 * Network-dependent, so excluded from `npm test`. Run with `npm run test:integration`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { startServer, repoRoot } from "./helpers/client.mjs";

const ROOT = repoRoot(import.meta.url);

async function withServer(fn, options = {}) {
  const client = await startServer({ cwd: ROOT, ...options });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("server initializes and reports its identity", async () => {
  await withServer(async (client) => {
    assert.equal(client.serverInfo.name, "django-mcp");
    assert.equal(client.serverInfo.version, "2.0.0");
  });
});

test("all four tools are advertised, including the new search tool", async () => {
  await withServer(async (client) => {
    const tools = await client.listTools();

    // v1 shipped no search tool at all: browsing was the only way to find anything.
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "django_best_practices",
      "list_django_docs",
      "read_django_docs",
      "search_django_docs",
    ]);

    for (const tool of tools) {
      assert.ok(tool.description, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema?.type, "object");
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
  });
});

// ─── listing ─────────────────────────────────────────────────────────────────

test("the default listing is a compact section summary", async () => {
  await withServer(async (client) => {
    const { text, isError } = await client.call("list_django_docs");

    assert.equal(isError, false);
    assert.ok(text.length < 1200, `expected a compact summary, got ${text.length} chars`);
    assert.match(text, /topics — \d+ pages/);
    assert.match(text, /ref — \d+ pages/);
    assert.match(text, /howto — \d+ pages/);
  });
});

test("the page list comes from the inventory and covers the whole documentation", async () => {
  await withServer(async (client) => {
    const { text } = await client.call("list_django_docs");
    const total = Number(text.match(/^(\d+) pages across/m)?.[1]);

    // v1 could only see the nine entries in the root toctree without crawling.
    assert.ok(Number.isFinite(total));
    assert.ok(total > 400, `expected the full page set, got ${total}`);
  });
});

test("a section listing returns real page paths", async () => {
  await withServer(async (client) => {
    const { text, isError } = await client.call("list_django_docs", { section: "topics" });

    assert.equal(isError, false);
    const paths = [...text.matchAll(/^(\S+) — /gm)].map((m) => m[1]);
    assert.ok(paths.length > 10);
    assert.ok(paths.every((p) => p.startsWith("topics/")));
    assert.ok(paths.includes("topics/db/models"));
  });
});

test("paging works", async () => {
  await withServer(async (client) => {
    const first = await client.call("list_django_docs", { section: "ref", limit: 5 });
    assert.match(first.text, /Showing 5 of \d+/);
    assert.match(first.text, /offset 5/);

    const second = await client.call("list_django_docs", { section: "ref", limit: 5, offset: 5 });
    assert.notEqual(first.text, second.text);
  });
});

test("an unknown section reports the available ones", async () => {
  await withServer(async (client) => {
    const { text, isError } = await client.call("list_django_docs", { section: "nonsense" });
    assert.equal(isError, true);
    assert.match(text, /Available sections/);
  });
});

// ─── search: the capability v1 lacked entirely ───────────────────────────────

test("search resolves classes, settings, methods, tags and lookups", async () => {
  await withServer(async (client) => {
    const cases = [
      ["ForeignKey", "ref/models/fields"],
      ["INSTALLED_APPS", "ref/settings"],
      ["select_related", "ref/models/querysets"],
      ["blocktrans", "topics/i18n/translation"],
      ["icontains", "ref/models/querysets"],
    ];

    for (const [query, expectedPath] of cases) {
      const { text, isError } = await client.call("search_django_docs", { query, maxResults: 3 });
      assert.equal(isError, false, `search failed for ${query}`);
      assert.ok(
        text.includes(expectedPath),
        `"${query}" should point at ${expectedPath}, got:\n${text}`
      );
    }
  });
});

test("the role filter narrows results to one kind of object", async () => {
  await withServer(async (client) => {
    const { text } = await client.call("search_django_docs", {
      query: "debug",
      role: "setting",
      maxResults: 5,
    });

    assert.match(text, /role: setting/);
    assert.match(text, /DEBUG/);
    for (const line of text.split("\n").filter((l) => /^\d+\. /.test(l))) {
      assert.match(line, /\(setting\)/, `non-setting result leaked through: ${line}`);
    }
  });
});

test("search is cheap and points at the next call", async () => {
  await withServer(async (client) => {
    const { text } = await client.call("search_django_docs", { query: "ForeignKey", maxResults: 5 });
    assert.ok(text.length < 2000, `search results should stay small, got ${text.length}`);
    assert.match(text, /read_django_docs/);
  });
});

test("a hopeless query says so instead of returning noise", async () => {
  await withServer(async (client) => {
    const { text } = await client.call("search_django_docs", { query: "zzzzzznotathing" });
    assert.match(text, /Nothing in the Django .* matched/);
  });
});

// ─── reading ─────────────────────────────────────────────────────────────────

test("read_django_docs returns converted markdown", async () => {
  await withServer(async (client) => {
    const { text, isError } = await client.call("read_django_docs", { path: "topics/db/models" });

    assert.equal(isError, false);
    assert.match(text, /^Source: https:\/\/docs\.djangoproject\.com/m);
    assert.match(text, /^#+ /m, "reST underlines should have become ATX headings");
    assert.ok(!text.includes(".. code-block::"), "directives should be converted");
    assert.ok(!/^\.\. _/m.test(text), "anchor targets should be removed");

    const fences = text.match(/^```/gm) ?? [];
    assert.equal(fences.length % 2, 0, "code fences must be balanced");
  });
});

test("symbol lookup returns just that symbol's section", async () => {
  await withServer(async (client) => {
    const full = await client.call("read_django_docs", { path: "ref/settings" });
    const symbol = await client.call("read_django_docs", { symbol: "INSTALLED_APPS" });

    assert.equal(symbol.isError, false, symbol.text);
    assert.match(symbol.text, /INSTALLED_APPS/);
    assert.match(symbol.text, /\(setting\)/, "the resolved role should be reported");
    assert.match(symbol.text, /#std-setting-INSTALLED_APPS/, "the anchor should be linked");

    assert.ok(
      symbol.text.length < full.text.length / 10,
      `a single setting (${symbol.text.length}) should be far smaller than ` +
        `the whole settings reference (${full.text.length})`
    );
  });
});

test("symbol lookup works for a method on a large page", async () => {
  await withServer(async (client) => {
    const { text, isError } = await client.call("read_django_docs", { symbol: "select_related" });

    assert.equal(isError, false, text);
    assert.match(text, /select_related/);
    assert.match(text, /\(method\)/);
    assert.ok(text.length < 20000, `expected one section, got ${text.length} chars`);
  });
});

test("symbol lookup does not confuse a prefix for the real name", async () => {
  await withServer(async (client) => {
    // "DEBUG" must not resolve into the "Debugging" section.
    const { text } = await client.call("read_django_docs", { symbol: "DEBUG" });
    assert.match(text, /#std-setting-DEBUG/);
    assert.match(text, /boolean/i);
  });
});

test("an unknown symbol suggests alternatives", async () => {
  await withServer(async (client) => {
    const { text, isError } = await client.call("read_django_docs", { symbol: "zzzzzznotathing" });
    assert.equal(isError, true);
    assert.match(text, /No documented symbol/);
  });
});

test("outline mode is cheap and lists headings", async () => {
  await withServer(async (client) => {
    const full = await client.call("read_django_docs", { path: "topics/db/models" });
    const { text, isError } = await client.call("read_django_docs", {
      path: "topics/db/models",
      outline: true,
    });

    assert.equal(isError, false);
    assert.match(text, /# Outline/);
    assert.ok(text.length < full.text.length / 5);
  });
});

test("a missing section returns the outline rather than the whole page", async () => {
  await withServer(async (client) => {
    const full = await client.call("read_django_docs", { path: "topics/db/models" });
    const { text } = await client.call("read_django_docs", {
      path: "topics/db/models",
      section: "This Heading Does Not Exist",
    });

    assert.match(text, /was not found/);
    assert.match(text, /Available headings/);
    assert.ok(text.length < full.text.length);
  });
});

test("an unknown page path returns a helpful error", async () => {
  await withServer(async (client) => {
    const { text, isError } = await client.call("read_django_docs", { path: "does/not/exist" });
    assert.equal(isError, true);
    assert.match(text, /search_django_docs|list_django_docs/);
  });
});

test("calling read with neither path nor symbol explains what is needed", async () => {
  await withServer(async (client) => {
    const { text, isError } = await client.call("read_django_docs", {});
    assert.equal(isError, true);
    assert.match(text, /path.*symbol|symbol.*path/s);
  });
});

// ─── best practices ──────────────────────────────────────────────────────────

test("best practices answers offline and honours the topic filter", async () => {
  await withServer(async (client) => {
    const all = await client.call("django_best_practices");
    assert.match(all.text, /Security/);

    const one = await client.call("django_best_practices", { topic: "security" });
    assert.match(one.text, /Best Practices — security/);
    assert.ok(one.text.length < all.text.length);
  });
});

// ─── configuration ───────────────────────────────────────────────────────────

test("another Django version can be served", async () => {
  await withServer(
    async (client) => {
      const { text, isError } = await client.call("list_django_docs");
      assert.equal(isError, false, text);
      assert.match(text, /Django 5\.2 documentation/);
    },
    { env: { DJANGO_DOCS_VERSION: "5.2" } }
  );
});

test("a CLI flag overrides the environment", async () => {
  await withServer(
    async (client) => {
      const { text } = await client.call("list_django_docs");
      assert.match(text, /Django 5\.2 documentation/);
    },
    { args: ["--docs-version", "5.2"], env: { DJANGO_DOCS_VERSION: "6.0" } }
  );
});

test("an invalid docs version fails with an actionable message", async () => {
  await withServer(
    async (client) => {
      const { text, isError } = await client.call("list_django_docs");
      assert.equal(isError, true);
      assert.match(text, /DJANGO_DOCS_VERSION|HTTP 404/);
    },
    { env: { DJANGO_DOCS_VERSION: "99.9" } }
  );
});

test("invalid arguments are rejected by schema validation", async () => {
  await withServer(async (client) => {
    const response = await client.callRaw("search_django_docs", { query: "x", role: "bogus-role" });
    const failed = Boolean(response.error) || response.result?.isError === true;
    assert.ok(failed, "an undeclared role value must be rejected");
  });
});
