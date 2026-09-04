/**
 * HTTP client for documentation fetching: timeouts, retry with backoff,
 * a descriptive User-Agent, and cache read-through.
 *
 * Vendored shared module — keep byte-identical across django-mcp, filament-mcp,
 * livewire-mcp, and frontlens-mcp so that a fix here is a copy, not a merge.
 */

import { DocCache } from "./cache.js";

/** Status codes worth retrying: rate limiting and transient upstream failures. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(status, url, body = "") {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Honours `Retry-After`, which may be either a delay in seconds or an HTTP date.
 * Returns null when the header is absent or unparseable.
 */
function retryAfterMs(response) {
  const header = response?.headers?.get?.("retry-after");
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());

  return null;
}

export function createHttpClient({
  userAgent,
  timeoutMs = 15000,
  retries = 2,
  retryBaseMs = 300,
  maxRetryDelayMs = 5000,
  cacheMax = 100,
  defaultTtl = 3 * 60 * 60 * 1000,
  indexTtl = 6 * 60 * 60 * 1000,
  negativeTtl = 60 * 1000,
  headers: baseHeaders = {},
  cache = new DocCache({ max: cacheMax }),
} = {}) {
  async function request(url, { headers = {}, signal } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      let response;
      try {
        response = await fetch(url, {
          headers: { "user-agent": userAgent, accept: "*/*", ...baseHeaders, ...headers },
          // A hung upstream must not hang the tool call forever.
          signal: signal ?? AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        });
      } catch (error) {
        // Network error or timeout. Retry unless the caller aborted us.
        if (signal?.aborted) throw error;
        lastError =
          error?.name === "TimeoutError"
            ? new Error(`Request to ${url} timed out after ${timeoutMs}ms`)
            : error;
        if (attempt === retries) throw lastError;
        await sleep(Math.min(retryBaseMs * 2 ** attempt, maxRetryDelayMs));
        continue;
      }

      if (response.ok) return response;

      const error = new HttpError(response.status, url);
      if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) throw error;

      lastError = error;
      const wait = retryAfterMs(response) ?? Math.min(retryBaseMs * 2 ** attempt, maxRetryDelayMs);
      await sleep(Math.min(wait, maxRetryDelayMs));
    }

    throw lastError ?? new Error(`Request to ${url} failed`);
  }

  /** Cache key is namespaced so a URL fetched as text and as JSON don't collide. */
  const keyFor = (kind, url) => `${kind}:${url}`;

  return {
    cache,
    indexTtl,

    async fetchText(url, { ttl = defaultTtl, headers, signal } = {}) {
      return cache.through(
        keyFor("text", url),
        async () => (await request(url, { headers, signal })).text(),
        { ttl, negativeTtl }
      );
    },

    async fetchJson(url, { ttl = defaultTtl, headers, signal } = {}) {
      return cache.through(
        keyFor("json", url),
        async () => (await request(url, { headers, signal })).json(),
        { ttl, negativeTtl }
      );
    },

    async fetchBuffer(url, { ttl = defaultTtl, headers, signal } = {}) {
      return cache.through(
        keyFor("buf", url),
        async () => Buffer.from(await (await request(url, { headers, signal })).arrayBuffer()),
        { ttl, negativeTtl }
      );
    },

    /** Escape hatch for callers needing the raw Response. Not cached. */
    request,
  };
}
