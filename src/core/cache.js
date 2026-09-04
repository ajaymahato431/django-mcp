/**
 * LRU cache with TTL, negative caching, and in-flight request de-duplication.
 *
 * Vendored shared module — keep byte-identical across django-mcp, filament-mcp
 * and livewire-mcp so that a fix here is a copy, not a merge.
 */

/** Wraps a cached failure so we can re-throw it without re-hitting the network. */
export class CachedError extends Error {
  constructor(original) {
    super(original.message);
    this.name = "CachedError";
    this.status = original.status;
    this.cached = true;
  }
}

export class DocCache {
  #entries = new Map(); // key -> { value?, error?, expires }
  #inflight = new Map(); // key -> Promise
  #max;

  constructor({ max = 100 } = {}) {
    this.#max = Math.max(1, max);
  }

  get size() {
    return this.#entries.size;
  }

  get inflightCount() {
    return this.#inflight.size;
  }

  /** Returns the entry if present and unexpired, else null. Refreshes LRU order. */
  #live(key) {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.#entries.delete(key);
      return null;
    }
    // Re-insert to move to the end (most recently used).
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  #evictIfFull() {
    while (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  get(key) {
    const entry = this.#live(key);
    if (!entry || entry.error) return null;
    return entry.value;
  }

  set(key, value, ttl) {
    if (!(ttl > 0)) return value;
    this.#evictIfFull();
    this.#entries.set(key, { value, expires: Date.now() + ttl });
    return value;
  }

  /** Negative caching: remember a failure briefly so retries don't hammer upstream. */
  setError(key, error, ttl) {
    if (!(ttl > 0)) return;
    this.#evictIfFull();
    this.#entries.set(key, { error, expires: Date.now() + ttl });
  }

  delete(key) {
    return this.#entries.delete(key);
  }

  clear() {
    this.#entries.clear();
    this.#inflight.clear();
  }

  /**
   * Read-through with de-duplication: concurrent calls for the same key share a
   * single `producer()` invocation instead of each firing its own request.
   */
  async through(key, producer, { ttl, negativeTtl = 0 } = {}) {
    const entry = this.#live(key);
    if (entry) {
      if (entry.error) throw new CachedError(entry.error);
      return entry.value;
    }

    const pending = this.#inflight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const value = await producer();
        this.set(key, value, ttl);
        return value;
      } catch (error) {
        this.setError(key, error, negativeTtl);
        throw error;
      } finally {
        this.#inflight.delete(key);
      }
    })();

    this.#inflight.set(key, promise);
    return promise;
  }
}
