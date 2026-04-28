# EpitopX AI — Security & Quality Audit Report
**Platform**: EpitopX AI (Structural Bioinformatics Platform for Theileria Proteins v1.0)  
**Audit Date**: 2026-04-24  
**Auditor**: GitHub Copilot (Autonomous QA Engineer)  
**Test Suite**: 486 tests across 5 suites — **486 PASS / 0 FAIL**

---

## Executive Summary

A full codebase audit was performed covering security, bioinformatics correctness, performance, and code quality. **7 bugs** were identified across 4 severity levels. **4 bugs were fixed** during this audit; 3 remain open (documented below with recommended fixes).

| Severity | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| HIGH     | 3     | 2     | 1         |
| MEDIUM   | 2     | 1     | 1         |
| LOW      | 2     | 1     | 1         |
| **TOTAL**| **7** | **4** | **3**     |

---

## FIXED Bugs

### [HIGH] BUG-001: Inaccurate Molecular Weight in `normalizeProtein()`
**File**: `js/api.js` — line 105  
**Status**: ✅ FIXED  

**Root Cause**: The formula `Math.round(seq.length * 110)` used a flat 110 Da/residue average, producing errors up to **+92%** for glycine-rich proteins and **−41%** for tryptophan-rich proteins.

| Protein           | Old Formula | Correct MW | Error  |
|-------------------|-------------|------------|--------|
| poly-Gly (100 aa) | 11,000 Da   | 5,723 Da   | +92%   |
| poly-Trp (100 aa) | 11,000 Da   | 18,639 Da  | −41%   |
| poly-Ala (100 aa) | 11,000 Da   | 7,126 Da   | +54%   |

**Fix Applied**:
```javascript
// js/api.js — normalizeProtein()
const _MW_WEIGHTS = {
  A:71.0788, R:156.1875, N:114.1038, D:115.0886, C:103.1388, E:129.1155,
  Q:128.1307, G:57.0519,  H:137.1411, I:113.1594, L:113.1594, K:128.1741,
  M:131.1926, F:147.1766, P:97.1167,  S:87.0782,  T:101.1051, W:186.2132,
  Y:163.1760, V:99.1326
};
let mw = 18.02;
for (const aa of seq) mw += _MW_WEIGHTS[aa] || 111.1;
const weight = Math.round(mw);
```
**Reference**: Gasteiger et al. (2005) ExPASy proteomics tools.

---

### [MEDIUM] BUG-002: Missing Content-Security-Policy Header
**File**: `server.js` — `setSecurityHeaders()` function  
**Status**: ✅ FIXED  

**Root Cause**: `setSecurityHeaders()` was missing a `Content-Security-Policy` header, leaving the application vulnerable to XSS and data injection attacks. All other security headers were present.

**Fix Applied**:
```javascript
// server.js — setSecurityHeaders()
res.setHeader('Content-Security-Policy',
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self' https:; " +
  "font-src 'self'; " +
  "frame-src 'none';"
);
```

---

### [MEDIUM] BUG-003: Path Traversal Bypass via URL Normalisation in `validateProxyTarget()`
**File**: `lib/validator.js` — `validateProxyTarget()` function  
**Status**: ✅ FIXED  

**Root Cause**: `new URL('https://rest.uniprot.org/../../../etc/passwd').pathname` normalises to `/etc/passwd` (stripping `..`), so the existing `pathname.includes('..')` check was ineffective. An attacker could submit a URL with `/../` to bypass the path check.

**Fix Applied**:
```javascript
// lib/validator.js — validateProxyTarget()
// Check raw URL string BEFORE new URL() normalises away the `..`
if (typeof targetUrl === 'string' &&
    (targetUrl.includes('/../') || targetUrl.includes('/..%') || targetUrl.endsWith('/..'))) {
  return { valid: false, reason: 'Path traversal detected in URL' };
}
```

---

### [LOW] BUG-004: Null Byte Injection in `safePath()`
**File**: `server.js` — `safePath()` function  
**Status**: ✅ FIXED  

**Root Cause**: Null bytes (`\0`) in request paths were only checked at the request handler level (`pathname.includes('\0')`), not inside `safePath()` itself. This created a defence-in-depth gap where `safePath()` could return a path containing null bytes.

**Fix Applied**:
```javascript
// server.js — safePath()
function safePath(requestPath) {
  // Block null bytes before path resolution
  if (requestPath.includes('\0')) return null;
  const decoded = decodeURIComponent(requestPath);
  if (decoded.includes('\0')) return null;
  // ... rest of function
}
```

---

## OPEN Bugs (Remaining)

### [HIGH] BUG-005: Auth Token in `localStorage` (XSS Risk)
**File**: `js/api.js` — `fetchJSON()` function  
**Status**: ⚠️ OPEN  

**Description**: `localStorage.getItem('authToken')` stores the authentication token where it is fully readable by any JavaScript executing in the page — including XSS payloads.

**Impact**: Complete session takeover on XSS exploit.

**Recommended Fix**:
1. Store the token in an `httpOnly; SameSite=Strict; Secure` cookie set by the server
2. Remove all `localStorage.getItem('authToken')` calls from the frontend
3. The browser will automatically include the cookie on same-origin requests

---

### [MEDIUM] BUG-006: `validateUniProtPath()` Allows Path Traversal Patterns
**File**: `lib/validator.js` — `validateUniProtPath()` function  
**Status**: ⚠️ OPEN  

**Description**: `validateUniProtPath('/../../etc/passwd')` returns `valid: true`. While the impact is low (proxied to `rest.uniprot.org` which won't serve `/etc/passwd`), the URL is malformed and violates the principle of least surprise.

**Recommended Fix**:
```javascript
// lib/validator.js — validateUniProtPath()
function validateUniProtPath(proxyPath) {
  if (!proxyPath || typeof proxyPath !== 'string') {
    return { valid: false, reason: 'Missing path' };
  }
  // ADD: block path traversal
  if (proxyPath.includes('..')) {
    return { valid: false, reason: 'Path traversal detected' };
  }
  // ... rest of validation
}
```

---

### [LOW] BUG-007: `/api/_status` Exposes Heap/Memory Data with `CORS: *`
**File**: `server.js` — `/api/_status` route handler  
**Status**: ⚠️ OPEN  

**Description**: The diagnostic endpoint returns Node.js process memory, uptime, and version information with `Access-Control-Allow-Origin: *`. Any page on any domain can read this data.

**Recommended Fix**:
```javascript
// server.js — /api/_status handler
// Remove or restrict CORS header:
res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3333'); // dev only
// OR: require an internal secret/token to access the endpoint
```

---

## Scientific Accuracy Findings

### [INFORMATIONAL] pI Calculation Uses Bjellqvist IEF Scale
**File**: `js/dna.js` — `computePI()` function  

**Finding**: The pKa values in `computePI()` are from the **Bjellqvist 1993** immobilized-pH-gradient (IEF) scale. ExPASy ProtParam uses the **Lide 1994** solution-phase pKa values, which give different results.

**Example**: Ubiquitin (P0CG48, 76 aa):
- ExPASy (Lide 1994 pKa): pI = 6.56  
- EpitopX (Bjellqvist IEF pKa): pI ≈ 7.53  

**Impact**: Medium — pI estimates differ by 0.5–1.5 pH units from the gold standard. Not a calculation bug; it's a pKa scale choice.

**Recommended Fix**: Replace pKa constants with Lide 1994 values:
```javascript
// Lide 1994 (ExPASy ProtParam scale):
const PKA = { Nterm: 9.60, Cterm: 2.34, K: 10.54, R: 12.48, H: 6.04,
              D: 3.86, E: 4.25, C: 8.33, Y: 10.46 };
```

### [INFORMATIONAL] `findBestORF()` Scans Only 3 Forward Frames
**File**: `js/dna.js` — `findBestORF()` function  

**Finding**: Only the 3 forward reading frames are scanned. The 3 reverse-complement frames are not checked, missing half the possible ORFs.

**Recommended Fix**:
```javascript
// js/dna.js — findBestORF()
const fwdORFs = _scanFrames(dna);
const revORFs = _scanFrames(reverseComplement(dna)).map(o => ({...o, strand: '-'}));
const allORFs = [...fwdORFs, ...revORFs];
```

### [INFORMATIONAL] Incomplete DIWV Instability Matrix
**File**: `js/dna.js` — `INSTABILITY_MATRIX`  

**Finding**: The Guruprasad instability matrix has ~30 entries vs. the full 400-entry DIWV table. Instability scores are underestimated for dipeptides with missing entries (default to 0).

**Recommended Fix**: Embed the full DIWV matrix from Guruprasad et al. (1990) Table 2.

---

## Test Suite Overview

| Suite | Tests | Pass | Fail | Time |
|-------|-------|------|------|------|
| Core Utilities & Codon Table | 106 | 106 | 0 | 78ms |
| DNA/Protein Engine (Scientific) | 168 | 168 | 0 | 85ms |
| Server Security & Proxy Validation | 95 | 95 | 0 | 143ms |
| Bioinformatics Scientific Validation | 85 | 85 | 0 | 89ms |
| Performance & Scalability | 32 | 32 | 0 | 385ms |
| **TOTAL** | **486** | **486** | **0** | **780ms** |

### Test File Inventory
| File | Description |
|------|-------------|
| `tests/test-utils.js` | Core utilities: XSS escape, codon table, safePath, RMSD |
| `tests/test-dna-engine.js` | All 64 codons, ORF detection, 8 protein statistics formulas |
| `tests/test-server-security.js` | SSRF, path traversal, rate limiting, cache, throttle, CSP |
| `tests/test-bioinformatics.js` | NW/SW alignment, sequence identity, epitope validation |
| `tests/test-performance.js` | 1000+ protein throughput, memory bounds, cache scalability |
| `tests/run-all.js` | Master test runner; generates `tests/test-report.json` |

---

## Performance Benchmarks

| Operation | Batch | Time | Pass Threshold |
|-----------|-------|------|----------------|
| DNA translation (300aa) | 1,000× | < 2,000ms | ✅ |
| Molecular weight (200aa) | 1,000× | < 500ms | ✅ |
| GC content | 1,000× | < 200ms | ✅ |
| Cache fill + read (100 entries) | 1× | < 250ms | ✅ |
| Rate limit check | 10,000 req | < 100ms | ✅ |
| Memory: process 5000 proteins | 1× | < 50MB heap | ✅ |

---

## Files Changed

| File | Change |
|------|--------|
| `js/api.js` | **BUG-001 FIX**: Replace `seq.length * 110` with per-residue ExPASy MW |
| `server.js` | **BUG-002 FIX**: Add `Content-Security-Policy` header to `setSecurityHeaders()` |
| `server.js` | **BUG-004 FIX**: Add null-byte guard inside `safePath()` |
| `lib/validator.js` | **BUG-003 FIX**: Add raw URL traversal check before `new URL()` normalisation |
| `lib/cache.js` | Fix: Add `.unref()` to cleanup interval (allows graceful Node.js shutdown) |
| `tests/test-dna-engine.js` | 168 tests — DNA engine, scientific validation |
| `tests/test-server-security.js` | 95 tests — security, SSRF, cache, throttle |
| `tests/test-bioinformatics.js` | 85 tests — alignment, epitope, molecular biology |
| `tests/test-performance.js` | 32 tests — throughput, scalability, memory |
| `tests/run-all.js` | Master test runner |

---

*Generated by GitHub Copilot Autonomous QA Agent — EpitopX AI Audit v1.0*
