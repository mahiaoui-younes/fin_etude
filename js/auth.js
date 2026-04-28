/**
 * EpitopX AI — Authentication Module
 *
 * Security Fix BUG-005 [HIGH]: Auth token is no longer persisted in
 * localStorage (readable by any JS including XSS payloads, persists
 * indefinitely across browser restarts).
 *
 * Token storage strategy:
 *  - Primary:  IIFE closure variable (_token) — fastest access
 *  - Fallback: sessionStorage['_authToken'] — survives same-tab page
 *              navigation but is cleared automatically when the tab closes.
 *              sessionStorage is NOT accessible from other tabs/windows,
 *              is never sent in HTTP requests automatically, and is wiped
 *              on tab close (OWASP-acceptable for SPAs requiring navigation).
 */

var Auth = typeof Auth !== 'undefined' ? Auth : (() => {
  'use strict';

  // ── Private state ────────────────────────────────────────────────────────
  // Seed from sessionStorage so the token survives page navigation.
  let _token = (function () {
    try { return sessionStorage.getItem('_authToken') || null; } catch (_) { return null; }
  })();

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Store the auth token (memory + sessionStorage for same-tab navigation).
   * Also writes a non-sensitive session flag for the route-guard.
   *
   * @param {string} token - Raw token string from the API.
   */
  function setAuthToken(token) {
    if (typeof token === 'string' && token.length > 0) {
      _token = token;
      try { sessionStorage.setItem('_authToken',   token); } catch (_) {}
      try { sessionStorage.setItem('_authSession', '1');   } catch (_) {}
    }
  }

  /**
   * Erase the auth token from memory, sessionStorage, and any legacy
   * localStorage remnants.
   */
  function clearAuthToken() {
    _token = null;
    try { sessionStorage.removeItem('_authToken');   } catch (_) {}
    try { sessionStorage.removeItem('_authSession'); } catch (_) {}
    try { localStorage.removeItem('authToken');      } catch (_) {}
    try { localStorage.removeItem('refreshToken');   } catch (_) {}
  }

  /**
   * Retrieve the current auth token (memory, backed by sessionStorage).
   * Returns null if no authenticated session exists in this tab.
   *
   * @returns {string|null}
   */
  function getAuthToken() {
    return _token;
  }

  /**
   * Returns true if a token is currently held in this tab's session.
   *
   * @returns {boolean}
   */
  function isAuthenticated() {
    if (_token !== null) return true;
    try { return sessionStorage.getItem('_authSession') === '1'; } catch (_) { return false; }
  }

  return { setAuthToken, clearAuthToken, getAuthToken, isAuthenticated };
})();
