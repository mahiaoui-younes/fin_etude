/**
 * EpitopX AI — Master Test Runner
 *
 * Orchestrates all test suites and generates a coloured console report.
 *
 *  Suites:
 *   1. test-utils.js             — XSS escape, normalization, codon table (existing)
 *   2. test-dna-engine.js        — DNA translation, ORF detection, protein stats
 *   3. test-server-security.js   — SSRF, path traversal, rate limiting, cache
 *   4. test-bioinformatics.js    — NW alignment, RMSD, epitope plausibility
 *   5. test-performance.js       — Throughput, memory, large datasets
 *
 * Run: node tests/run-all.js
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const TESTS_DIR = path.resolve(__dirname);
const ROOT      = path.resolve(__dirname, '..');

const SUITES = [
  { file: 'test-utils.js',            label: 'Core Utilities & Codon Table' },
  { file: 'test-dna-engine.js',       label: 'DNA/Protein Engine (Scientific)' },
  { file: 'test-server-security.js',  label: 'Server Security & Proxy Validation' },
  { file: 'test-bioinformatics.js',   label: 'Bioinformatics Scientific Validation' },
  { file: 'test-performance.js',      label: 'Performance & Scalability' },
  { file: 'test-security-auth.js',    label: 'Security: Auth Token & Path Validation' },
  { file: 'test-bio-fixes.js',        label: 'Bioinformatics Fix Verification (Phase 2)' },
];

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const GREY   = '\x1b[90m';

function banner(text) {
  const line = '═'.repeat(64);
  console.log(`\n${CYAN}${BOLD}${line}${RESET}`);
  console.log(`${CYAN}${BOLD}  ${text}${RESET}`);
  console.log(`${CYAN}${BOLD}${line}${RESET}`);
}

function hr() { console.log(`${GREY}${'─'.repeat(64)}${RESET}`); }

// ── Run a single suite ─────────────────────────────────────────────────────
function runSuite({ file, label }) {
  const filePath = path.join(TESTS_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.warn(`${YELLOW}  ⚠ SKIP: ${file} — file not found${RESET}`);
    return { label, file, skipped: true, passed: 0, failed: 0, duration: 0 };
  }

  const t0 = Date.now();
  const result = spawnSync(process.execPath, [filePath], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  const duration = Date.now() - t0;

  const exitCode   = result.status;
  const stdout     = result.stdout || '';
  const stderr     = result.stderr || '';
  const combined   = stdout + stderr;

  // Parse passed/failed counts from output (looks for "N passed, M failed")
  const summary = combined.match(/(\d+) passed, (\d+) failed, (\d+) total/);
  const testsPassed = summary ? parseInt(summary[1], 10) : 0;
  const testsFailed = summary ? parseInt(summary[2], 10) : (exitCode !== 0 ? 1 : 0);
  const testsTotal  = summary ? parseInt(summary[3], 10) : testsPassed + testsFailed;

  return { label, file, passed: testsPassed, failed: testsFailed,
           total: testsTotal, duration, exitCode, stdout, stderr };
}

// ── Colour status ──────────────────────────────────────────────────────────
function statusBadge(passed, failed) {
  if (failed === 0) return `${GREEN}${BOLD}PASS${RESET}`;
  return `${RED}${BOLD}FAIL${RESET}`;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  banner('EpitopX AI — Comprehensive Test Suite');
  console.log(`${GREY}  Started: ${new Date().toISOString()}${RESET}\n`);

  const results = [];
  let totalPassed = 0, totalFailed = 0, totalDuration = 0;

  for (const suite of SUITES) {
    console.log(`\n${BOLD}Running: ${suite.label}${RESET}`);
    hr();
    const r = runSuite(suite);
    results.push(r);

    if (!r.skipped) {
      // Print suite output (indented)
      const lines = (r.stdout + r.stderr).split('\n').filter(Boolean);
      for (const line of lines) {
        const prefix = line.startsWith('  ✗') ? `${RED}` : line.startsWith('  ⚠') ? `${YELLOW}` : `${GREY}`;
        console.log(`  ${prefix}${line}${RESET}`);
      }

      totalPassed   += r.passed;
      totalFailed   += r.failed;
      totalDuration += r.duration;

      console.log(`\n  ${statusBadge(r.passed, r.failed)} — ${r.passed}/${r.total} passed in ${r.duration}ms`);
    }
  }

  // ── Grand summary ──────────────────────────────────────────────────────
  banner('TEST SUMMARY');

  const TABLE_WIDTH = 64;
  const col1 = 38, col2 = 10, col3 = 8, col4 = 8;

  const header = `${'Suite'.padEnd(col1)} ${'Passed'.padStart(col2)} ${'Failed'.padStart(col3)} ${'ms'.padStart(col4)}`;
  console.log(`${BOLD}${header}${RESET}`);
  console.log(`${GREY}${'─'.repeat(TABLE_WIDTH)}${RESET}`);

  for (const r of results) {
    if (r.skipped) {
      console.log(`${YELLOW}${r.label.padEnd(col1)} SKIPPED${RESET}`);
      continue;
    }
    const failedStr = r.failed > 0 ? `${RED}${String(r.failed).padStart(col3)}${RESET}` : `${GREEN}${String(r.failed).padStart(col3)}${RESET}`;
    const passedStr = `${GREEN}${String(r.passed).padStart(col2)}${RESET}`;
    const durationStr = String(r.duration).padStart(col4);
    const badge = r.failed > 0 ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;
    console.log(`${badge} ${r.label.padEnd(col1 - 2)} ${passedStr} ${failedStr} ${GREY}${durationStr}${RESET}`);
  }

  console.log(`${GREY}${'─'.repeat(TABLE_WIDTH)}${RESET}`);

  const totalStr = `${'TOTAL'.padEnd(col1)} ${String(totalPassed).padStart(col2)} ${String(totalFailed).padStart(col3)} ${String(totalDuration).padStart(col4)}`;
  const color = totalFailed > 0 ? RED : GREEN;
  console.log(`${color}${BOLD}${totalStr}${RESET}`);

  console.log(`\n${GREY}  Finished: ${new Date().toISOString()}${RESET}`);

  if (totalFailed === 0) {
    console.log(`\n${GREEN}${BOLD}✓ All tests passed!${RESET}\n`);
  } else {
    console.log(`\n${RED}${BOLD}✗ ${totalFailed} test(s) failed.${RESET}\n`);
  }

  // ── Generate JSON report ───────────────────────────────────────────────
  const report = {
    timestamp: new Date().toISOString(),
    summary: { passed: totalPassed, failed: totalFailed, total: totalPassed + totalFailed, durationMs: totalDuration },
    suites: results.map(r => ({
      label: r.label,
      file: r.file,
      passed: r.passed || 0,
      failed: r.failed || 0,
      total: r.total || 0,
      durationMs: r.duration || 0,
      status: r.skipped ? 'skipped' : r.failed === 0 ? 'pass' : 'fail',
    })),
  };

  const reportPath = path.join(TESTS_DIR, 'test-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`${GREY}  Report written to: tests/test-report.json${RESET}\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
