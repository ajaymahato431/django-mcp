/**
 * Server lifecycle: stdio transport wiring, graceful shutdown, and consistent
 * tool-result helpers.
 *
 * Vendored shared module — keep byte-identical across django-mcp, filament-mcp
 * and livewire-mcp so that a fix here is a copy, not a merge.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * stdout carries the JSON-RPC stream, so every diagnostic must go to stderr.
 * Writing logs to stdout corrupts the protocol and hangs the client.
 */
export function log(...args) {
  console.error(...args);
}

export function textResult(text) {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

/** Turns a thrown error into a readable, actionable tool result. */
export function describeError(error, hint) {
  const base =
    error?.status !== undefined
      ? `Upstream returned HTTP ${error.status}.`
      : `Request failed: ${error?.message ?? String(error)}`;
  return hint ? `${base}\n${hint}` : base;
}

/**
 * Wraps a tool handler so an unexpected throw becomes a structured error result
 * rather than an opaque protocol-level failure.
 */
export function safeHandler(handler, hint) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResult(describeError(error, hint));
    }
  };
}

/** Connects the server over stdio and installs signal handlers. */
export async function serveStdio(server, { name, version }) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`${name} v${version} running on stdio`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log(`${name}: received ${signal}, shutting down`);
    try {
      await server.close();
    } catch {
      // Nothing useful to do if the transport is already gone.
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/** Entry-point wrapper: a startup failure must be loud, not a silent rejection. */
export function runMain(main) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
