/**
 * Minimal MCP stdio client for tests: spawns the server, performs the
 * initialize handshake, and exposes typed request helpers.
 *
 * Vendored shared module — keep byte-identical across the three servers.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PROTOCOL_VERSION = "2025-06-18";

export function repoRoot(importMetaUrl) {
  return join(dirname(fileURLToPath(importMetaUrl)), "..");
}

export async function startServer({
  cwd,
  entry = "index.js",
  args = [],
  env = {},
  timeoutMs = 30000,
} = {}) {
  // Inherit PATH and friends, but let a caller genuinely remove a variable by
  // passing it as undefined — needed to prove the server runs without a token.
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }

  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });

  const pending = new Map();
  const stderr = [];
  let nextId = 1;
  let buffer = "";
  let exited = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Not JSON-RPC; ignore rather than fail the whole run.
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  child.on("exit", (code, signal) => {
    exited = { code, signal };
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`Server exited (code ${code}, signal ${signal})`));
    }
    pending.clear();
  });

  function send(method, params) {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      if (exited) {
        reject(new Error(`Server already exited (code ${exited.code})`));
        return;
      }

      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}\nstderr:\n${stderr.join("")}`));
      }, timeoutMs);

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  const initialize = await send("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });

  if (initialize.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initialize.error)}`);
  }
  notify("notifications/initialized");

  return {
    serverInfo: initialize.result?.serverInfo,

    async listTools() {
      const response = await send("tools/list", {});
      if (response.error) throw new Error(JSON.stringify(response.error));
      return response.result.tools;
    },

    /** Returns the raw JSON-RPC response so tests can assert on protocol errors too. */
    async callRaw(name, args = {}) {
      return send("tools/call", { name, arguments: args });
    },

    /** Returns the concatenated text content of a successful tool call. */
    async call(name, args = {}) {
      const response = await send("tools/call", { name, arguments: args });
      if (response.error) {
        throw new Error(`${name} returned a protocol error: ${JSON.stringify(response.error)}`);
      }
      const result = response.result;
      return {
        text: (result.content ?? []).map((c) => c.text ?? "").join("\n"),
        isError: Boolean(result.isError),
      };
    },

    get stderr() {
      return stderr.join("");
    },

    async close() {
      if (exited) return;
      child.stdin.end();
      child.kill();
      await once(child, "exit").catch(() => {});
    },
  };
}
