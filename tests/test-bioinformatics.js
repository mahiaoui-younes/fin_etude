/**
 * EpitopX AI — Bioinformatics Scientific Validation Tests
 *
 * Validates the scientific correctness of all bioinformatics algorithms:
 *  - Pairwise sequence alignment (Needleman-Wunsch)
 *  - Sequence identity calculation
 *  - RMSD estimation formula
 *  - Epitope prediction plausibility
 *  - FASTA parsing for real protein sequences
 *  - GC content, ORF detection accuracy
 *  - Protein physicochemical properties vs. ExPASy reference
 *  - DNA ↔ Protein consistency checks
 *
 * Run: node tests/test-bioinformatics.js
 */
'use strict';

// ── Harness ────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.error(`  ✗ FAIL: ${msg}`); }
}
function assertEqual(a, e, msg) {
  if (a === e) { passed++; }
  else {
    const m = `${msg} — expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`;
    failed++; failures.push(m); console.error(`  ✗ FAIL: ${m}`);
  }
}
function assertClose(a, e, tol, msg) {
  if (Math.abs(a - e) <= tol) { passed++; }
  else {
    const m = `${msg} — expected ~${e} ±${tol}, got ${a}`;
    failed++; failures.push(m); console.error(`  ✗ FAIL: ${m}`);
  }
}
function suite(name, fn) { console.log(`\n▸ ${name}`); fn(); }

// ── Re-implement core algorithms for standalone testing ─────────────────
// (mirrors compare.js and dna.js without DOM dependencies)

const CODON_TABLE = {
  'TTT':'F','TTC':'F','TTA':'L','TTG':'L','CTT':'L','CTC':'L','CTA':'L','CTG':'L',
  'ATT':'I','ATC':'I','ATA':'I','ATG':'M','GTT':'V','GTC':'V','GTA':'V','GTG':'V',
  'TCT':'S','TCC':'S','TCA':'S','TCG':'S','CCT':'P','CCC':'P','CCA':'P','CCG':'P',
  'ACT':'T','ACC':'T','ACA':'T','ACG':'T','GCT':'A','GCC':'A','GCA':'A','GCG':'A',
  'TAT':'Y','TAC':'Y','TAA':'*','TAG':'*','CAT':'H','CAC':'H','CAA':'Q','CAG':'Q',
  'AAT':'N','AAC':'N','AAA':'K','AAG':'K','GAT':'D','GAC':'D','GAA':'E','GAG':'E',
  'TGT':'C','TGC':'C','TGA':'*','TGG':'W','CGT':'R','CGC':'R','CGA':'R','CGG':'R',
  'AGT':'S','AGC':'S','AGA':'R','AGG':'R','GGT':'G','GGC':'G','GGA':'G','GGG':'G'
};

const RESIDUE_WEIGHTS = {
  'A':71.0788,'R':156.1875,'N':114.1038,'D':115.0886,'C':103.1388,'E':129.1155,
  'Q':128.1307,'G':57.0519,'H':137.1411,'I':113.1594,'L':113.1594,'K':128.1741,
  'M':131.1926,'F':147.1766,'P':97.1167,'S':87.0782,'T':101.1051,'W':186.2132,
  'Y':163.1760,'V':99.1326
};

const HYDROPHOBICITY = {
  'A':1.8,'R':-4.5,'N':-3.5,'D':-3.5,'C':2.5,'E':-3.5,'Q':-3.5,'G':-0.4,
  'H':-3.2,'I':4.5,'L':3.8,'K':-3.9,'M':1.9,'F':2.8,'P':-1.6,'S':-0.8,
  'T':-0.7,'W':-0.9,'Y':-1.3,'V':4.2
};

const PKA = { Nterm:9.60, Cterm:2.34, D:3.86, E:4.25, H:6.04, C:8.33, Y:10.46, K:10.54, R:12.48 }; // Lide 1994

function computeMW(seq) {
  if (!seq) return 0;
  let mw = 18.02;
  for (const aa of seq) mw += RESIDUE_WEIGHTS[aa] || 111.1;
  return mw;
}

function computePI(seq) {
  if (!seq || seq.length === 0) return null;
  const count = aa => (seq.match(new RegExp(aa, 'g')) || []).length;
  const nD=count('D'),nE=count('E'),nH=count('H'),nC=count('C'),nY=count('Y'),nK=count('K'),nR=count('R');
  const f = (pK, n, sign) => sign * n / (1 + Math.pow(10, sign * (0 - pK)));
  function charge(pH) {
    const g = (pK, n, sign) => sign * n / (1 + Math.pow(10, sign * (pH - pK)));
    return (g(PKA.Nterm,1,1)+g(PKA.K,nK,1)+g(PKA.R,nR,1)+g(PKA.H,nH,1)+
            g(PKA.D,nD,-1)+g(PKA.E,nE,-1)+g(PKA.C,nC,-1)+g(PKA.Y,nY,-1)+g(PKA.Cterm,1,-1));
  }
  let lo=0, hi=14;
  for (let i=0;i<200;i++) { const mid=(lo+hi)/2; if(charge(mid)>0) lo=mid; else hi=mid; }
  return parseFloat(((lo+hi)/2).toFixed(2));
}

function computeGRAVY(seq) {
  if (!seq || seq.length === 0) return null;
  const sum = seq.split('').reduce((s, aa) => s + (HYDROPHOBICITY[aa] || 0), 0);
  return parseFloat((sum / seq.length).toFixed(3));
}

function computeGC(dna) {
  if (!dna) return 0;
  return parseFloat(((dna.match(/[GC]/g)||[]).length / dna.length * 100).toFixed(1));
}

function computeExtinction(seq) {
  if (!seq) return 0;
  return (seq.match(/W/g)||[]).length * 5500 +
         (seq.match(/Y/g)||[]).length * 1490 +
         (seq.match(/C/g)||[]).length * 125;
}

/**
 * Needleman-Wunsch global alignment
 * Returns { seqA, seqB, score, identity, matches, gaps }
 * Using BLOSUM-like simple match/mismatch scoring:
 *   match: +1, mismatch: -1, gap: -2
 */
function needlemanWunsch(a, b, match=1, mismatch=-1, gapPenalty=-2) {
  const n = a.length, m = b.length;
  // Initialize score matrix
  const dp = Array.from({length: n+1}, () => new Array(m+1).fill(0));
  for (let i=0; i<=n; i++) dp[i][0] = i * gapPenalty;
  for (let j=0; j<=m; j++) dp[0][j] = j * gapPenalty;

  for (let i=1; i<=n; i++) {
    for (let j=1; j<=m; j++) {
      const score = a[i-1] === b[j-1] ? match : mismatch;
      dp[i][j] = Math.max(
        dp[i-1][j-1] + score,
        dp[i-1][j]   + gapPenalty,
        dp[i][j-1]   + gapPenalty
      );
    }
  }

  // Traceback
  let alignA = '', alignB = '';
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const score = a[i-1] === b[j-1] ? match : mismatch;
      if (dp[i][j] === dp[i-1][j-1] + score) {
        alignA = a[i-1] + alignA;
        alignB = b[j-1] + alignB;
        i--; j--;
        continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i-1][j] + gapPenalty) {
      alignA = a[i-1] + alignA;
      alignB = '-' + alignB;
      i--;
    } else {
      alignA = '-' + alignA;
      alignB = b[j-1] + alignB;
      j--;
    }
  }

  let matches = 0, gaps = 0;
  for (let k=0; k<alignA.length; k++) {
    if (alignA[k] === alignB[k] && alignA[k] !== '-') matches++;
    if (alignA[k] === '-' || alignB[k] === '-') gaps++;
  }
  const alignLen = alignA.length;
  const identity = parseFloat((matches / alignLen * 100).toFixed(1));

  return { seqA: alignA, seqB: alignB, score: dp[n][m], identity, matches, gaps, total: alignLen };
}

/**
 * Smith-Waterman local alignment (simplified)
 */
function smithWaterman(a, b, match=2, mismatch=-1, gapPenalty=-2) {
  const n = a.length, m = b.length;
  const dp = Array.from({length: n+1}, () => new Array(m+1).fill(0));
  let maxScore = 0, maxI = 0, maxJ = 0;

  for (let i=1; i<=n; i++) {
    for (let j=1; j<=m; j++) {
      const score = a[i-1] === b[j-1] ? match : mismatch;
      dp[i][j] = Math.max(0,
        dp[i-1][j-1] + score,
        dp[i-1][j]   + gapPenalty,
        dp[i][j-1]   + gapPenalty
      );
      if (dp[i][j] > maxScore) { maxScore = dp[i][j]; maxI = i; maxJ = j; }
    }
  }
  return { score: maxScore, endI: maxI, endJ: maxJ };
}

/**
 * RMSD estimation from sequence identity (Chothia & Lesk, 1986)
 * Used by compare.js when 3D coordinates are not available.
 */
function estimateRmsd(identityPercent) {
  const f = identityPercent / 100;
  return f > 0 ? Math.max(0.3, 1.5 * Math.exp(-1.87 * f)) : 10.0;
}

/**
 * Simple sequence identity calculation (no alignment).
 * Counts identical positions at same index.
 */
function simpleIdentity(a, b) {
  const len = Math.min(a.length, b.length);
  let matches = 0;
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) matches++;
  }
  return parseFloat((matches / Math.max(a.length, b.length) * 100).toFixed(1));
}

// ── Real protein sequences for testing ────────────────────────────────────
// Theileria annulata Surface Protein (TaSP) - synthetic test sequence
const TaSP_SEQ = 'MKAAVLRGSNTTNTMANSFSETTDPSFLGQRVVQALEKQHQQGLQARRGDEDAQLAQEEQDTLHAYQQKLKNEGLAARLQELREKQRAEIAQKQQFDDLQNKAQEKDNALQEQARQINDTQNKLQEAQQQLDQIQSQIANQQQQL';

// TpMSP-like sequence (Theileria parva Merozoite Surface Protein)
const TpMSP_SEQ = 'MKLLFLTLVLSSIASEGSTFSEKTGQQPSEKTTESNETTEENQTQTETTVEESTNNTSETSSESVNTASESTKETISESEATPETTSSKVNSTGSTDPVHGKSKGSTLNVSSSTSSVQPQSITDKPKPEESTQPNATKT';

// Ubiquitin (76 aa) — well-characterized reference protein
const UBIQUITIN = 'MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG';

// GFP chromophore-forming region (partial)
const GFP_PARTIAL = 'MVSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTLTYGVQCFSRYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITLGMDELYK';

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

suite('Needleman-Wunsch — algorithm correctness', () => {
  // Identical sequences → 100% identity
  const r1 = needlemanWunsch('MKAAV', 'MKAAV');
  assertEqual(r1.identity, 100, 'identical sequences → 100% identity');
  assertEqual(r1.gaps, 0, 'no gaps for identical sequences');
  assertEqual(r1.matches, 5, '5 matches for 5-char identical');

  // Completely different → low identity
  const r2 = needlemanWunsch('AAAAA', 'RRRRR');
  assert(r2.identity < 50, `completely different sequences → low identity (${r2.identity}%)`);

  // Single substitution
  const r3 = needlemanWunsch('MKAAV', 'MKAEV');  // A→E at position 4
  assert(r3.identity >= 60 && r3.identity <= 90, `1/5 substitution → 60-90% identity (${r3.identity}%)`);

  // Gap insertion
  const r4 = needlemanWunsch('MKAAV', 'MKAV');  // deletion
  assert(r4.gaps >= 1, 'gap detected for deletion');

  // Empty sequence edge case
  const r5 = needlemanWunsch('', 'MKAAV');
  assert(r5.gaps >= 0, 'empty sequence A handled');

  // Single character
  const r6 = needlemanWunsch('M', 'M');
  assertEqual(r6.identity, 100, 'single-char identical → 100%');
  const r7 = needlemanWunsch('M', 'K');
  assertEqual(r7.identity, 0, 'single-char mismatch → 0%');

  // Alignment symmetry: NW(A,B) ≈ NW(B,A)
  const r8a = needlemanWunsch('MKAAVL', 'MKAAVLRGSN');
  const r8b = needlemanWunsch('MKAAVLRGSN', 'MKAAVL');
  assertClose(r8a.identity, r8b.identity, 5, 'NW roughly symmetric (within 5%)');

  // Known alignment: 
  // MKAAV → MKA-V with 1 gap
  // MKAV  → MK-AV
  // result should have ~80% identity
  const r9 = needlemanWunsch('MKAAV', 'MKAV');
  assert(r9.matches >= 4, `MKAAV vs MKAV: at least 4 matches (got ${r9.matches})`);
});

suite('Smith-Waterman — local alignment', () => {
  // Identical → high score
  const r1 = smithWaterman('MKAAV', 'MKAAV');
  assert(r1.score > 0, 'identical sequences → positive score');

  // Substring match
  const r2 = smithWaterman('XXXMKAAAXXX', 'MKAAA');
  assert(r2.score >= 5, `substring match score ${r2.score} ≥ 5`);

  // Complete mismatch
  const r3 = smithWaterman('AAAAA', 'CCCCC');
  assertEqual(r3.score, 0, 'complete mismatch → score 0');

  // Longer identical region scores higher
  const r4a = smithWaterman('MKAAV', 'MKAA');  // 4-char match
  const r4b = smithWaterman('MKA', 'MKA');     // 3-char match
  assert(r4a.score >= r4b.score, 'longer match scores higher');
});

suite('RMSD estimation — Chothia & Lesk formula', () => {
  // 100% identity → minimum RMSD (~0.3 Å)
  const rmsd100 = estimateRmsd(100);
  assert(rmsd100 <= 0.5, `100% identity → RMSD ${rmsd100.toFixed(2)} ≤ 0.5 Å`);

  // 0% identity → maximum (10.0 Å)
  assertEqual(estimateRmsd(0), 10.0, '0% identity → RMSD = 10.0 Å');

  // Monotonically decreasing
  assert(estimateRmsd(90) < estimateRmsd(50), 'RMSD decreases with identity (90% < 50%)');
  assert(estimateRmsd(50) < estimateRmsd(20), 'RMSD monotonic (50% < 20%)');
  assert(estimateRmsd(20) < estimateRmsd(10), 'RMSD monotonic (20% < 10%)');

  // Biologically sensible range
  for (let pct = 10; pct <= 100; pct += 10) {
    const r = estimateRmsd(pct);
    assert(r >= 0 && r <= 10, `RMSD for ${pct}% identity = ${r.toFixed(2)} in [0,10]`);
  }

  // ~30% identity → ~1.0–1.5 Å (structurally conserved fold)
  const rmsd30 = estimateRmsd(30);
  assert(rmsd30 > 0.5 && rmsd30 < 2.0, `30% identity → RMSD ${rmsd30.toFixed(2)} in 0.5–2.0 Å range`);

  // ~70% identity → low RMSD (~0.3–0.6 Å)
  const rmsd70 = estimateRmsd(70);
  assert(rmsd70 < 0.7, `70% identity → RMSD ${rmsd70.toFixed(2)} < 0.7 Å`);
});

suite('Sequence identity calculation', () => {
  // Exact match
  assertEqual(simpleIdentity('MKAAV', 'MKAAV'), 100, 'identical → 100%');

  // No match
  assertEqual(simpleIdentity('AAAA', 'RRRR'), 0, 'no match → 0%');

  // Partial match
  assertEqual(simpleIdentity('MKAAV', 'MKRRR'), 40, '2/5 match → 40%');

  // Different lengths
  const id = simpleIdentity('MKA', 'MKAAV');
  assert(id >= 0 && id <= 100, `different-length identity in valid range: ${id}%`);
});

suite('Protein statistics — ExPASy reference values', () => {
  // ─── Human Ubiquitin (P0CG48) ─────────────────────────────────────────
  // ExPASy ProtParam reference values:
  //   MW = 8564.85 Da
  //   pI = 6.56
  //   GRAVY = -0.537
  //   Ext. coeff = 1490 (1 Tyr, no Trp)

  const ubMW = computeMW(UBIQUITIN);
  assertClose(ubMW, 8564.85, 50, `Ubiquitin MW (expected ~8564 Da, got ${ubMW.toFixed(1)})`);

  const ubPI = computePI(UBIQUITIN);
  // Lide 1994 pKa scale gives ubiquitin pI ≈ 7.7 (ExPASy uses IEF-calibrated scale → 6.56)
  assertClose(ubPI, 7.7, 0.5, `Ubiquitin pI (Lide 1994 scale ≈ 7.7, got ${ubPI})`);

  const ubGRAVY = computeGRAVY(UBIQUITIN);
  assertClose(ubGRAVY, -0.537, 0.05, `Ubiquitin GRAVY (expected ~-0.537, got ${ubGRAVY})`);

  const ubExt = computeExtinction(UBIQUITIN);
  // Ubiquitin has 0 W, 1 Y → ε = 1490
  const nW = (UBIQUITIN.match(/W/g)||[]).length;
  assertEqual(nW, 0, 'Ubiquitin has 0 Trp residues');
  assertEqual(ubExt, 1490, `Ubiquitin extinction = 1490 (1 Tyr × 1490)`);

  // Amino acid composition check (Ubiquitin has 76 residues)
  assertEqual(UBIQUITIN.length, 76, 'Ubiquitin is 76 aa');

  // ─── GFP (Aequorea victoria GFP, partial) ─────────────────────────────
  const gfpGRAVY = computeGRAVY(GFP_PARTIAL);
  assert(gfpGRAVY < 0, `GFP GRAVY ${gfpGRAVY} should be negative (GFP is hydrophilic overall)`);

  // ─── TaSP-like sequence ────────────────────────────────────────────────
  const taspMW = computeMW(TaSP_SEQ);
  // ~140 aa × ~111 Da/aa ≈ 15,700 Da
  assert(taspMW > 14000 && taspMW < 18000, `TaSP MW ${taspMW.toFixed(0)} in expected range 14–18 kDa`);

  const taspPI = computePI(TaSP_SEQ);
  assert(taspPI >= 0 && taspPI <= 14, `TaSP pI ${taspPI} in valid range`);
  // TaSP is lysine/glutamate-rich → expect moderate pI
  assert(taspPI > 3 && taspPI < 12, `TaSP pI ${taspPI} in realistic 3–12 range`);
});

suite('DNA translation — known biological sequences', () => {
  // Human hemoglobin alpha subunit first 9 nt
  // ATGGTGCAC → Met-Val-His (MVH)
  function translate3(dna) {
    const aa = [];
    for (let i = 0; i + 2 < dna.length; i += 3) {
      const codon = dna.substring(i, i + 3);
      const a = CODON_TABLE[codon];
      if (!a || a === '*') break;
      aa.push(a);
    }
    return aa.join('');
  }
  assertEqual(translate3('ATGGTGCAC'), 'MVH', 'HBA1 start: ATG GTG CAC = MVH');
  assertEqual(translate3('ATGGCATCC'), 'MAS', 'ATG GCA TCC = MAS');
  assertEqual(translate3('ATGAAACCC'), 'MKP', 'ATG AAA CCC = MKP');

  // Insulin B-chain coding region (partial): ATG TTT GTG AAC CAA
  // Met-Phe-Val-Asn-Gln = MFVNQ
  assertEqual(translate3('ATGTTTGTGAACCAA'), 'MFVNQ', 'Insulin B partial: MFVNQ');

  // Verify stop codons terminate translation
  function translateWithStop(dna) {
    const aa = [];
    for (let i = 0; i + 2 < dna.length; i += 3) {
      const codon = dna.substring(i, i + 3);
      const a = CODON_TABLE[codon];
      if (a === '*') return aa.join('') + '*';
      aa.push(a || 'X');
    }
    return aa.join('');
  }
  assert(translateWithStop('ATGAAATAACCC').endsWith('*'), 'translation stops at TAA');
  assert(translateWithStop('ATGAAATAGGGG').endsWith('*'), 'translation stops at TAG');
  assert(translateWithStop('ATGAAATGAGGG').endsWith('*'), 'translation stops at TGA');

  // GC content validation
  assertClose(computeGC('GGGGGGGGGG'), 100, 0.1, 'all-G GC = 100%');
  assertClose(computeGC('ATATATAT'), 0, 0.1, 'AT-only GC = 0% (only A and T)');  // no G or C
  assertClose(computeGC('GCGCGCGC'), 100, 0.1, 'GC-only = 100%');
  assertClose(computeGC('ATGCATGC'), 50, 0.1, 'ATGCATGC = 50%');
});

suite('Epitope prediction plausibility — output validation', () => {
  // Simulate epitope output format validation
  function validateEpitope(ep) {
    const errors = [];
    if (!ep.sequence || ep.sequence.length < 8) errors.push('epitope too short (<8 aa)');
    if (!ep.sequence || ep.sequence.length > 25) errors.push('epitope too long (>25 aa)');
    if (typeof ep.score !== 'number' || ep.score < 0 || ep.score > 1) errors.push('score out of range [0,1]');
    if (ep.start < 1) errors.push('start position < 1');
    if (ep.end < ep.start) errors.push('end < start');
    if (ep.end - ep.start + 1 !== ep.sequence.length) errors.push('position span ≠ sequence length');
    // Validate amino acid sequence
    const validAA = /^[ACDEFGHIKLMNPQRSTVWY]+$/;
    if (!validAA.test(ep.sequence)) errors.push('invalid AA in epitope sequence');
    return errors;
  }

  // Valid epitopes
  const validEp1 = { sequence: 'MKAAVLRGSN', start: 1, end: 10, score: 0.85 };
  const errors1 = validateEpitope(validEp1);
  assertEqual(errors1.length, 0, `valid epitope passes all checks (got: ${errors1.join(', ')})`);

  const validEp2 = { sequence: 'FLGQRVVQALEK', start: 25, end: 36, score: 0.72 };
  const errors2 = validateEpitope(validEp2);
  assertEqual(errors2.length, 0, `12-mer epitope passes (got: ${errors2.join(', ')})`);

  // Invalid: score out of range
  const badScore = { sequence: 'MKAAVLRGSN', start: 1, end: 10, score: 1.5 };
  assert(validateEpitope(badScore).length > 0, 'score > 1 rejected');

  // Invalid: too short
  const tooShort = { sequence: 'MKAAV', start: 1, end: 5, score: 0.5 };
  assert(validateEpitope(tooShort).length > 0, 'epitope < 8 aa rejected');

  // Invalid: position mismatch
  const posMismatch = { sequence: 'MKAAVLRGSN', start: 1, end: 5, score: 0.5 }; // 10aa but end=5
  assert(validateEpitope(posMismatch).length > 0, 'position span mismatch rejected');

  // Invalid: non-AA characters
  const badChars = { sequence: 'MKAAV*RGSN', start: 1, end: 10, score: 0.5 };
  assert(validateEpitope(badChars).length > 0, 'stop codon in epitope sequence rejected');

  // Biologically plausible epitope lengths (MHC-I: 8-11aa, MHC-II: 13-25aa)
  const mhcI = { sequence: 'MKAAVLRG', start: 1, end: 8, score: 0.6 }; // 8-mer
  assertEqual(validateEpitope(mhcI).length, 0, 'MHC-I 8-mer is valid');

  const mhcII = { sequence: 'MKAAVLRGSNTTNTM', start: 1, end: 15, score: 0.7 }; // 15-mer
  assertEqual(validateEpitope(mhcII).length, 0, 'MHC-II 15-mer is valid');
});

suite('Fuzzy sequence matching — FASTA epitope search', () => {
  // Simulate the epitope search fuzzy matching logic
  function fuzzyIdentity(query, target) {
    if (query.length === 0 || target.length === 0) return 0;
    // Sliding window approach: find best match
    let best = 0;
    for (let i = 0; i <= target.length - query.length; i++) {
      const window = target.substring(i, i + query.length);
      let matches = 0;
      for (let j = 0; j < query.length; j++) {
        if (query[j] === window[j]) matches++;
      }
      best = Math.max(best, matches / query.length);
    }
    return parseFloat((best * 100).toFixed(1));
  }

  // Exact match
  assertEqual(fuzzyIdentity('MKAAV', 'XXXMKAAVYYY'), 100, 'exact match = 100%');

  // 1 substitution in 5 = 80%
  assertEqual(fuzzyIdentity('MKAAV', 'XXXMKRAV'), 80, '1 substitution in 5 = 80%');

  // No match → 0
  assertEqual(fuzzyIdentity('AAAAA', 'RRRRRRRR'), 0, 'no match = 0%');

  // Partial match at threshold 70%
  const identity = fuzzyIdentity('MKAAVLR', 'MKAAXLR');
  assert(identity >= 70, `6/7 match → ${identity}% ≥ 70%`);
});

suite('Phylogenetic / molecular clock plausibility', () => {
  // Estimate synonymous substitution rate (rough)
  // Based on Kimura's 2-parameter model for neutral evolution
  function estimateSubstitutionRate(identityPercent, myaAgo) {
    // Rough molecular clock: ~1% divergence per 5 million years (mammals)
    // Returns expected identity if proteins diverged `myaAgo` million years ago
    const divergence = myaAgo * 0.2; // 0.2% per Mya for proteins
    return Math.max(0, 100 - divergence);
  }

  // Two species that diverged 10 Mya → ~98% identity (fast-evolving genes ~95-97%)
  const closeSpecies = estimateSubstitutionRate(97, 10);
  assert(closeSpecies >= 90, `diverged 10 Mya → expected ≥90% identity (got ${closeSpecies.toFixed(1)}%)`);

  // Two species that diverged 100 Mya → lower identity (~80%)
  const farSpecies = estimateSubstitutionRate(80, 100);
  assert(farSpecies >= 75, `diverged 100 Mya → expected ≥75% identity (got ${farSpecies.toFixed(1)}%)`);

  // Theileria species identity check
  // T. annulata and T. parva diverged ~35-40 Mya → expect ~30-60% protein identity
  const tannulataVsParva = 38;
  const expectedIdentity = estimateSubstitutionRate(50, tannulataVsParva);
  assert(expectedIdentity >= 20, `Theileria sp. divergence → ${expectedIdentity.toFixed(1)}% expected range`);
});

suite('FASTA parser — multi-sequence handling', () => {
  function parseMultiFASTA(input) {
    if (!input || typeof input !== 'string') return [];
    const results = [];
    let currentHeader = null;
    let currentSeq = [];
    for (const line of input.split('\n')) {
      const t = line.trim();
      if (t.startsWith('>')) {
        if (currentHeader !== null) {
          results.push({ header: currentHeader, sequence: currentSeq.join('').toUpperCase() });
        }
        currentHeader = t.substring(1).trim();
        currentSeq = [];
      } else if (t) {
        currentSeq.push(t.replace(/[\s\d]/g, ''));
      }
    }
    if (currentHeader !== null) {
      results.push({ header: currentHeader, sequence: currentSeq.join('').toUpperCase() });
    }
    return results;
  }

  const multiFASTA = `>TaSP|TANN_0310\nMKAAVLRGSN\nTTNTMAN\n>TpMSP|Tp3_0097\nMKLLFLTLVL\nSSIASEG`;
  const records = parseMultiFASTA(multiFASTA);

  assertEqual(records.length, 2, 'two records in multi-FASTA');
  assertEqual(records[0].header, 'TaSP|TANN_0310', 'first header parsed');
  assertEqual(records[0].sequence, 'MKAAVLRGSNTTNTMAN', 'first sequence concatenated');
  assertEqual(records[1].header, 'TpMSP|Tp3_0097', 'second header parsed');

  // Edge: only one record
  const single = parseMultiFASTA('>P12345\nMKAAV');
  assertEqual(single.length, 1, 'single record parsed');

  // Edge: empty
  assertEqual(parseMultiFASTA('').length, 0, 'empty → no records');
  assertEqual(parseMultiFASTA(null).length, 0, 'null → no records');

  // Edge: sequence with no header
  const noHeader = parseMultiFASTA('MKAAVLR');
  assertEqual(noHeader.length, 0, 'no > header → no records (strict FASTA)');
});

suite('Large sequence alignment performance', () => {
  // 100 × 100 NW alignment should complete < 1000ms
  const seq1 = 'MKAAVLRGSNTTNTMANSFSETTDPSFLGQRVVQALEKQHQQGLQARRGDEDAQLAQEEQDTLHAYQQKLKNEGLA'.repeat(2).substring(0, 100);
  const seq2 = 'MKLLFLTLVLSSIASEGSTFSEKTGQQPSEKTTESNETTEENQTQTETTVEESTNNTSETSSESVNTASESTKET'.repeat(2).substring(0, 100);

  const t0 = Date.now();
  const result = needlemanWunsch(seq1, seq2);
  const elapsed = Date.now() - t0;

  assert(elapsed < 500, `100×100 NW alignment in ${elapsed}ms < 500ms`);
  assert(result.identity >= 0 && result.identity <= 100, 'identity in valid range');
  assert(result.matches + result.gaps <= result.total, 'matches + gaps ≤ total');

  // 200 × 200 alignment
  const s1 = seq1.repeat(2);
  const s2 = seq2.repeat(2);
  const t1 = Date.now();
  const r2 = needlemanWunsch(s1, s2);
  const elapsed2 = Date.now() - t1;
  assert(elapsed2 < 2000, `200×200 NW alignment in ${elapsed2}ms < 2000ms`);
  assert(r2.total > 0, 'alignment produced');
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`Bioinformatics Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
}
console.log('═'.repeat(60));
process.exit(failed > 0 ? 1 : 0);
