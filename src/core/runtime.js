/**
 * Server lifecycle: stdio transport wiring, graceful shutdown, and consistent
 * tool-result helpers.
 *
 * Vendored shared module — keep byte-identical across django-mcp, filament-mcp,
 * livewire-mcp, and frontlens-mcp so that a fix here is a copy, not a merge.
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
  let base;
  if (error?.status !== undefined) {
    base = `Upstream returned HTTP ${error.status}.`;
    if (!hint) {
      switch (error.status) {
        case 403:
          hint =
            "Rate-limited or forbidden. When the upstream is GitHub, setting GITHUB_TOKEN raises the anonymous rate limit.";
          break;
        case 404:
          hint = "The requested documentation page was not found. Re-check the path with this server's search tool.";
          break;
        case 408:
        case 504:
          hint = "Request timed out. Try increasing --timeout (default 15000ms).";
          break;
        case 429:
          hint =
            "Rate-limited by upstream. Wait a moment and retry; a GITHUB_TOKEN helps when the upstream is GitHub.";
          break;
      }
    }
  } else if (error?.message?.includes?.("timed out")) {
    base = `Request failed: ${error.message}`;
    if (!hint) hint = "Try increasing --timeout (default 15000ms) or check network connectivity.";
  } else {
    base = `Request failed: ${error?.message ?? String(error)}`;
  }
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
