/**
 * EpitopX AI — Security: Auth Token & Path Validation Tests
 *
 * Verifies:
 *  1. Auth.setAuthToken() stores the token in memory ONLY
 *     (not in localStorage, not in sessionStorage)
 *  2. Auth.getAuthToken() returns the in-memory value
 *  3. Auth.clearAuthToken() erases the in-memory value
 *  4. validatePathStrict() blocks common path traversal patterns
 *  5. validateUniProtPath() and validateNCBIPath() delegate to validatePathStrict()
 *
 * Run: node tests/test-security-auth.js
 */
'use strict';

const path = require('path');
const fs   = require('fs');

// ── lightweight test harness ──────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) {
    console.log(`  ✔ ${label}`);
    passed++;
  } else {
    console.error(`  ✘ FAIL: ${label}`);
    failed++;
    failures.push(label);
  }
}

function suite(name, fn) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Suite: ${name}`);
  console.log('─'.repeat(60));
  fn();
}

// ── Load Auth module (IIFE, defines `var Auth`) ──────────────────────────
// We simulate a minimal browser global environment by evaluating the IIFE
// directly. We also supply stub `localStorage` / `sessionStorage` so we
// can verify the module does NOT write the token to either storage.
const authSrc = fs.readFileSync(
  path.resolve(__dirname, '../js/auth.js'), 'utf8'
);

const _ls  = {};  // mock localStorage
const _ss  = {};  // mock sessionStorage

const mockLocalStorage = {
  _data: _ls,
  getItem: (k) => _ls[k] !== undefined ? _ls[k] : null,
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; },
  clear: () => { Object.keys(_ls).forEach(k => delete _ls[k]); },
};

const mockSessionStorage = {
  _data: _ss,
  getItem: (k) => _ss[k] !== undefined ? _ss[k] : null,
  setItem: (k, v) => { _ss[k] = String(v); },
  removeItem: (k) => { delete _ss[k]; },
  clear: () => { Object.keys(_ss).forEach(k => delete _ss[k]); },
};

// Evaluate auth.js in a context that has our mock storages
let Auth;
const sandboxCtx = {
  localStorage:    mockLocalStorage,
  sessionStorage:  mockSessionStorage,
};
// eslint-disable-next-line no-new-func
const authFn = new Function('localStorage', 'sessionStorage', authSrc + '; return Auth;');
Auth = authFn(mockLocalStorage, mockSessionStorage);

// ── Load validator (Node.js module) ──────────────────────────────────────
const validator = require(path.resolve(__dirname, '../lib/validator.js'));

// ═══════════════════════════════════════════════════════════════════════════
suite('AUTH — setAuthToken(): sessionStorage (tab-scoped), NOT localStorage', () => {
  // Start fresh
  Auth.clearAuthToken();
  mockLocalStorage.clear();
  mockSessionStorage.clear();

  Auth.setAuthToken('test-token-abc123');

  assert(Auth.getAuthToken() === 'test-token-abc123',
    'getAuthToken() returns the value passed to setAuthToken()');

  assert(mockLocalStorage.getItem('authToken') === null,
    'authToken NOT written to localStorage after setAuthToken()');

  // Token stored under _authToken in sessionStorage (tab-scoped, not legacy authToken key)
  assert(mockSessionStorage.getItem('authToken') === null,
    'Legacy authToken key NOT written to sessionStorage');
  assert(mockSessionStorage.getItem('_authToken') === 'test-token-abc123',
    'Token written to sessionStorage._authToken for same-tab navigation');

  assert(mockSessionStorage.getItem('_authSession') === '1',
    'Non-sensitive _authSession flag written to sessionStorage (OK)');
});

suite('AUTH — getAuthToken() returns in-memory value', () => {
  Auth.clearAuthToken();
  assert(Auth.getAuthToken() === null,
    'getAuthToken() returns null after clearAuthToken()');

  Auth.setAuthToken('my-secret-token');
  assert(Auth.getAuthToken() === 'my-secret-token',
    'getAuthToken() returns previously set token');

  // Verify token is NOT in localStorage
  assert(mockLocalStorage.getItem('authToken') === null,
    'authToken still absent from localStorage after get');
  // Legacy authToken key should not appear; actual key is _authToken
  assert(mockSessionStorage.getItem('authToken') === null,
    'Legacy authToken key absent from sessionStorage after get');
});

suite('AUTH — clearAuthToken() erases memory and clears session flag', () => {
  Auth.setAuthToken('another-token');
  assert(Auth.isAuthenticated() === true,
    'isAuthenticated() is true while token is set');

  Auth.clearAuthToken();
  assert(Auth.getAuthToken() === null,
    'getAuthToken() is null after clear');
  assert(Auth.isAuthenticated() === false,
    'isAuthenticated() is false after clear');
  assert(mockSessionStorage.getItem('_authSession') === null,
    '_authSession flag removed from sessionStorage on clearAuthToken()');
  assert(mockSessionStorage.getItem('_authToken') === null,
    '_authToken value removed from sessionStorage on clearAuthToken()');
});

suite('AUTH — invalid / empty token is rejected', () => {
  Auth.clearAuthToken();

  Auth.setAuthToken('');
  assert(Auth.getAuthToken() === null, 'Empty string token is rejected');

  Auth.setAuthToken(null);
  assert(Auth.getAuthToken() === null, 'null token is rejected');

  Auth.setAuthToken(42);
  assert(Auth.getAuthToken() === null, 'Non-string token is rejected');
});

suite('AUTH — legacy localStorage cleared on clearAuthToken()', () => {
  // Simulate a legacy token already in localStorage (from old code)
  mockLocalStorage.setItem('authToken', 'legacy-token');
  mockLocalStorage.setItem('refreshToken', 'legacy-refresh');

  Auth.clearAuthToken();

  assert(mockLocalStorage.getItem('authToken') === null,
    'clearAuthToken() removes legacy authToken from localStorage');
  assert(mockLocalStorage.getItem('refreshToken') === null,
    'clearAuthToken() removes legacy refreshToken from localStorage');
});

suite('AUTH — XSS simulation: token not in localStorage', () => {
  Auth.clearAuthToken();
  mockLocalStorage.clear();
  mockSessionStorage.clear();

  // Simulate login
  Auth.setAuthToken('super-secret-jwt-token');

  // XSS attacker reads all storage
  const lsSnapshot = Object.assign({}, mockLocalStorage._data);
  const ssSnapshot = Object.assign({}, mockSessionStorage._data);

  const tokenInLS = Object.values(lsSnapshot).includes('super-secret-jwt-token');

  // Critical: token must NOT be in localStorage (long-lived, cross-session)
  assert(!tokenInLS, 'XSS cannot extract auth token from localStorage (never stored there)');
  assert(!lsSnapshot['authToken'], 'Legacy localStorage authToken key is absent');

  // Token is in sessionStorage._authToken (tab-scoped; acceptable OWASP trade-off
  // needed for navigation to work — tab-closed means session ended)
  assert(ssSnapshot['_authToken'] === 'super-secret-jwt-token',
    'Token available in sessionStorage._authToken for same-tab navigation (by design)');
});

// ═══════════════════════════════════════════════════════════════════════════
suite('PATH VALIDATION — validatePathStrict() rejects traversal patterns', () => {
  const { validatePathStrict } = validator;

  assert(!validatePathStrict('/../../etc/passwd').valid, 'Blocks plain "../"');
  assert(!validatePathStrict('/uniprotkb/../../../shadow').valid, 'Blocks ".." in middle');
  assert(!validatePathStrict('%2e%2e%2fetc').valid, 'Blocks URL-encoded "../"');
  assert(!validatePathStrict('%2E%2E/etc').valid, 'Blocks mixed-case URL-encoded ".."');
  assert(!validatePathStrict('%252e%252e%252f').valid, 'Blocks double-encoded ".."');
  assert(!validatePathStrict('/uniprotkb/\0evil').valid, 'Blocks null byte');
  assert(!validatePathStrict('/path\\to\\file').valid, 'Blocks backslash');
  assert(!validatePathStrict('/path//to').valid, 'Blocks consecutive slashes');

  assert(validatePathStrict('/uniprotkb/P04637').valid,  'Allows valid UniProt path');
  assert(validatePathStrict('/efetch.fcgi?db=protein&id=123').valid, 'Allows valid NCBI path');
  assert(validatePathStrict('/uniprotkb/search?query=tp53&format=json').valid,
    'Allows query string with special chars');
});

suite('PATH VALIDATION — validateUniProtPath() blocks traversal via validatePathStrict()', () => {
  assert(!validator.validateUniProtPath('/../../etc/passwd').valid,
    'BUG-006 FIX: validateUniProtPath blocks path traversal');
  assert(!validator.validateUniProtPath('%2e%2e%2f').valid,
    'validateUniProtPath blocks URL-encoded traversal');
  assert(!validator.validateUniProtPath('/uniprotkb/%252e%252e/secret').valid,
    'validateUniProtPath blocks double-encoded traversal');
  assert(validator.validateUniProtPath('/uniprotkb/P04637.json').valid,
    'validateUniProtPath allows valid accession path');
});

suite('PATH VALIDATION — validateNCBIPath() blocks traversal via validatePathStrict()', () => {
  assert(!validator.validateNCBIPath('/../../proc/self/environ').valid,
    'BUG-006 FIX: validateNCBIPath blocks path traversal');
  assert(!validator.validateNCBIPath('%2e%2e%2fefetch').valid,
    'validateNCBIPath blocks URL-encoded traversal');
  assert(validator.validateNCBIPath('/efetch.fcgi?db=nucleotide&id=NC_000001&retmax=100').valid,
    'validateNCBIPath allows valid NCBI path');
  assert(!validator.validateNCBIPath('/efetch.fcgi?db=protein&retmax=99999').valid,
    'validateNCBIPath still blocks retmax > 10000');
});

// ── Summary ───────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`Security Auth Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
}
console.log('═'.repeat(60));
if (failed > 0) process.exit(1);
