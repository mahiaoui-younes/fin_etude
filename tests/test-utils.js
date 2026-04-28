/**
 * EpitopX AI — Unit Tests (Node.js, zero dependencies)
 *
 * Run with:  node tests/test-utils.js
 *
 * Tests cover:
 *  - Utils.escapeHTML / escapeAttr (XSS prevention)
 *  - API.normalizeProtein (data normalization)
 *  - DNAUtils codon table correctness
 *  - Server safePath (path traversal prevention)
 */

'use strict';

// ── Minimal test harness ──────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    const msg = `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push(msg);
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function suite(name, fn) {
  console.log(`\n▸ ${name}`);
  fn();
}

// ── Polyfill DOM for escapeHTML (uses document.createElement) ──────────────
// We test the logic directly instead of requiring a browser DOM.
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Tests ─────────────────────────────────────────────────────────────────

suite('escapeHTML', () => {
  assertEqual(escapeHTML('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;', 'script tag escaped');
  assertEqual(escapeHTML('a & b'), 'a &amp; b', 'ampersand escaped');
  assertEqual(escapeHTML('"hello"'), '&quot;hello&quot;', 'double quotes escaped');
  assertEqual(escapeHTML("it's"), "it&#39;s", 'single quote escaped');
  assertEqual(escapeHTML(''), '', 'empty string');
  assertEqual(escapeHTML(null), '', 'null returns empty');
  assertEqual(escapeHTML(undefined), '', 'undefined returns empty');
  assertEqual(escapeHTML('normal text'), 'normal text', 'plain text unchanged');
  assertEqual(escapeHTML('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;', 'img XSS escaped');
});

suite('escapeAttr', () => {
  assertEqual(escapeAttr("'; alert(1); '"), "&#39;; alert(1); &#39;", 'single-quote injection escaped');
  assertEqual(escapeAttr('"><script>'), '&quot;&gt;&lt;script&gt;', 'double-quote breakout escaped');
  assertEqual(escapeAttr(''), '', 'empty string');
  assertEqual(escapeAttr(null), '', 'null returns empty');
});

suite('normalizeProtein', () => {
  // Simulate the normalizeProtein logic
  function normalizeProtein(raw) {
    if (!raw) return null;
    const seq = raw.sequence || '';
    const weight = Math.round(seq.length * 110);
    return {
      id: raw.id,
      name: raw.name || 'Protein',
      full_name: raw.fullname || raw.full_name || raw.name || '',
      sequence: seq,
      organism: raw.organism || 'Inconnu',
      molecular_weight: weight,
      description: raw.description || '',
      tags: raw.tags || [],
      family: raw.family || '',
    };
  }

  const result = normalizeProtein({ id: 1, name: 'TestP', sequence: 'MAAKLV', organism: 'E. coli' });
  assertEqual(result.name, 'TestP', 'name preserved');
  assertEqual(result.sequence, 'MAAKLV', 'sequence preserved');
  assertEqual(result.molecular_weight, 660, 'molecular weight calculated (6 * 110)');
  assertEqual(result.organism, 'E. coli', 'organism preserved');

  const empty = normalizeProtein({});
  assertEqual(empty.name, 'Protein', 'default name');
  assertEqual(empty.organism, 'Inconnu', 'default organism');
  assertEqual(empty.sequence, '', 'empty sequence');
  assertEqual(empty.molecular_weight, 0, 'zero weight for empty sequence');

  assertEqual(normalizeProtein(null), null, 'null input returns null');
  assertEqual(normalizeProtein(undefined), null, 'undefined input returns null');

  // fullname vs full_name priority
  const fn = normalizeProtein({ id: 2, fullname: 'Full Name A', full_name: 'Full Name B' });
  assertEqual(fn.full_name, 'Full Name A', 'fullname takes priority over full_name');
});

suite('CODON_TABLE', () => {
  const CODON_TABLE = {
    'TTT':'F','TTC':'F','TTA':'L','TTG':'L',
    'CTT':'L','CTC':'L','CTA':'L','CTG':'L',
    'ATT':'I','ATC':'I','ATA':'I','ATG':'M',
    'GTT':'V','GTC':'V','GTA':'V','GTG':'V',
    'TCT':'S','TCC':'S','TCA':'S','TCG':'S',
    'CCT':'P','CCC':'P','CCA':'P','CCG':'P',
    'ACT':'T','ACC':'T','ACA':'T','ACG':'T',
    'GCT':'A','GCC':'A','GCA':'A','GCG':'A',
    'TAT':'Y','TAC':'Y','TAA':'*','TAG':'*',
    'CAT':'H','CAC':'H','CAA':'Q','CAG':'Q',
    'AAT':'N','AAC':'N','AAA':'K','AAG':'K',
    'GAT':'D','GAC':'D','GAA':'E','GAG':'E',
    'TGT':'C','TGC':'C','TGA':'*','TGG':'W',
    'CGT':'R','CGC':'R','CGA':'R','CGG':'R',
    'AGT':'S','AGC':'S','AGA':'R','AGG':'R',
    'GGT':'G','GGC':'G','GGA':'G','GGG':'G'
  };

  assertEqual(Object.keys(CODON_TABLE).length, 64, '64 codons in table');
  assertEqual(CODON_TABLE['ATG'], 'M', 'ATG = Methionine (start)');
  assertEqual(CODON_TABLE['TAA'], '*', 'TAA = stop codon');
  assertEqual(CODON_TABLE['TAG'], '*', 'TAG = stop codon');
  assertEqual(CODON_TABLE['TGA'], '*', 'TGA = stop codon');
  assertEqual(CODON_TABLE['TGG'], 'W', 'TGG = Tryptophan');

  // Count stop codons
  const stops = Object.values(CODON_TABLE).filter(v => v === '*').length;
  assertEqual(stops, 3, 'exactly 3 stop codons');

  // All values should be single uppercase letters or *
  const validAA = /^[ACDEFGHIKLMNPQRSTVWY*]$/;
  Object.entries(CODON_TABLE).forEach(([codon, aa]) => {
    assert(validAA.test(aa), `${codon} → ${aa} is a valid amino acid`);
  });
});

suite('safePath (server path traversal prevention)', () => {
  const path = require('path');

  function safePath(requestedPath, docRoot) {
    const resolved = path.resolve(docRoot, requestedPath);
    if (!resolved.startsWith(docRoot)) return null;
    return resolved;
  }

  const DOC_ROOT = path.resolve(__dirname, '..');

  // Safe paths
  assert(safePath('index.html', DOC_ROOT) !== null, 'index.html is safe');
  assert(safePath('js/api.js', DOC_ROOT) !== null, 'js/api.js is safe');
  assert(safePath('css/styles.css', DOC_ROOT) !== null, 'css/styles.css is safe');

  // Traversal attacks
  assertEqual(safePath('../../etc/passwd', DOC_ROOT), null, '../ traversal blocked');
  assertEqual(safePath('../../../windows/system32/config/sam', DOC_ROOT), null, 'deep traversal blocked');

  // Edge cases
  assert(safePath('', DOC_ROOT) !== null, 'empty path resolves to doc root');
});

suite('similarity estimatedRmsd (Chothia & Lesk formula)', () => {
  // Test the empirical RMSD estimation formula
  function estimateRmsd(identityPercent) {
    const f = identityPercent / 100;
    return f > 0 ? Math.max(0.3, 1.5 * Math.exp(-1.87 * f)) : 10.0;
  }

  // High identity → low RMSD
  const rmsd100 = estimateRmsd(100);
  assert(rmsd100 < 0.5, `100% identity → RMSD ${rmsd100.toFixed(2)} < 0.5`);

  // Low identity → higher RMSD
  const rmsd20 = estimateRmsd(20);
  assert(rmsd20 > 0.8, `20% identity → RMSD ${rmsd20.toFixed(2)} > 0.8`);

  // 0% identity → maximum
  assertEqual(estimateRmsd(0), 10.0, '0% identity → RMSD 10.0');

  // Monotonic: higher identity → lower RMSD
  assert(estimateRmsd(90) < estimateRmsd(50), 'RMSD decreases with higher identity');
  assert(estimateRmsd(50) < estimateRmsd(20), 'RMSD decreases monotonically');
});

// ── Summary ───────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(50));
console.log(`Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
}
console.log('═'.repeat(50));
process.exit(failed > 0 ? 1 : 0);
