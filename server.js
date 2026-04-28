/**
 * EpitopX AI — Local dev server (hardened + optimized)
 * Serves static files AND proxies /api/* to the remote API.
 * Same origin => no CORS issues.
 *
 * Features:
 *  - Response caching for external APIs (UniProt, NCBI)
 *  - Request throttling & concurrency limiting per host
 *  - Tiered rate limiting (general + API-specific)
 *  - Input validation & SSRF mitigation
 *  - Path-traversal protection & security headers
 *  - Structured logging
 *  - Diagnostic /api/_status endpoint
 *
 * Usage:  node server.js
 * Then open http://127.0.0.1:3333
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ── Modules ──────────────────────────────────────────────────────────────
const { ResponseCache }     = require('./lib/cache');
const { RequestThrottle }   = require('./lib/throttle');
const { Logger }            = require('./lib/logger');
const { createProxyHandler } = require('./lib/proxy');
const validator              = require('./lib/validator');

// ── Configuration ────────────────────────────────────────────────────────
const PORT        = process.env.PORT ? Number(process.env.PORT) : 3333;
const REMOTE_API  = process.env.REMOTE_API || 'https://ba84-41-98-249-78.ngrok-free.app';
const EPITOPE_API = process.env.EPITOPE_API || 'https://ba84-41-98-249-78.ngrok-free.app';
const LOG_LEVEL   = process.env.LOG_LEVEL || 'info';

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

// ── Initialize shared services ───────────────────────────────────────────
const log      = new Logger({ level: LOG_LEVEL });
const cache    = new ResponseCache({ maxEntries: 500 });
const throttle = new RequestThrottle();
const { proxyRequest, collectBody } = createProxyHandler({ cache, throttle, log, maxBodySize: MAX_BODY_SIZE });

// Register dynamic backend hosts in validator
try { validator.addAllowedHost(new URL(REMOTE_API).hostname); } catch {}
try { validator.addAllowedHost(new URL(EPITOPE_API).hostname); } catch {}
try { validator.addAllowedHost('a381-41-98-106-109.ngrok-free.app'); } catch {}

// ── Rate limiting (tiered: general + API proxy) ──────────────────────────
const RATE_LIMITS = {
  general:   { windowMs: 60 * 1000, max: 300 },   // 300 req/min total
  apiProxy:  { windowMs: 60 * 1000, max: 150 },    // 150 external-proxy req/min
};
const rateLimitMaps = {
  general:  new Map(),
  apiProxy: new Map(),
};

function checkRateLimit(ip, tier) {
  const config = RATE_LIMITS[tier];
  const map = rateLimitMaps[tier];
  const now = Date.now();
  let entry = map.get(ip);
  if (!entry || now - entry.start > config.windowMs) {
    entry = { start: now, count: 0 };
    map.set(ip, entry);
  }
  entry.count++;
  return entry.count > config.max;
}

// Cleanup stale rate-limit entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [tier, config] of Object.entries(RATE_LIMITS)) {
    const map = rateLimitMaps[tier];
    for (const [ip, entry] of map) {
      if (now - entry.start > config.windowMs) map.delete(ip);
    }
  }
}, 2 * 60 * 1000);

// ── MIME types ───────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.pdb':  'text/plain',
};

// ── Security headers ─────────────────────────────────────────────────────
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

// ── Path traversal guard ─────────────────────────────────────────────────
const DOCUMENT_ROOT = path.resolve(__dirname);

function safePath(requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const resolved = path.resolve(DOCUMENT_ROOT, '.' + decoded);
  if (!resolved.startsWith(DOCUMENT_ROOT + path.sep) && resolved !== DOCUMENT_ROOT) {
    return null;
  }
  return resolved;
}

// ═════════════════════════════════════════════════════════════════════════
// ── HTTP Server ──────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const clientIp = req.socket.remoteAddress || 'unknown';

  // ── General rate limiting ──────────────────────────────────────────────
  if (checkRateLimit(clientIp, 'general')) {
    log.warn('rate-limit', `General limit exceeded for ${clientIp}`);
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: 'Too many requests. Please try again later.' }));
    return;
  }

  setSecurityHeaders(res);

  const parsed = url.parse(req.url);
  const pathname = decodeURIComponent(parsed.pathname);

  // ── Block null bytes ───────────────────────────────────────────────────
  if (pathname.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  // ── CORS preflight ─────────────────────────────────────────────────────
  if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, ngrok-skip-browser-warning',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  // ── Diagnostic endpoint: /api/_status ──────────────────────────────────
  if (pathname === '/api/_status' && req.method === 'GET') {
    const status = {
      uptime: Math.round(process.uptime()),
      cache: cache.stats(),
      throttle: throttle.stats(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ── Proxy routes (with caching, throttling, validation) ────────────────
  // ═══════════════════════════════════════════════════════════════════════

  // ── Proxy /api/uniprot/* → UniProt REST API ────────────────────────────
  if (pathname.startsWith('/api/uniprot/')) {
    // API-specific rate limiting for proxy routes
    if (checkRateLimit(clientIp, 'apiProxy')) {
      log.warn('rate-limit', `API proxy limit exceeded for ${clientIp}`);
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
      res.end(JSON.stringify({ error: 'Too many API requests. Please slow down.' }));
      return;
    }

    const uniprotPath = req.url.replace(/^\/api\/uniprot/, '');
    const check = validator.validateUniProtPath(uniprotPath);
    if (!check.valid) {
      log.warn('validator', `UniProt path rejected: ${check.reason}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: check.reason }));
      return;
    }

    const target = 'https://rest.uniprot.org' + uniprotPath;

    proxyRequest({
      tag: 'uniprot-proxy',
      targetUrl: target,
      method: 'GET',
      headers: {
        'Accept': req.headers['accept'] || 'application/json',
        'User-Agent': 'EpitopX AI/1.0',
      },
      timeout: 30000,
      cacheable: true,  // Cache UniProt GET responses
      res,
    });
    return;
  }

  // ── Proxy /api/epitopes/* → EPITOPE_API ────────────────────────────────
  if (pathname.startsWith('/api/epitopes/')) {
    const target = EPITOPE_API + req.url;

    try {
      const bodyBuffer = await collectBody(req);
      proxyRequest({
        tag: 'epitope-proxy',
        targetUrl: target,
        method: req.method,
        headers: {
          ...req.headers,
          host: new URL(EPITOPE_API).host,
          'content-length': bodyBuffer.length,
          'ngrok-skip-browser-warning': 'true',
        },
        body: bodyBuffer,
        timeout: 60000,
        cacheable: false,  // Epitope analysis results are unique per request
        res,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Proxy /api/ncbi/* → NCBI E-utilities ───────────────────────────────
  if (pathname.startsWith('/api/ncbi/')) {
    if (checkRateLimit(clientIp, 'apiProxy')) {
      log.warn('rate-limit', `API proxy limit exceeded for ${clientIp}`);
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
      res.end(JSON.stringify({ error: 'Too many API requests. Please slow down.' }));
      return;
    }

    const ncbiPath = req.url.replace(/^\/api\/ncbi/, '');
    const check = validator.validateNCBIPath(ncbiPath);
    if (!check.valid) {
      log.warn('validator', `NCBI path rejected: ${check.reason}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: check.reason }));
      return;
    }

    const target = 'https://eutils.ncbi.nlm.nih.gov' + ncbiPath;

    try {
      const bodyBuffer = await collectBody(req);
      proxyRequest({
        tag: 'ncbi-proxy',
        targetUrl: target,
        method: req.method,
        headers: {
          'Accept': req.headers['accept'] || '*/*',
          'User-Agent': 'EpitopX AI/1.0 (bioinformatics research tool)',
          ...(bodyBuffer.length ? {
            'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
            'Content-Length': bodyBuffer.length,
          } : {}),
        },
        body: bodyBuffer.length ? bodyBuffer : undefined,
        timeout: 30000,
        cacheable: req.method === 'GET',  // Cache NCBI GET responses
        res,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Proxy /api/msa/* → MSA Alignment API (ngrok) ──────────────────────
  if (pathname.startsWith('/api/msa/')) {
    const ALIGNMENT_API = process.env.ALIGNMENT_API || 'https://a381-41-98-106-109.ngrok-free.app';
    if (checkRateLimit(clientIp, 'apiProxy')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
      res.end(JSON.stringify({ error: 'Too many API requests. Please slow down.' }));
      return;
    }
    const target = ALIGNMENT_API + req.url;  // forward full path: /api/msa/align/
    try {
      const bodyBuffer = await collectBody(req);
      proxyRequest({
        tag: 'msa-proxy',
        targetUrl: target,
        method: req.method,
        headers: {
          'Content-Type': req.headers['content-type'] || 'application/json',
          'Accept': req.headers['accept'] || 'application/json',
          'User-Agent': 'EpitopX AI/1.0',
          'ngrok-skip-browser-warning': 'true',
          ...(bodyBuffer.length ? { 'Content-Length': bodyBuffer.length } : {}),
        },
        body: bodyBuffer.length ? bodyBuffer : undefined,
        timeout: 120000,
        cacheable: false,
        res,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Proxy /api/alignment/* → MSA Alignment API (legacy alias) ─────────
  if (pathname.startsWith('/api/alignment/')) {
    const ALIGNMENT_API = process.env.ALIGNMENT_API || 'https://a381-41-98-106-109.ngrok-free.app';
    if (checkRateLimit(clientIp, 'apiProxy')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
      res.end(JSON.stringify({ error: 'Too many API requests. Please slow down.' }));
      return;
    }
    const target = ALIGNMENT_API + req.url.replace(/^\/api\/alignment/, '');
    try {
      const bodyBuffer = await collectBody(req);
      proxyRequest({
        tag: 'alignment-proxy',
        targetUrl: target,
        method: req.method,
        headers: {
          'Content-Type': req.headers['content-type'] || 'application/json',
          'Accept': req.headers['accept'] || 'application/json',
          'User-Agent': 'EpitopX AI/1.0',
          'ngrok-skip-browser-warning': 'true',
          ...(bodyBuffer.length ? { 'Content-Length': bodyBuffer.length } : {}),
        },
        body: bodyBuffer.length ? bodyBuffer : undefined,
        timeout: 120000,
        cacheable: false,
        res,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Proxy /api/blast/* → NCBI BLAST ────────────────────────────────────
  if (pathname.startsWith('/api/blast/')) {
    if (checkRateLimit(clientIp, 'apiProxy')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
      res.end(JSON.stringify({ error: 'Too many API requests. Please slow down.' }));
      return;
    }

    const blastPath = req.url.replace(/^\/api\/blast/, '');
    const target = 'https://blast.ncbi.nlm.nih.gov' + blastPath;

    try {
      const bodyBuffer = await collectBody(req);
      proxyRequest({
        tag: 'blast-proxy',
        targetUrl: target,
        method: req.method,
        headers: {
          'Accept': req.headers['accept'] || '*/*',
          'User-Agent': 'EpitopX AI/1.0 (bioinformatics research tool)',
          ...(bodyBuffer.length ? {
            'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
            'Content-Length': bodyBuffer.length,
          } : {}),
        },
        body: bodyBuffer.length ? bodyBuffer : undefined,
        timeout: 120000,
        cacheable: req.method === 'GET',
        res,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Proxy /api/* and /media/* → remote backend ─────────────────────────
  if (pathname.startsWith('/api/') || pathname.startsWith('/media/')) {
    const target = REMOTE_API + req.url;

    try {
      const bodyBuffer = await collectBody(req);
      proxyRequest({
        tag: 'backend-proxy',
        targetUrl: target,
        method: req.method,
        headers: {
          ...req.headers,
          host: new URL(REMOTE_API).host,
          'ngrok-skip-browser-warning': 'true',
          ...(bodyBuffer.length ? { 'content-length': bodyBuffer.length } : {}),
        },
        body: bodyBuffer.length ? bodyBuffer : undefined,
        timeout: 30000,
        cacheable: req.method === 'GET' && pathname.startsWith('/media/'),
        res,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ── Static file server (with path traversal protection) ────────────────
  // ═══════════════════════════════════════════════════════════════════════

  const requestedPath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  const filePath = safePath(requestedPath);

  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const cacheControl = (ext === '.html' || ext === '.js' || ext === '.css')
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=86400';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ── Startup ──────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════

server.listen(PORT, '0.0.0.0', () => {
  log.info('server', `EpitopX AI dev server running at http://0.0.0.0:${PORT}`);
  log.info('server', `API proxy: /api/* → ${REMOTE_API}/api/*`);
  log.info('server', `UniProt proxy: /api/uniprot/* → rest.uniprot.org (cached, throttled)`);
  log.info('server', `NCBI proxy: /api/ncbi/* → eutils.ncbi.nlm.nih.gov (cached, throttled)`);
  log.info('server', `BLAST proxy: /api/blast/* → blast.ncbi.nlm.nih.gov (throttled)`);
  log.info('server', `Alignment proxy: /api/alignment/* → ${process.env.ALIGNMENT_API || 'https://a381-41-98-106-109.ngrok-free.app'}/msa/align/`);
  log.info('server', `Epitope proxy: /api/epitopes/* → ${EPITOPE_API}`);
  log.info('server', `Rate limits: ${RATE_LIMITS.general.max} req/min (general), ${RATE_LIMITS.apiProxy.max} req/min (API proxy)`);
  log.info('server', `Cache: max ${cache.maxEntries} entries | Throttle: 2-3 concurrent/host`);
  log.info('server', `Status endpoint: /api/_status`);

  // Startup health-check
  try {
    const _remoteHost = new URL(REMOTE_API);
    const _checkReq = https.request({
      hostname: _remoteHost.hostname,
      path: '/api/proteins/',
      method: 'HEAD',
      headers: { 'ngrok-skip-browser-warning': 'true' },
      timeout: 6000,
    }, (_res) => {
      if (_res.statusCode >= 500) {
        log.warn('health', `Remote API returned HTTP ${_res.statusCode} — backend may be down`);
      } else {
        log.info('health', `Remote API reachable (HTTP ${_res.statusCode})`);
      }
      _res.resume();
    });
    _checkReq.on('timeout', () => {
      _checkReq.destroy();
      log.warn('health', 'Remote API health-check timed out — update REMOTE_API if using ngrok');
    });
    _checkReq.on('error', (_err) => {
      log.error('health', `Remote API UNREACHABLE: ${_err.message}`);
    });
    _checkReq.end();
  } catch (_) { /* malformed REMOTE_API URL — skip check */ }
});

// ── Graceful shutdown ────────────────────────────────────────────────────
function shutdown() {
  log.info('server', 'Shutting down…');
  cache.destroy();
  server.close(() => process.exit(0));
  // Force exit after 5s if connections are still open
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
