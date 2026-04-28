/**
 * EpitopX AI — Unified proxy handler with caching & throttling
 *
 * DRY replacement for the 4 repetitive proxy blocks in server.js.
 * Features:
 *  - Automatic response caching (GET requests only)
 *  - Request throttling per external host
 *  - Configurable timeouts per route
 *  - Proper error handling and logging
 *  - Body collection with size limits
 */

'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

/**
 * Create a proxy handler bound to shared cache, throttle, and logger instances.
 *
 * @param {Object} deps
 * @param {import('./cache').ResponseCache} deps.cache
 * @param {import('./throttle').RequestThrottle} deps.throttle
 * @param {import('./logger').Logger} deps.log
 * @param {number} [deps.maxBodySize=10485760] - Max request body size (10MB default)
 * @returns {Object} Proxy handler functions
 */
function createProxyHandler({ cache, throttle, log, maxBodySize = 10 * 1024 * 1024 }) {

  /**
   * Collect request body with size limit.
   */
  function collectBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let totalSize = 0;
      req.on('data', chunk => {
        totalSize += chunk.length;
        if (totalSize > maxBodySize) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  /**
   * Generic proxy handler — routes request to external API.
   *
   * @param {Object} opts
   * @param {string} opts.tag           - Log tag (e.g. 'uniprot-proxy')
   * @param {string} opts.targetUrl     - Full external URL
   * @param {string} opts.method        - HTTP method
   * @param {Object} opts.headers       - Headers to send
   * @param {Buffer} [opts.body]        - Request body (POST/PUT)
   * @param {number} [opts.timeout=30000] - Request timeout in ms
   * @param {boolean} [opts.cacheable=false] - Whether to cache the response
   * @param {http.ServerResponse} opts.res - Express-like response object
   */
  function proxyRequest(opts) {
    const {
      tag, targetUrl, method, headers, body,
      timeout = 30000, cacheable = false, res
    } = opts;

    // Check cache first (GET only)
    if (cacheable && method === 'GET') {
      const cached = cache.get(targetUrl);
      if (cached) {
        log.cache('HIT', targetUrl);
        const responseHeaders = { ...cached.headers, 'x-cache': 'HIT' };
        responseHeaders['access-control-allow-origin'] = '*';
        if (!res.headersSent) {
          res.writeHead(cached.statusCode, responseHeaders);
        }
        res.end(cached.data);
        return;
      }
      log.cache('MISS', targetUrl);
    }

    const hostname = (() => {
      try { return new URL(targetUrl).hostname; } catch { return 'unknown'; }
    })();

    log.proxy(tag, method, targetUrl);

    // Wrap the actual HTTP request in a throttle call
    const doRequest = () => new Promise((resolve, reject) => {
      const proto = targetUrl.startsWith('https') ? https : http;

      const proxyReq = proto.request(targetUrl, {
        method,
        headers,
        timeout,
      }, (proxyRes) => {
        // Collect response body for caching
        if (cacheable && method === 'GET') {
          const chunks = [];
          proxyRes.on('data', chunk => chunks.push(chunk));
          proxyRes.on('end', () => {
            const responseBody = Buffer.concat(chunks);
            const responseHeaders = { ...proxyRes.headers };
            delete responseHeaders['transfer-encoding'];
            responseHeaders['access-control-allow-origin'] = '*';
            responseHeaders['x-cache'] = 'MISS';

            // Store in cache
            cache.set(targetUrl, responseBody, responseHeaders, proxyRes.statusCode);

            if (!res.headersSent) {
              res.writeHead(proxyRes.statusCode, responseHeaders);
            }
            res.end(responseBody);
            resolve();
          });
          proxyRes.on('error', (err) => {
            log.error(tag, 'response stream error', err.message);
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({ error: `${tag} response error` }));
            resolve();
          });
        } else {
          // Stream response directly (POST, non-cacheable)
          const responseHeaders = { ...proxyRes.headers };
          delete responseHeaders['transfer-encoding'];
          responseHeaders['access-control-allow-origin'] = '*';
          if (!res.headersSent) {
            res.writeHead(proxyRes.statusCode, responseHeaders);
          }
          proxyRes.pipe(res);
          proxyRes.on('end', resolve);
          proxyRes.on('error', () => resolve());
        }
      });

      proxyReq.on('error', (err) => {
        log.error(tag, 'request error', err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: `${tag} error` }));
        resolve(); // resolve, not reject — we already sent an error response
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        log.warn(tag, `timeout after ${timeout}ms`, targetUrl);
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: `${tag} timeout` }));
        resolve();
      });

      if (body && body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });

    // Use deduplication for cacheable GETs, plain throttle otherwise
    if (cacheable && method === 'GET') {
      throttle.executeDedup(targetUrl, hostname, doRequest).catch(err => {
        log.error(tag, 'throttle error', err.message);
        if (!res.headersSent) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Service temporarily unavailable' }));
      });
    } else {
      throttle.execute(hostname, doRequest).catch(err => {
        log.error(tag, 'throttle error', err.message);
        if (!res.headersSent) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Service temporarily unavailable' }));
      });
    }
  }

  return { proxyRequest, collectBody };
}

module.exports = { createProxyHandler };
