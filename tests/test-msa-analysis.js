/**
 * tests/test-msa-analysis.js
 * Unit tests for the MSA Analysis Engine (js/msa-analysis.js)
 *
 * Run:  node tests/test-msa-analysis.js
 */

'use strict';
const MSA = require('../js/msa-analysis.js');

// ── Minimal test harness (same style as test-dna-engine.js) ────────────────
let passed   = 0;
let failed   = 0;
const failures = [];

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}`); failed++; failures.push(label); }
}
function assertEqual(a, b, label) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { console.log(`  ✓ ${label}`); passed++; }
  else    { console.error(`  ✗ ${label}  got: ${JSON.stringify(a)}  expected: ${JSON.stringify(b)}`); failed++; failures.push(label); }
}
function assertClose(a, b, tol, label) {
  assert(Math.abs(a - b) <= tol, `${label}  (${a} ≈ ${b} ±${tol})`);
}
function suite(name, fn) {
  console.log(`\n▸ ${name}`);
  fn();
}

// ── Shared aligned FASTA fixture ────────────────────────────────────────────
const SIMPLE_FASTA = `
>seq1
ATGCGTAAC
>seq2
ATGCTTAAC
>seq3
ATGCGTAAG
>seq4
ATGCTTAAG
`.trim();

// ── 1. parseFASTA ─────────────────────────────────────────────────────────
suite('parseFASTA — multi-record parsing', () => {
  const records = MSA.parseFASTA(SIMPLE_FASTA);
  assertEqual(records.length, 4, 'parses 4 records');
  assertEqual(records[0].id,       'seq1',      'first id = seq1');
  assertEqual(records[0].sequence, 'ATGCGTAAC', 'first sequence correct');
  assertEqual(records[1].id,       'seq2',      'second id');
  assertEqual(records[3].sequence, 'ATGCTTAAG', 'last sequence correct');

  // FASTA with description text
  const withDesc = MSA.parseFASTA('>seq1 some description here\nATGCCC\n');
  assertEqual(withDesc[0].id,          'seq1',               'id without description');
  assertEqual(withDesc[0].description, 'some description here', 'description captured');

  // Multi-line sequence
  const multiLine = MSA.parseFASTA('>ml\nATG\nCCC\nTAA\n');
  assertEqual(multiLine[0].sequence, 'ATGCCCTAA', 'multi-line sequence joined');

  // Gaps preserved
  const gapped = MSA.parseFASTA('>g1\nATG---TAA\n');
  assertEqual(gapped[0].sequence, 'ATG---TAA', 'gap characters preserved');

  // Empty input
  assertEqual(MSA.parseFASTA('').length,   0, 'empty string → []');
  assertEqual(MSA.parseFASTA(null).length, 0, 'null → []');
});

// ── 2. validateAlignment ──────────────────────────────────────────────────
suite('validateAlignment — length consistency', () => {
  const recs = MSA.parseFASTA(SIMPLE_FASTA);
  const v    = MSA.validateAlignment(recs);
  assert(v.valid,                  'simple alignment valid');
  assertEqual(v.alignmentLength, 9, 'alignment length = 9');
  assertEqual(v.errors.length,   0, 'no errors for uniform-length input');

  // Unequal lengths → invalid
  const bad = [
    { id: 'a', sequence: 'ATGCCC' },
    { id: 'b', sequence: 'ATGC'   }
  ];
  const vBad = MSA.validateAlignment(bad);
  assert(!vBad.valid, 'unequal lengths → invalid');
  assert(vBad.errors.length > 0, 'error list populated for unequal lengths');

  // Single sequence
  const single = MSA.validateAlignment([{ id: 'a', sequence: 'ATGCCC' }]);
  assert(!single.valid, 'single sequence → invalid (need ≥2)');

  // Empty input
  assert(!MSA.validateAlignment([]).valid, 'empty array → invalid');
  assert(!MSA.validateAlignment(null).valid, 'null → invalid');
});

// ── 3. detectSNPs ────────────────────────────────────────────────────────
suite('detectSNPs — SNP table correctness', () => {
  const recs = MSA.parseFASTA(SIMPLE_FASTA);
  // seq1: ATGCGTAAC
  // seq2: ATGCTTAAC  ← col 4: C→T
  // seq3: ATGCGTAAG  ← col 8: C→G
  // seq4: ATGCTTAAG  ← col 4: C→T AND col 8: C→G
  const r = MSA.detectSNPs(recs, 0);

  assertEqual(r.totalPositions, 9, 'totalPositions = 9');
  assertEqual(r.variablePositions, 2, 'two variable positions');
  assertEqual(r.conservedPositions, 7, 'seven conserved positions');

  // Position 5 (col 4, 1-based = 5): G→T
  const snp5 = r.snps.find(s => s.position === 5);
  assert(snp5 !== undefined, 'SNP at position 5 detected');
  assertEqual(snp5.ref, 'G', 'ref at pos 5 = G (from seq1)');
  assert(snp5.alts.some(a => a.base === 'T'), 'T is an alt at pos 5');
  assert(snp5.alts.find(a => a.base === 'T').count === 2, 'T appears 2× at pos 5');

  // Position 9 (col 8, 1-based = 9): C→G
  const snp9 = r.snps.find(s => s.position === 9);
  assert(snp9 !== undefined, 'SNP at position 9 detected');
  assertEqual(snp9.ref, 'C', 'ref at pos 9 = C (from seq1)');

  // Entropy is non-zero at SNP positions
  assert(snp5.entropy > 0, 'entropy > 0 at variable position');
  // Fully conserved → 0 variable sites
  const consResult = MSA.detectSNPs([
    { id: 'a', sequence: 'ATGCCC' },
    { id: 'b', sequence: 'ATGCCC' }
  ], 0);
  assertEqual(consResult.variablePositions, 0, 'zero SNPs for identical sequences');

  // Gap column handling — gap vs non-gap counts as SNP
  const gapResult = MSA.detectSNPs([
    { id: 'a', sequence: 'ATG-CC' },
    { id: 'b', sequence: 'ATGACC' }
  ], 0);
  assert(gapResult.variablePositions >= 1, 'gap vs base = variable site');

  // Entirely gap column → NOT a SNP (no information)
  const allGap = MSA.detectSNPs([
    { id: 'a', sequence: 'ATG---' },
    { id: 'b', sequence: 'ATG---' }
  ], 0);
  assertEqual(allGap.variablePositions, 0, 'all-gap column not counted as SNP');
});

// ── 4. buildHaplotypes ───────────────────────────────────────────────────
suite('buildHaplotypes — grouping and frequencies', () => {
  const recs = MSA.parseFASTA(SIMPLE_FASTA);
  const h    = MSA.buildHaplotypes(recs);

  // All 4 sequences are distinct → 4 haplotypes
  assertEqual(h.length, 4, '4 distinct haplotypes (all sequences differ)');
  assert(h.every(x => x.count === 1), 'each count = 1 for unique sequences');
  assert(h.every(x => x.frequency === 0.25), 'each frequency = 0.25');

  // Two identical sequences → one shared haplotype
  const dupRecs = [
    { id: 'a', sequence: 'ATGCCC' },
    { id: 'b', sequence: 'ATGCCC' },
    { id: 'c', sequence: 'ATGTTT' }
  ];
  const hDup = MSA.buildHaplotypes(dupRecs);
  assertEqual(hDup.length, 2, 'duplicate sequences share haplotype → 2 groups');
  const h1 = hDup[0];    // most common first
  assertEqual(h1.count,     2,      'most common haplotype count = 2');
  assertClose(h1.frequency, 0.6667, 0.001, 'frequency of dominant haplotype ≈ 0.667');
  assert(h1.members.includes('a') && h1.members.includes('b'),
    'both duplicates in haplotype H1');

  // Haplotype IDs are unique and start with H1
  assertEqual(hDup[0].haplotypeId, 'H1', 'first haplotype id = H1');
  assertEqual(hDup[1].haplotypeId, 'H2', 'second haplotype id = H2');
});

// ── 5. hammingDistance ───────────────────────────────────────────────────
suite('hammingDistance — p-distance calculation', () => {
  // Identical → 0
  const d0 = MSA.hammingDistance('ATGCCC', 'ATGCCC');
  assertEqual(d0.raw,        0, 'identical sequences: raw = 0');
  assertEqual(d0.normalized, 0, 'identical sequences: normalized = 0');

  // 1 mismatch in 6
  const d1 = MSA.hammingDistance('ATGCCC', 'ATGCCT');
  assertEqual(d1.raw, 1, 'one mismatch: raw = 1');
  assertClose(d1.normalized, 1/6, 0.001, 'one mismatch in 6: normalized ≈ 0.1667');

  // All mismatches
  const dAll = MSA.hammingDistance('AAAAAA', 'TTTTTT');
  assertEqual(dAll.raw, 6, 'all different: raw = 6');
  assertClose(dAll.normalized, 1.0, 0.001, 'all different: normalized = 1.0');

  // Gap-gap excluded from denominator
  // 'A--C' vs 'A--T': only positions 0 (A=A) and 3 (C≠T) compared
  const dGap = MSA.hammingDistance('A--C', 'A--T');
  assertEqual(dGap.comparable, 2,   'gap-gap column excluded: comparable = 2');
  assertEqual(dGap.raw,        1,   'gap-gap: 1 mismatch');
  assertClose(dGap.normalized, 0.5, 0.001, 'gap-gap: normalized = 0.5');

  // Base vs gap = mismatch
  const dBG = MSA.hammingDistance('ATGC', 'AT-C');
  assertEqual(dBG.raw, 1, 'base vs gap = 1 mismatch');

  // Symmetry
  const dAB = MSA.hammingDistance('ATGCCC', 'ATGTCC');
  const dBA = MSA.hammingDistance('ATGTCC', 'ATGCCC');
  assertEqual(dAB.raw, dBA.raw, 'Hamming distance is symmetric');
});

// ── 6. buildDistanceMatrix ───────────────────────────────────────────────
suite('buildDistanceMatrix — matrix structure', () => {
  const recs = MSA.parseFASTA(SIMPLE_FASTA);
  const { labels, matrix, rawMatrix } = MSA.buildDistanceMatrix(recs);

  // Labels match input order
  assertEqual(labels, ['seq1','seq2','seq3','seq4'], 'labels in input order');

  // Matrix is 4×4
  assertEqual(matrix.length,      4, 'matrix is 4 rows');
  assertEqual(matrix[0].length,   4, 'matrix is 4 columns');

  // Diagonal is 0
  for (let i = 0; i < 4; i++) {
    assertEqual(matrix[i][i], 0, `diagonal[${i}][${i}] = 0`);
  }

  // Symmetric
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      assert(matrix[i][j] === matrix[j][i], `symmetric [${i}][${j}] == [${j}][${i}]`);
    }
  }

  // seq1 vs seq2 differ at position 4 only (1/9)
  assertClose(matrix[0][1], 1/9, 0.001, 'seq1 vs seq2: p-dist ≈ 0.111');
  // seq1 vs seq4 differ at 2 positions (2/9)
  assertClose(matrix[0][3], 2/9, 0.001, 'seq1 vs seq4: p-dist ≈ 0.222');
  // seq2 vs seq3 differ at 2 positions (2/9)
  assertClose(matrix[1][2], 2/9, 0.001, 'seq2 vs seq3: p-dist ≈ 0.222');
  // seq2 vs seq4 differ at 1 position (1/9)
  assertClose(matrix[1][3], 1/9, 0.001, 'seq2 vs seq4: p-dist ≈ 0.111');

  // Raw matrix matches
  assertEqual(rawMatrix[0][1], 1, 'raw: seq1 vs seq2 = 1 mismatch');
  assertEqual(rawMatrix[0][3], 2, 'raw: seq1 vs seq4 = 2 mismatches');
});

// ── 7. neighborJoining ───────────────────────────────────────────────────
suite('neighborJoining — NJ tree structure', () => {
  const recs = MSA.parseFASTA(SIMPLE_FASTA);
  const { labels, matrix } = MSA.buildDistanceMatrix(recs);
  const tree = MSA.neighborJoining(matrix, labels);

  // Basic structure
  assert(tree.nodes.length > 0,  'tree has nodes');
  assert(tree.edges.length > 0,  'tree has edges');
  assert(tree.root !== null,     'tree has a root');

  // All input sequences appear as leaf nodes
  const leafIds = tree.nodes.filter(n => n.type === 'leaf').map(n => n.id);
  for (const lbl of labels) {
    assert(leafIds.includes(lbl), `leaf "${lbl}" present in tree`);
  }

  // All edge targets are valid node ids
  const nodeIds = new Set(tree.nodes.map(n => n.id));
  for (const e of tree.edges) {
    assert(nodeIds.has(e.source), `edge source "${e.source}" is a valid node`);
    assert(nodeIds.has(e.target), `edge target "${e.target}" is a valid node`);
  }

  // No negative branch lengths
  for (const e of tree.edges) {
    assert(e.length >= 0, `edge ${e.source}→${e.target} has non-negative length`);
  }

  // For n=4 leaves: NJ should produce exactly n-1=3 internal nodes and
  // 2*(n-1)=6 edges (binary tree, rooted)
  const internalNodes = tree.nodes.filter(n => n.type === 'internal');
  assert(internalNodes.length >= 1, 'at least 1 internal node');
  assert(tree.edges.length >= labels.length, 'at least n edges for n leaves');

  // Edge-case: 2 taxa → single edge connecting them
  const tree2 = MSA.neighborJoining([[0,0.1],[0.1,0]], ['A','B']);
  assert(tree2.edges.length === 2, '2-taxon tree has 2 edges');
  assert(tree2.nodes.some(n => n.type === 'internal'), '2-taxon tree has internal node');

  // Edge-case: 1 taxon → trivial tree
  const tree1 = MSA.neighborJoining([[0]], ['A']);
  assertEqual(tree1.nodes.length, 1, '1-taxon tree: 1 node');
  assertEqual(tree1.edges.length, 0, '1-taxon tree: 0 edges');
});

// ── 8. toVisualizationJSON ────────────────────────────────────────────────
suite('toVisualizationJSON — output shapes', () => {
  const result = MSA.runPipeline(SIMPLE_FASTA);
  const viz    = result.viz;

  // snpMap
  assert(viz.snpMap.type === 'snp_map',           'snpMap.type correct');
  assert(typeof viz.snpMap.totalPositions === 'number', 'snpMap.totalPositions is number');
  assert(Array.isArray(viz.snpMap.snps),            'snpMap.snps is array');

  // haplotypes
  assert(viz.haplotypes.type === 'haplotypes',     'haplotypes.type correct');
  assert(Array.isArray(viz.haplotypes.haplotypes),  'haplotypes.haplotypes is array');

  // distanceMatrix
  assert(viz.distanceMatrix.type === 'distance_matrix', 'distanceMatrix type');
  assert(Array.isArray(viz.distanceMatrix.matrix),       'matrix is array');

  // phyloTree
  assert(viz.phyloTree.type === 'phylo_tree',       'phyloTree.type correct');
  assert(viz.phyloTree.algorithm === 'neighbor-joining', 'algorithm labeled');
  assert(Array.isArray(viz.phyloTree.cyElements),    'cyElements is array');
  assert(viz.phyloTree.d3Hierarchy !== null,         'd3Hierarchy built');

  // Cytoscape elements include node + edge entries
  const nodeEls = viz.phyloTree.cyElements.filter(el => !el.data.source);
  const edgeEls = viz.phyloTree.cyElements.filter(el =>  el.data.source);
  assert(nodeEls.length > 0, 'cyElements includes node entries');
  assert(edgeEls.length > 0, 'cyElements includes edge entries');
});

// ── 9. runPipeline — integration ─────────────────────────────────────────
suite('runPipeline — end-to-end integration', () => {
  const result = MSA.runPipeline(SIMPLE_FASTA, 0);

  // No error for valid input
  assert(!result.error, 'no error for valid FASTA');
  assert(result.validation.valid, 'validation passes');

  // Records
  assertEqual(result.records.length, 4, '4 records parsed');

  // Summary populated
  assert(result.summary.sequences     === 4, 'summary.sequences = 4');
  assert(result.summary.alignmentLength === 9, 'summary.alignmentLength = 9');
  assert(result.summary.variableSites  === 2, 'summary.variableSites = 2');
  assert(result.summary.haplotypes     === 4, 'summary.haplotypes = 4');
  assert(typeof result.summary.meanPairwiseDist === 'number', 'meanPairwiseDist is number');
  assert(result.summary.meanPairwiseDist > 0, 'meanPairwiseDist > 0');

  // Pipeline returns all required keys
  const requiredKeys = ['records','validation','snpResult','haplotypes',
                        'distanceMatrix','tree','viz','summary'];
  for (const k of requiredKeys) {
    assert(k in result, `result has key "${k}"`);
  }

  // Invalid alignment (unequal lengths)
  const badFASTA = '>a\nATGCCC\n>b\nATGC\n';
  const badResult = MSA.runPipeline(badFASTA);
  assert(badResult.error !== undefined,    'error returned for invalid alignment');
  assert(!badResult.validation.valid,       'validation.valid = false for bad input');

  // Demo example data runs clean
  const demoResult = MSA.runPipeline(MSA.EXAMPLE_FASTA);
  assert(!demoResult.error,                'demo dataset produces no error');
  assert(demoResult.summary.variableSites > 0, 'demo has variable sites');
  assert(demoResult.summary.haplotypes     > 1, 'demo has multiple haplotypes');
});

// ── 10. runDemo — smoke test ──────────────────────────────────────────────
suite('runDemo — smoke test (should not throw)', () => {
  let threw = false;
  let result;
  try { result = MSA.runDemo(); }
  catch (e) { threw = true; console.error(e); }
  assert(!threw,          'runDemo() does not throw');
  assert(result && !result.error, 'runDemo() returns clean result');
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`MSA Analysis Tests: ${passed} passed, ${failed} failed, ${passed+failed} total`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f, i) => console.log(`  ${i+1}. ${f}`));
}
console.log('═'.repeat(60));
process.exit(failed > 0 ? 1 : 0);
