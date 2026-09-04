/**
 * Guards against documentation drift: `.env.example` must describe exactly the
 * configuration the code actually reads, with matching defaults.
 *
 * Vendored shared test — keep byte-identical across the three servers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SCHEMA, NAME, VERSION } from "../src/settings.js";
import { parseEnv } from "../src/core/config.js";
import { repoRoot } from "./helpers/client.mjs";

const ROOT = repoRoot(import.meta.url);
const RAW = readFileSync(join(ROOT, ".env.example"), "utf8");
const DOCUMENTED = parseEnv(RAW);
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const envVars = Object.values(SCHEMA)
  .map((spec) => spec.env)
  .filter(Boolean);

test(".env.example documents every configurable environment variable", () => {
  for (const name of envVars) {
    assert.ok(
      name in DOCUMENTED,
      `${name} is read by the code but missing from .env.example`
    );
  }
});

test(".env.example documents nothing the code does not read", () => {
  for (const name of Object.keys(DOCUMENTED)) {
    assert.ok(
      envVars.includes(name),
      `${name} is in .env.example but no longer read by the code`
    );
  }
});

test(".env.example values match the built-in defaults", () => {
  for (const spec of Object.values(SCHEMA)) {
    if (!spec.env || spec.default === undefined) continue;
    assert.equal(
      DOCUMENTED[spec.env],
      String(spec.default),
      `.env.example shows a different default for ${spec.env} than the code uses`
    );
  }
});

test(".env.example names the CLI flag for each variable", () => {
  for (const spec of Object.values(SCHEMA)) {
    if (!spec.env || !spec.flag) continue;
    assert.ok(
      RAW.includes(`--${spec.flag}`),
      `.env.example should mention the --${spec.flag} flag alongside ${spec.env}`
    );
  }
});

test("every configuration entry is documented in code", () => {
  for (const [key, spec] of Object.entries(SCHEMA)) {
    assert.ok(spec.description, `${key} needs a description for --help output`);
    assert.ok(spec.flag || spec.secret, `${key} needs a CLI flag, or must be marked secret`);
    assert.ok(["string", "number", "boolean"].includes(spec.type), `${key} has an unknown type`);
  }
});

test("secrets are environment-only and ship no real value", () => {
  for (const [key, spec] of Object.entries(SCHEMA)) {
    if (!spec.secret) continue;

    // A CLI flag would expose the value to anyone who can list processes.
    assert.ok(!spec.flag, `${key} is a secret and must not have a CLI flag`);
    assert.ok(!spec.default, `${key} is a secret and must not have a baked-in default`);
    assert.equal(
      DOCUMENTED[spec.env],
      "",
      `.env.example must leave ${spec.env} empty rather than showing a value`
    );
  }
});

test("package.json agrees with the server identity", () => {
  assert.equal(PACKAGE.name, NAME, "package name and server name must match");
  assert.equal(PACKAGE.version, VERSION, "package version and server version must match");
});

test("package.json is publishable", () => {
  assert.equal(PACKAGE.license, "MIT");
  assert.ok(PACKAGE.bin?.[NAME], "a bin entry is required for npx usage");
  assert.ok(PACKAGE.files?.includes("src/"), "src/ must be included in the published package");
  assert.ok(PACKAGE.repository?.url, "a repository URL is required");
  assert.match(PACKAGE.engines?.node ?? "", /\d/, "an engines.node range is required");
});

test("the entry point is executable via npx", () => {
  const entry = join(ROOT, PACKAGE.bin[NAME]);
  const source = readFileSync(entry, "utf8");
  const firstLine = source.slice(0, source.indexOf("\n"));

  assert.ok(source.startsWith("#!/usr/bin/env node"), "the bin entry needs a shebang");

  // A CRLF shebang makes Linux and macOS look for an interpreter literally
  // named "node\r", so `npx <package>` fails with "env: node\r: No such file
  // or directory" — while working perfectly on the Windows machine that
  // published it. .gitattributes pins LF; this asserts that it held.
  assert.ok(
    !firstLine.includes("\r"),
    "the shebang must end with LF, not CRLF, or npx breaks on Linux and macOS"
  );
});

test("source files use LF line endings", () => {
  for (const relative of ["index.js", "src/settings.js", "src/core/config.js"]) {
    const source = readFileSync(join(ROOT, relative), "utf8");
    assert.ok(!source.includes("\r\n"), `${relative} contains CRLF line endings`);
  }
});
