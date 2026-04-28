/**
 * EpitopX AI — Request throttle & concurrency limiter
 *
 * Prevents API abuse by:
 *  - Limiting concurrent outbound requests per host (default: 2)
 *  - Enforcing minimum delay between requests to the same host
 *  - Queuing excess requests instead of dropping them
 *  - Request deduplication (concurrent identical GET requests share one outbound call)
 */

'use strict';

class RequestThrottle {
  /**
   * @param {Object} opts
   * @param {number} [opts.maxConcurrentPerHost=2] - Max parallel requests per external host
   * @param {number} [opts.defaultDelayMs=200]     - Min ms between requests to same host
   * @param {Object} [opts.hostConfig]             - Per-host overrides { hostname: { delay, maxConcurrent } }
   */
  constructor(opts = {}) {
    this.maxConcurrentPerHost = opts.maxConcurrentPerHost || 2;
    this.defaultDelayMs = opts.defaultDelayMs || 200;
    this.hostConfig = opts.hostConfig || {
      'rest.uniprot.org': { delay: 350, maxConcurrent: 3 },
      'eutils.ncbi.nlm.nih.gov': { delay: 350, maxConcurrent: 3 },
      'blast.ncbi.nlm.nih.gov': { delay: 500, maxConcurrent: 2 },
      'alphafold.ebi.ac.uk': { delay: 200, maxConcurrent: 2 },
    };

    // Per-host state
    // Map<hostname, { active: number, lastRequestTime: number, queue: Array<Function> }>
    this._hosts = new Map();

    // Deduplication map for identical GET requests
    // Map<url, Promise>
    this._inflight = new Map();
  }

  /**
   * Get or create host state.
   */
  _getHostState(hostname) {
    if (!this._hosts.has(hostname)) {
      this._hosts.set(hostname, {
        active: 0,
        lastRequestTime: 0,
        queue: [],
      });
    }
    return this._hosts.get(hostname);
  }

  /**
   * Get config for a specific host.
   */
  _getConfig(hostname) {
    return this.hostConfig[hostname] || {
      delay: this.defaultDelayMs,
      maxConcurrent: this.maxConcurrentPerHost,
    };
  }

  /**
   * Execute a request function with throttling.
   * The requestFn should return a Promise.
   *
   * @param {string} hostname - Target host (for per-host limits)
   * @param {Function} requestFn - Async function that performs the actual request
   * @returns {Promise} - Resolves with the request result
   */
  async execute(hostname, requestFn) {
    const state = this._getHostState(hostname);
    const config = this._getConfig(hostname);

    return new Promise((resolve, reject) => {
      const task = async () => {
        state.active++;
        try {
          // Enforce minimum delay between requests
          const now = Date.now();
          const elapsed = now - state.lastRequestTime;
          if (elapsed < config.delay) {
            await new Promise(r => setTimeout(r, config.delay - elapsed));
          }
          state.lastRequestTime = Date.now();

          const result = await requestFn();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          state.active--;
          this._processQueue(hostname);
        }
      };

      if (state.active < config.maxConcurrent) {
        task();
      } else {
        state.queue.push(task);
      }
    });
  }

  /**
   * Execute with deduplication — concurrent identical GET requests share one outbound call.
   * @param {string} url - Full URL (used as dedup key)
   * @param {string} hostname - Target host
   * @param {Function} requestFn - Async function that performs the actual request
   * @returns {Promise}
   */
  async executeDedup(url, hostname, requestFn) {
    // If an identical request is already in-flight, piggyback on it
    if (this._inflight.has(url)) {
      return this._inflight.get(url);
    }

    const promise = this.execute(hostname, requestFn);

    this._inflight.set(url, promise);
    promise.finally(() => {
      this._inflight.delete(url);
    });

    return promise;
  }

  /**
   * Process queued tasks for a host.
   */
  _processQueue(hostname) {
    const state = this._getHostState(hostname);
    const config = this._getConfig(hostname);

    while (state.queue.length > 0 && state.active < config.maxConcurrent) {
      const task = state.queue.shift();
      task();
    }
  }

  /**
   * Get current throttle statistics.
   */
  stats() {
    const result = {};
    for (const [hostname, state] of this._hosts) {
      result[hostname] = {
        active: state.active,
        queued: state.queue.length,
        lastRequestTime: state.lastRequestTime,
      };
    }
    return result;
  }

  /**
   * Get total number of queued requests across all hosts.
   */
  get totalQueued() {
    let total = 0;
    for (const state of this._hosts.values()) {
      total += state.queue.length;
    }
    return total;
  }

  /**
   * Get total number of active requests across all hosts.
   */
  get totalActive() {
    let total = 0;
    for (const state of this._hosts.values()) {
      total += state.active;
    }
    return total;
  }
}

module.exports = { RequestThrottle };
