/**
 * EpitopX AI — In-memory LRU cache with TTL
 *
 * Caches external API responses to avoid duplicate requests.
 * Features:
 *  - Per-entry TTL (time-to-live) with configurable defaults
 *  - LRU eviction when max entries exceeded
 *  - Separate TTLs per API host (UniProt vs NCBI)
 *  - Cache statistics for monitoring
 *  - Key normalization to avoid near-duplicate entries
 */

'use strict';

class ResponseCache {
  /**
   * @param {Object} opts
   * @param {number} [opts.maxEntries=500]   - Maximum cached entries before LRU eviction
   * @param {number} [opts.defaultTTL=300000] - Default TTL in ms (5 minutes)
   * @param {Object} [opts.hostTTL]          - Per-host TTL overrides { hostname: ms }
   */
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries || 500;
    this.defaultTTL = opts.defaultTTL || 5 * 60 * 1000;
    this.hostTTL = opts.hostTTL || {
      'rest.uniprot.org': 10 * 60 * 1000,        // UniProt: 10 min (data changes rarely)
      'eutils.ncbi.nlm.nih.gov': 10 * 60 * 1000, // NCBI: 10 min
      'blast.ncbi.nlm.nih.gov': 5 * 60 * 1000,   // BLAST: 5 min (results can vary)
      'alphafold.ebi.ac.uk': 30 * 60 * 1000,      // AlphaFold: 30 min (very stable)
    };

    // Map<key, { data, headers, statusCode, createdAt, ttl, size }>
    this._store = new Map();

    // Stats
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;

    // Periodic cleanup every 2 minutes
    // unref() allows Node.js to exit naturally if nothing else is running
    this._cleanupInterval = setInterval(() => this._cleanup(), 2 * 60 * 1000).unref();
  }

  /**
   * Normalize a URL into a stable cache key.
   * Strips volatile headers, sorts query params for consistency.
   */
  _normalizeKey(url) {
    try {
      const parsed = new URL(url);
      // Sort query params for deterministic keys
      const params = new URLSearchParams(parsed.search);
      const sorted = new URLSearchParams([...params.entries()].sort());
      parsed.search = sorted.toString();
      return parsed.toString();
    } catch {
      return url;
    }
  }

  /**
   * Get TTL for a given URL based on its hostname.
   */
  _getTTL(url) {
    try {
      const hostname = new URL(url).hostname;
      return this.hostTTL[hostname] || this.defaultTTL;
    } catch {
      return this.defaultTTL;
    }
  }

  /**
   * Retrieve a cached response. Returns null on miss or expiration.
   * @param {string} url
   * @returns {{ data: Buffer, headers: Object, statusCode: number } | null}
   */
  get(url) {
    const key = this._normalizeKey(url);
    const entry = this._store.get(key);

    if (!entry) {
      this._misses++;
      return null;
    }

    // Check expiration
    if (Date.now() - entry.createdAt > entry.ttl) {
      this._store.delete(key);
      this._misses++;
      return null;
    }

    // Move to end (most recently used) — Map preserves insertion order
    this._store.delete(key);
    this._store.set(key, entry);
    this._hits++;

    return {
      data: entry.data,
      headers: { ...entry.headers },
      statusCode: entry.statusCode,
    };
  }

  /**
   * Store a response in cache.
   * Only caches successful responses (2xx).
   * @param {string} url
   * @param {Buffer} data
   * @param {Object} headers
   * @param {number} statusCode
   */
  set(url, data, headers, statusCode) {
    // Only cache successful GET responses
    if (statusCode < 200 || statusCode >= 300) return;

    const key = this._normalizeKey(url);
    const ttl = this._getTTL(url);
    const size = data ? data.length : 0;

    // Don't cache responses larger than 5MB
    if (size > 5 * 1024 * 1024) return;

    // Evict LRU entries if at capacity
    while (this._store.size >= this.maxEntries) {
      const oldestKey = this._store.keys().next().value;
      this._store.delete(oldestKey);
      this._evictions++;
    }

    // Strip headers that shouldn't be cached
    const cachedHeaders = { ...headers };
    delete cachedHeaders['set-cookie'];
    delete cachedHeaders['transfer-encoding'];
    delete cachedHeaders['connection'];

    this._store.set(key, {
      data,
      headers: cachedHeaders,
      statusCode,
      createdAt: Date.now(),
      ttl,
      size,
    });
  }

  /**
   * Check if a URL has a valid (non-expired) cache entry.
   */
  has(url) {
    const key = this._normalizeKey(url);
    const entry = this._store.get(key);
    if (!entry) return false;
    if (Date.now() - entry.createdAt > entry.ttl) {
      this._store.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Invalidate a specific cached URL.
   */
  invalidate(url) {
    const key = this._normalizeKey(url);
    return this._store.delete(key);
  }

  /**
   * Invalidate all entries matching a URL prefix.
   */
  invalidatePrefix(urlPrefix) {
    let count = 0;
    for (const key of this._store.keys()) {
      if (key.startsWith(urlPrefix)) {
        this._store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear the entire cache.
   */
  clear() {
    this._store.clear();
  }

  /**
   * Remove expired entries.
   */
  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now - entry.createdAt > entry.ttl) {
        this._store.delete(key);
      }
    }
  }

  /**
   * Get cache statistics.
   */
  stats() {
    let totalSize = 0;
    for (const entry of this._store.values()) {
      totalSize += entry.size || 0;
    }
    const total = this._hits + this._misses;
    return {
      entries: this._store.size,
      maxEntries: this.maxEntries,
      totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? Math.round(this._hits / total * 100) : 0,
      evictions: this._evictions,
    };
  }

  /**
   * Shutdown — clear interval.
   */
  destroy() {
    clearInterval(this._cleanupInterval);
    this._store.clear();
  }
}

module.exports = { ResponseCache };
