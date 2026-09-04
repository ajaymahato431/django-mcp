/**
 * Configuration: zero-dependency `.env` loading, CLI flag parsing, and
 * precedence resolution (CLI flag > environment variable > built-in default).
 *
 * Vendored shared module — keep byte-identical across django-mcp, filament-mcp
 * and livewire-mcp so that a fix here is a copy, not a merge.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Parses `.env` content. Supports `KEY=value`, `export KEY=value`, `#` comments,
 * quoted values, and `\n` escapes inside double quotes.
 */
export function parseEnv(content) {
  const result = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
      value = value.slice(1, -1);
    } else {
      // Strip trailing inline comment on unquoted values.
      value = value.replace(/\s+#.*$/, "").trim();
    }

    result[key] = value;
  }
  return result;
}

/**
 * Loads a `.env` file into `process.env` without overwriting variables that are
 * already set — the MCP client's `env` block must always win over a stray file.
 *
 * A missing `.env` is a no-op, never an error.
 */
export function loadDotenv({ cwd = process.cwd(), packageDir, file } = {}) {
  const candidates = file
    ? [resolve(cwd, file)]
    : [join(cwd, ".env"), packageDir ? join(packageDir, ".env") : null].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = parseEnv(readFileSync(candidate, "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return { loaded: true, path: candidate, keys: Object.keys(parsed) };
    } catch {
      // An unreadable .env must not prevent the server from starting.
    }
  }

  return { loaded: false, path: null, keys: [] };
}

/**
 * Parses `--flag value`, `--flag=value`, and `--boolean-flag` into a plain
 * object keyed by the flag name with dashes preserved.
 *
 * `booleanFlags` names the flags that take no value, so that `--verbose extra`
 * yields `{ verbose: true }` plus the positional `extra` rather than swallowing
 * the next argument as the flag's value.
 */
export function parseFlags(argv = process.argv.slice(2), { booleanFlags = [] } = {}) {
  const booleans = new Set([...booleanFlags, "help", "h", "version", "v"]);
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const body = arg.slice(2);
    if (body === "") continue;

    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }

    if (booleans.has(body)) {
      flags[body] = true;
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }

  return { flags, positionals };
}

function coerce(value, type, key) {
  if (value === undefined || value === null) return undefined;

  if (type === "number") {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid number for ${key}: ${JSON.stringify(value)}`);
    }
    return num;
  }

  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const normalized = String(value).toLowerCase().trim();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off", ""].includes(normalized)) return false;
    throw new Error(`Invalid boolean for ${key}: ${JSON.stringify(value)}`);
  }

  return String(value);
}

/**
 * Resolves a configuration schema.
 *
 * Schema shape: `{ key: { flag, env, type, default, description } }`
 * Precedence:   CLI flag > environment variable > default.
 */
export function resolveConfig(schema, { flags = {}, env = process.env } = {}) {
  const config = {};
  const sources = {};

  for (const [key, spec] of Object.entries(schema)) {
    const type = spec.type ?? "string";

    const fromFlag = spec.flag !== undefined ? flags[spec.flag] : undefined;
    if (fromFlag !== undefined) {
      config[key] = coerce(fromFlag, type, `--${spec.flag}`);
      sources[key] = "flag";
      continue;
    }

    const fromEnv = spec.env !== undefined ? env[spec.env] : undefined;
    if (fromEnv !== undefined && fromEnv !== "") {
      config[key] = coerce(fromEnv, type, spec.env);
      sources[key] = "env";
      continue;
    }

    config[key] = spec.default;
    sources[key] = "default";
  }

  return { config, sources };
}

export function renderHelp({ name, version, description, schema, examples = [] }) {
  // Secrets are environment-only by design: a value passed as a CLI flag is
  // visible to anyone who can list processes.
  const secrets = Object.values(schema).filter((spec) => spec.secret && spec.env);

  const rows = Object.entries(schema)
    .filter(([, spec]) => spec.flag)
    .map(([, spec]) => ({
      left: `  --${spec.flag}${spec.type === "boolean" ? "" : " <value>"}`,
      env: spec.env ? `[env: ${spec.env}]` : "",
      description: spec.description ?? "",
      fallback: spec.default === undefined ? "" : `(default: ${spec.default})`,
    }));

  const width = Math.max(0, ...rows.map((r) => r.left.length)) + 2;

  const lines = [
    `${name} v${version}`,
    "",
    description,
    "",
    "USAGE",
    `  ${name} [options]`,
    "",
    "  Runs as a Model Context Protocol server over stdio. It is normally launched",
    "  by an MCP client rather than invoked by hand.",
    "",
    "OPTIONS",
    ...rows.flatMap((r) => [
      `${r.left.padEnd(width)}${r.description}`,
      `${" ".repeat(width)}${[r.env, r.fallback].filter(Boolean).join(" ")}`.trimEnd(),
    ]),
    `  --env-file <path>`.padEnd(width) + "Load configuration from a specific .env file",
    `  --help`.padEnd(width) + "Show this help and exit",
    `  --version`.padEnd(width) + "Show the version and exit",
  ];

  if (secrets.length > 0) {
    lines.push(
      "",
      "ENVIRONMENT ONLY",
      "  These have no CLI flag, because a flag would expose the value to anyone",
      "  who can list running processes.",
      ...secrets.map((spec) => `  ${spec.env.padEnd(width - 2)}${spec.description ?? ""}`)
    );
  }

  if (examples.length > 0) {
    lines.push("", "EXAMPLES", ...examples.map((e) => `  ${e}`));
  }

  lines.push("", "Precedence: CLI flag > environment variable > default.", "");

  return lines.join("\n");
}

/** Directory of the package that called this, for locating a co-located `.env`. */
export function packageDirFrom(importMetaUrl) {
  return dirname(fileURLToPath(importMetaUrl));
}

/**
 * One-call bootstrap: handle `--help`/`--version`, load `.env`, resolve config.
 * Returns `{ config, sources, flags, env }`.
 */
export function bootstrap({ name, version, description, schema, examples, importMetaUrl }) {
  const booleanFlags = Object.values(schema)
    .filter((spec) => spec.type === "boolean" && spec.flag)
    .map((spec) => spec.flag);

  const { flags } = parseFlags(process.argv.slice(2), { booleanFlags });

  if (flags.help === true || flags.h === true) {
    process.stdout.write(renderHelp({ name, version, description, schema, examples }));
    process.exit(0);
  }

  if (flags.version === true || flags.v === true) {
    process.stdout.write(`${version}\n`);
    process.exit(0);
  }

  const packageDir = importMetaUrl ? packageDirFrom(importMetaUrl) : undefined;
  const env = loadDotenv({
    packageDir,
    file: typeof flags["env-file"] === "string" ? flags["env-file"] : undefined,
  });

  const { config, sources } = resolveConfig(schema, { flags });
  return { config, sources, flags, envFile: env };
}
