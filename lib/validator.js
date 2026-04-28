/**
 * EpitopX AI — Input validation & SSRF protection
 *
 * Validates and sanitizes proxy request inputs to prevent:
 *  - SSRF (Server-Side Request Forgery)
 *  - Path traversal in proxy URLs
 *  - Parameter injection
 *  - Oversized/malformed queries
 */

'use strict';

const url = require('url');

// ── Allowed external hosts ──────────────────────────────────────────────────
const ALLOWED_HOSTS = new Set([
  'rest.uniprot.org',
  'eutils.ncbi.nlm.nih.gov',
  'blast.ncbi.nlm.nih.gov',
  'alphafold.ebi.ac.uk',
]);

/**
 * Add a dynamic host (e.g., REMOTE_API, EPITOPE_API) to the allowed set.
 */
function addAllowedHost(hostname) {
  if (hostname && typeof hostname === 'string') {
    ALLOWED_HOSTS.add(hostname);
  }
}

/**
 * Check if a hostname is in the allowed set.
 */
function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.has(hostname);
}

/**
 * Validate a proxy target URL against SSRF attacks.
 * @param {string} targetUrl - Full URL to validate
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateProxyTarget(targetUrl) {
  try {
    // Check raw URL string for path traversal BEFORE URL normalisation removes `..`
    // (new URL() normalises `/../..` to a clean path, defeating the pathname check below)
    if (typeof targetUrl === 'string' &&
        (targetUrl.includes('/../') || targetUrl.includes('/..%') || targetUrl.endsWith('/..'))) {
      return { valid: false, reason: 'Path traversal detected in URL' };
    }

    const parsed = new URL(targetUrl);

    // Only allow HTTPS (or HTTP for local dev)
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      return { valid: false, reason: 'Invalid protocol' };
    }

    // Block internal/private IPs
    const host = parsed.hostname;
    if (_isPrivateHost(host)) {
      return { valid: false, reason: 'Private/internal host not allowed' };
    }

    // Check against allowed hosts
    if (!ALLOWED_HOSTS.has(host)) {
      return { valid: false, reason: `Host ${host} not in allowed list` };
    }

    // Block suspicious path patterns (catches any `..` not removed by normalisation)
    if (parsed.pathname.includes('..') || parsed.pathname.includes('//')) {
      return { valid: false, reason: 'Suspicious path pattern' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Malformed URL' };
  }
}

/**
 * Check if a hostname points to a private/internal network.
 */
function _isPrivateHost(host) {
  // Block localhost variants
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') {
    return true;
  }
  // Block private IP ranges
  const parts = host.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    const a = parseInt(parts[0]);
    const b = parseInt(parts[1]);
    if (a === 10) return true;                           // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
    if (a === 192 && b === 168) return true;              // 192.168.0.0/16
    if (a === 169 && b === 254) return true;              // 169.254.0.0/16 (link-local)
  }
  return false;
}

/**
 * Strict path traversal check — applied to all proxy paths.
 * Catches plain `..`, URL-encoded `%2e%2e`, double-encoded `%252e`,
 * backslashes, null bytes and sequential slashes.
 *
 * @param {string} path
 * @returns {{ valid: boolean, reason?: string }}
 */
function validatePathStrict(path) {
  if (!path || typeof path !== 'string') return { valid: false, reason: 'Empty path' };

  // Decode once to catch %2e%2e → ..
  let decoded;
  try { decoded = decodeURIComponent(path); } catch (_) {
    return { valid: false, reason: 'Invalid percent-encoding in path' };
  }

  const variants = [path, decoded];

  for (const v of variants) {
    if (v.includes('..'))                         return { valid: false, reason: 'Path traversal detected (..)' };
    if (v.includes('\0'))                         return { valid: false, reason: 'Null byte in path' };
    if (v.includes('\\'))                         return { valid: false, reason: 'Backslash in path' };
    if (/\/\//.test(v))                           return { valid: false, reason: 'Consecutive slashes in path' };
  }

  // Catch double-encoded sequences: %25 followed by 2e (i.e. %252e)
  if (/%25/i.test(path)) return { valid: false, reason: 'Double-encoded path detected' };

  return { valid: true };
}

/**
 * Validate UniProt proxy path — prevent parameter injection.
 * @param {string} proxyPath - The path after /api/uniprot/
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateUniProtPath(proxyPath) {
  if (!proxyPath || typeof proxyPath !== 'string') {
    return { valid: false, reason: 'Empty path' };
  }

  // Strict traversal check first (BUG-006 fix)
  const strict = validatePathStrict(proxyPath);
  if (!strict.valid) return strict;

  // Max URL length to prevent abuse
  if (proxyPath.length > 4096) {
    return { valid: false, reason: 'Path too long (max 4096 chars)' };
  }

  // Block null bytes
  if (proxyPath.includes('\0')) {
    return { valid: false, reason: 'Null byte in path' };
  }

  return { valid: true };
}

/**
 * Validate NCBI proxy path.
 */
function validateNCBIPath(proxyPath) {
  if (!proxyPath || typeof proxyPath !== 'string') {
    return { valid: false, reason: 'Empty path' };
  }

  // Strict traversal check first (BUG-006 fix)
  const strict = validatePathStrict(proxyPath);
  if (!strict.valid) return strict;

  if (proxyPath.length > 8192) {
    return { valid: false, reason: 'Path too long (max 8192 chars)' };
  }

  // NCBI retmax sanity check — extract from query string
  try {
    const qs = proxyPath.includes('?') ? proxyPath.split('?')[1] : '';
    const params = new URLSearchParams(qs);
    const retmax = params.get('retmax');
    if (retmax && parseInt(retmax) > 10000) {
      return { valid: false, reason: 'retmax too large (max 10000)' };
    }
  } catch {
    // ignore parse errors
  }

  return { valid: true };
}

/**
 * Sanitize a search query string.
 * Strips dangerous characters while preserving biological search syntax.
 */
function sanitizeQuery(query) {
  if (!query || typeof query !== 'string') return '';
  // Remove control characters but preserve biological notation
  return query.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

module.exports = {
  addAllowedHost,
  isAllowedHost,
  validateProxyTarget,
  validatePathStrict,
  validateUniProtPath,
  validateNCBIPath,
  sanitizeQuery,
};
