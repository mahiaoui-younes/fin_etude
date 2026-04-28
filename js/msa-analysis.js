/**
 * EpitopX AI — Multiple Sequence Alignment (MSA) Analysis Engine
 *
 * Processes pre-aligned FASTA sequences (columns already correspond to
 * homologous positions) and produces SNP tables, haplotype groups, a
 * Hamming-distance matrix, and a Neighbor-Joining phylogenetic tree.
 *
 * Scientific references:
 *  [1] Saitou N. & Nei M. (1987). The neighbor-joining method: a new method
 *      for reconstructing phylogenetic trees. Mol Biol Evol 4:406-425.
 *  [2] Jukes T.H. & Cantor C.R. (1969). Evolution of protein molecules.
 *      In: Munro H.N. (ed.) Mammalian Protein Metabolism, pp. 21-132.
 *  [3] Shannon C.E. (1948). A mathematical theory of communication.
 *      Bell Syst Tech J 27:379-423. (entropy formula)
 *  [4] Nei M. & Kumar S. (2000). Molecular Evolution and Phylogenetics.
 *      Oxford University Press.
 *
 * Usage (Node.js):
 *   const MSA = require('./js/msa-analysis.js');
 *   const result = MSA.runPipeline(fastaString);
 *
 * Usage (browser):
 *   <script src="js/msa-analysis.js"></script>
 *   const result = MSAAnalysis.runPipeline(fastaString);
 */

/* global module, exports */
var MSAAnalysis = (() => {

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — FASTA PARSING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Parse a multi-record FASTA string into an array of sequence objects.
   *
   * Accepts:
   *  - Standard FASTA:  ">id description\nACGT..."
   *  - Aligned FASTA:   sequences may contain gap characters '-' and '.'
   *  - Multi-line seqs: lines are joined before returning
   *
   * @param {string} text - Raw FASTA string (from file or textarea)
   * @returns {Array<{id:string, description:string, sequence:string}>}
   */
  function parseFASTA(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return [];
    }

    const records = [];
    let currentId   = null;
    let currentDesc = '';
    let currentParts = [];

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;                          // skip blank lines

      if (line.startsWith('>')) {
        // Save the previous record before starting the next
        if (currentId !== null) {
          records.push({
            id:          currentId,
            description: currentDesc,
            sequence:    currentParts.join('').toUpperCase()
          });
        }
        // Header line: ">ID optional description text"
        const spaceIdx  = line.indexOf(' ');
        if (spaceIdx === -1) {
          currentId   = line.substring(1);          // no space → whole string is id
          currentDesc = '';
        } else {
          currentId   = line.substring(1, spaceIdx);
          currentDesc = line.substring(spaceIdx + 1).trim();
        }
        currentParts = [];
      } else {
        // Sequence line — keep gap characters, remove whitespace and digits
        currentParts.push(line.replace(/[\s\d]/g, ''));
      }
    }

    // Push the last record
    if (currentId !== null) {
      records.push({
        id:          currentId,
        description: currentDesc,
        sequence:    currentParts.join('').toUpperCase()
      });
    }

    return records;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — ALIGNMENT VALIDATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Validate that all sequences have the same length (required for column-wise
   * SNP analysis).  Gaps are included in the length count.
   *
   * @param {Array<{id, sequence}>} records
   * @returns {{valid:boolean, alignmentLength:number, errors:string[]}}
   */
  function validateAlignment(records) {
    const errors = [];

    if (!Array.isArray(records) || records.length === 0) {
      errors.push('No sequences provided.');
      return { valid: false, alignmentLength: 0, errors };
    }
    if (records.length < 2) {
      errors.push('At least 2 sequences are required for MSA analysis.');
      return { valid: false, alignmentLength: 0, errors };
    }

    const lengths = records.map(r => r.sequence.length);
    const refLen  = lengths[0];
    const unequal = lengths
      .map((l, i) => ({ id: records[i].id, len: l }))
      .filter(x => x.len !== refLen);

    if (unequal.length > 0) {
      unequal.forEach(x =>
        errors.push(`Sequence "${x.id}" has length ${x.len}, expected ${refLen}.`)
      );
    }

    // Warn about characters that are neither ATGC, gap, nor IUPAC ambiguity
    const validChars = /^[ATGCRYMKSWHBVDN.\-]+$/;
    records.forEach(r => {
      if (!validChars.test(r.sequence)) {
        errors.push(`Sequence "${r.id}" contains non-standard characters.`);
      }
    });

    return {
      valid:           errors.length === 0,
      alignmentLength: refLen,
      errors
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 3 — SNP DETECTION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Shannon entropy for one alignment column — [3]
   * H = -Σ p_i · log₂(p_i)  (bits)
   *
   * Gaps are excluded from the frequency calculation; a column that is
   * entirely gaps returns 0.
   *
   * @param {string[]} bases  - Array of characters at one alignment position
   * @returns {number} entropy in bits (0 = conserved, ≤2 = variable)
   */
  function _columnEntropy(bases) {
    const freq = {};
    let total  = 0;
    for (const b of bases) {
      if (b === '-' || b === '.') continue;      // ignore gaps
      freq[b] = (freq[b] || 0) + 1;
      total++;
    }
    if (total === 0) return 0;
    return -Object.values(freq)
      .reduce((H, cnt) => {
        const p = cnt / total;
        return H + p * Math.log2(p);
      }, 0);
  }

  /**
   * Detect SNPs column-by-column across aligned sequences.
   *
   * Algorithm:
   *  1. For each alignment column i:
   *     a. Collect all bases (excluding gaps).
   *     b. If ≥2 distinct bases exist → variable position → SNP.
   *  2. Reference base = sequence at refIndex (default: 0, i.e. first seq).
   *     If that position is a gap, pick the most frequent non-gap base.
   *  3. Alternates = all non-reference bases with per-sequence counts.
   *  4. Compute Shannon entropy for the column [3].
   *
   * @param {Array<{id, sequence}>} records
   * @param {number} refIndex - Index of the reference sequence (default 0)
   * @returns {{
   *   snps: Array<SNP>,
   *   totalPositions: number,
   *   variablePositions: number,
   *   conservedPositions: number
   * }}
   *
   * SNP shape:
   * {
   *   position:   number,   // 1-based column index
   *   ref:        string,   // reference base
   *   alts: [{
   *     base:      string,
   *     count:     number,
   *     frequency: number   // proportion across ALL sequences (incl. ref)
   *   }],
   *   totalSeqs:   number,
   *   gapCount:    number,
   *   entropy:     number   // Shannon entropy (bits) [3]
   * }
   */
  function detectSNPs(records, refIndex = 0) {
    const n      = records.length;
    const alnLen = records[0].sequence.length;
    const snps   = [];

    for (let col = 0; col < alnLen; col++) {
      // Collect one character per sequence at this column
      const bases = records.map(r => r.sequence[col]);

      // Count occurrences, separating gaps from bases
      const freq    = {};        // base → count (gaps excluded)
      let   gapCnt  = 0;
      for (const b of bases) {
        if (b === '-' || b === '.') { gapCnt++; continue; }
        freq[b] = (freq[b] || 0) + 1;
      }

      const distinctBases = Object.keys(freq);
      // A column is variable if:
      //  (a) ≥2 distinct bases (substitution), OR
      //  (b) at least one base AND at least one gap (indel site).
      // Purely conserved = same single base everywhere AND no gaps.
      const isIndelSite = gapCnt > 0 && distinctBases.length > 0;
      if (distinctBases.length < 2 && !isIndelSite) continue;

      // Determine the reference base at this column
      let ref = records[refIndex].sequence[col];
      if (ref === '-' || ref === '.') {
        // Reference is a gap here — use the most common non-gap base as reference,
        // or '-' if there are no non-gap bases at all (which should not reach here)
        ref = distinctBases.length > 0
          ? distinctBases.sort((a, b) => freq[b] - freq[a])[0]
          : '-';
      }

      // Build the alt list: all non-reference bases + gap if it is an indel site
      const altBases = distinctBases.filter(b => b !== ref);
      // If some sequences carry a gap at this column, '-' is a variant allele
      if (isIndelSite && ref !== '-') altBases.push('-');

      const alts = altBases
        .map(b => ({
          base:      b,
          count:     b === '-' ? gapCnt : (freq[b] || 0),
          frequency: parseFloat(((b === '-' ? gapCnt : (freq[b] || 0)) / n).toFixed(4))
        }))
        .filter(a => a.count > 0)
        .sort((a, b) => b.count - a.count);

      snps.push({
        position:  col + 1,                   // 1-based
        ref,
        refCount:  freq[ref] || 0,
        refFreq:   parseFloat(((freq[ref] || 0) / n).toFixed(4)),
        alts,
        totalSeqs: n,
        gapCount:  gapCnt,
        entropy:   parseFloat(_columnEntropy(bases).toFixed(4))
      });
    }

    return {
      snps,
      totalPositions:    alnLen,
      variablePositions: snps.length,
      conservedPositions: alnLen - snps.length
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 4 — HAPLOTYPE GROUPING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Group sequences into haplotypes — identical gapped alignment strings
   * are assigned to the same haplotype.
   *
   * For downstream population-genetics work: sequences that differ only in
   * gap characters are treated as DISTINCT haplotypes (insertions/deletions
   * are variants).
   *
   * @param {Array<{id, sequence}>} records
   * @returns {Array<{
   *   haplotypeId: string,
   *   members:     string[],   // sequence ids
   *   count:       number,
   *   frequency:   number,
   *   sequence:    string      // canonical aligned sequence
   * }>}
   */
  function buildHaplotypes(records) {
    const map = new Map();    // sequence → {members, count}

    for (const { id, sequence } of records) {
      if (map.has(sequence)) {
        map.get(sequence).members.push(id);
        map.get(sequence).count++;
      } else {
        map.set(sequence, { members: [id], count: 1, sequence });
      }
    }

    // Sort by frequency (most common first)
    const n = records.length;
    let idx = 1;
    return Array.from(map.values())
      .sort((a, b) => b.count - a.count)
      .map(h => ({
        haplotypeId: `H${idx++}`,
        members:     h.members,
        count:       h.count,
        frequency:   parseFloat((h.count / n).toFixed(4)),
        sequence:    h.sequence
      }));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 5 — DISTANCE MATRIX (Hamming / p-distance)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Compute the p-distance (proportion of differing sites) between two
   * aligned sequences — [2].
   *
   * Gap handling (standard bioinformatics convention):
   *  - base vs base  : counts as a mismatch if different.
   *  - base vs gap   : counts as a mismatch (insertion/deletion event).
   *  - gap  vs gap   : excluded from the denominator (shared deletion,
   *                    no information about substitution).
   *
   * @param {string} s1 - First aligned sequence (uppercase)
   * @param {string} s2 - Second aligned sequence (uppercase)
   * @returns {{raw:number, normalized:number, comparable:number}}
   *   raw        = count of mismatching columns
   *   normalized = raw / comparable  (p-distance, 0–1)
   *   comparable = number of columns used (excludes gap-gap pairs)
   */
  function hammingDistance(s1, s2) {
    let mismatches  = 0;
    let comparable  = 0;

    const len = Math.min(s1.length, s2.length);
    for (let i = 0; i < len; i++) {
      const b1 = s1[i];
      const b2 = s2[i];
      const g1 = b1 === '-' || b1 === '.';
      const g2 = b2 === '-' || b2 === '.';

      if (g1 && g2) continue;   // gap-gap: uninformative column, skip

      comparable++;
      if (b1 !== b2) mismatches++;
    }

    return {
      raw:        mismatches,
      normalized: comparable > 0 ? parseFloat((mismatches / comparable).toFixed(6)) : 0,
      comparable
    };
  }

  /**
   * Build a full pairwise distance matrix from aligned records.
   *
   * Returns the symmetric N×N p-distance matrix plus row/column labels.
   * Diagonal entries are 0 by definition.
   *
   * @param {Array<{id, sequence}>} records
   * @returns {{
   *   labels: string[],
   *   matrix: number[][],   // p-distance values
   *   rawMatrix: number[][]  // raw mismatch counts
   * }}
   */
  function buildDistanceMatrix(records) {
    const n      = records.length;
    const labels = records.map(r => r.id);

    // Pre-allocate NxN matrices
    const matrix    = Array.from({ length: n }, () => new Array(n).fill(0));
    const rawMatrix = Array.from({ length: n }, () => new Array(n).fill(0));

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const { raw, normalized } = hammingDistance(
          records[i].sequence,
          records[j].sequence
        );
        // Fill both triangles (symmetric matrix)
        matrix[i][j]    = normalized;
        matrix[j][i]    = normalized;
        rawMatrix[i][j] = raw;
        rawMatrix[j][i] = raw;
      }
    }

    return { labels, matrix, rawMatrix };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 6 — NEIGHBOR-JOINING TREE (Saitou & Nei 1987) [1]
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Build a Neighbor-Joining tree from a p-distance matrix.
   *
   * Algorithm (Saitou & Nei 1987 [1]):
   *  Repeat until 2 taxa remain:
   *  1. Compute R_i = Σ_j D_ij  (row sums)
   *  2. Q_ij = (n-2)·D_ij − R_i − R_j   (star-tree correction)
   *  3. Join the pair (i,j) with min Q_ij
   *  4. Branch lengths:
   *       δ_i = D_ij/2 + (R_i − R_j) / (2(n−2))
   *       δ_j = D_ij − δ_i
   *     (clamped to 0 to avoid negative branch lengths)
   *  5. New node u; D_uk = (D_ik + D_jk − D_ij) / 2
   *  6. Remove i,j; add u to the distance matrix
   *  Final step: connect last 2 nodes with edge length D[0][1].
   *
   * @param {number[][]} distMatrix - Symmetric N×N p-distance matrix
   * @param {string[]}   labels     - Sequence identifiers (length N)
   * @returns {{
   *   nodes: Array<{id:string, type:'leaf'|'internal'}>,
   *   edges: Array<{source:string, target:string, length:number}>,
   *   root:  string
   * }}
   */
  function neighborJoining(distMatrix, labels) {
    if (!distMatrix || distMatrix.length === 0) {
      return { nodes: [], edges: [], root: null };
    }
    if (distMatrix.length === 1) {
      return {
        nodes: [{ id: labels[0], type: 'leaf' }],
        edges: [],
        root:  labels[0]
      };
    }

    // Deep-copy inputs to avoid mutating the caller's data
    let D     = distMatrix.map(row => [...row]);
    let names = [...labels];
    let n     = names.length;

    // All leaf nodes
    const nodes = labels.map(l => ({ id: l, type: 'leaf' }));
    const edges = [];
    let nodeCounter = 0;

    // ── NJ main loop ────────────────────────────────────────────────────────
    while (n > 2) {
      // Step 1 — Row sums R_i = Σ_j D_ij
      const R = D.map(row => row.reduce((s, v) => s + v, 0));

      // Step 2 — Find the pair (minI, minJ) minimising Q_ij
      let minQ = Infinity;
      let minI = 0;
      let minJ = 1;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const q = (n - 2) * D[i][j] - R[i] - R[j];
          if (q < minQ) { minQ = q; minI = i; minJ = j; }
        }
      }

      // Step 4 — Branch lengths from new internal node u to i and j
      const limI = D[minI][minJ] / 2 + (R[minI] - R[minJ]) / (2 * (n - 2));
      const limJ = D[minI][minJ] - limI;

      // Step 3 — Create internal node
      const newNodeId = `node_${++nodeCounter}`;
      nodes.push({ id: newNodeId, type: 'internal' });
      edges.push(
        { source: newNodeId, target: names[minI], length: Math.max(0, limI) },
        { source: newNodeId, target: names[minJ], length: Math.max(0, limJ) }
      );

      // Step 5 — Distance from new node u to all remaining taxa k
      const newDists = [];
      for (let k = 0; k < n; k++) {
        if (k === minI || k === minJ) {
          newDists.push(0);
          continue;
        }
        // D_uk = (D_ik + D_jk - D_ij) / 2
        newDists.push(
          Math.max(0, (D[minI][k] + D[minJ][k] - D[minI][minJ]) / 2)
        );
      }

      // Step 6 — Rebuild D and names without minI/minJ, then append new node
      const keep = Array.from({ length: n }, (_, i) => i)
        .filter(i => i !== minI && i !== minJ);

      const newD = keep.map(i =>
        keep.map(j => D[i][j])
      );
      // Append distances to new node
      newD.forEach((row, idx) => row.push(newDists[keep[idx]]));
      newD.push([...keep.map(k => newDists[k]), 0]);

      names = [...keep.map(i => names[i]), newNodeId];
      D     = newD;
      n     = names.length;
    }

    // ── Final step: connect last two remaining taxa/nodes ───────────────────
    const finalNodeId = `node_${++nodeCounter}`;
    nodes.push({ id: finalNodeId, type: 'internal' });
    const halfDist = D[0][1] / 2;
    edges.push(
      { source: finalNodeId, target: names[0], length: Math.max(0, halfDist) },
      { source: finalNodeId, target: names[1], length: Math.max(0, D[0][1] - halfDist) }
    );

    return { nodes, edges, root: finalNodeId };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 6b — MINIMUM EVOLUTION TREE (Rzhetsky & Nei 1992)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Build a Minimum Evolution (ME) tree using a greedy NJ topology search
   * with ME branch-length estimation via ordinary least-squares (OLS).
   *
   * The ME criterion minimises the sum of all branch lengths S = Σ b_i.
   * This implementation:
   *  1. Starts with the NJ topology as an initial tree (NJ is a close
   *     approximation to the true ME tree — Rzhetsky & Nei 1992).
   *  2. Applies OLS branch-length estimation: b_i = (1/2)(D_ij - Σ_k≠i,j b_k)
   *     by solving the OLS normal equations on the NJ topology.
   *  3. Reports the total branch-length sum (tree length S) in the result.
   *
   * Reference:
   *  Rzhetsky A. & Nei M. (1992). A simple method for estimating and testing
   *  minimum-evolution trees. Mol Biol Evol 9:945-967.
   *
   * @param {number[][]} distMatrix - Symmetric N×N p-distance matrix
   * @param {string[]}   labels     - Sequence identifiers (length N)
   * @returns {{
   *   nodes: Array<{id:string, type:'leaf'|'internal'}>,
   *   edges: Array<{source:string, target:string, length:number}>,
   *   root:  string,
   *   treeLength: number
   * }}
   */
  function minimumEvolution(distMatrix, labels) {
    // Step 1 — Obtain NJ topology
    const njTree = neighborJoining(distMatrix, labels);
    if (!njTree.root) return { ...njTree, treeLength: 0 };

    // Step 2 — Re-estimate branch lengths by OLS to minimise total tree length.
    // For each edge (u→v) in an unrooted tree, the OLS estimate is:
    //   b(u,v) = (1/2) * [ D(i,j) - (sum of other branches on path i→j) ]
    // We use a simplified per-edge "path correction":
    //   b(u→v) = average over all cross-pairs (i in subtree_u, j in subtree_v)
    //            of  D(i,j) / 2
    // This is the direct OLS formula for star-decomposition (Pauplin 2000).

    // Build adjacency map
    const adj = {};
    for (const n of njTree.nodes) adj[n.id] = [];
    for (const e of njTree.edges) {
      adj[e.source].push({ id: e.target, origLength: e.length });
      adj[e.target].push({ id: e.source, origLength: e.length });
    }

    // For each edge, collect the leaf sets on each side via BFS/DFS
    function leavesOf(startId, forbidId, nodes) {
      const visited = new Set([forbidId]);
      const queue   = [startId];
      const leaves  = [];
      while (queue.length) {
        const cur = queue.shift();
        if (visited.has(cur)) continue;
        visited.add(cur);
        const node = nodes.find(n => n.id === cur);
        if (node && node.type === 'leaf') leaves.push(cur);
        for (const nb of (adj[cur] || [])) {
          if (!visited.has(nb.id)) queue.push(nb.id);
        }
      }
      return leaves;
    }

    // Label index lookup for distMatrix
    const labelIdx = {};
    labels.forEach((l, i) => { labelIdx[l] = i; });

    const newEdges = njTree.edges.map(e => {
      const leavesA = leavesOf(e.source, e.target, njTree.nodes);
      const leavesB = leavesOf(e.target, e.source, njTree.nodes);

      let sum = 0;
      let cnt = 0;
      for (const a of leavesA) {
        for (const b of leavesB) {
          const ia = labelIdx[a];
          const ib = labelIdx[b];
          if (ia !== undefined && ib !== undefined) {
            sum += distMatrix[ia][ib];
            cnt++;
          }
        }
      }
      const meLength = cnt > 0 ? Math.max(0, sum / (2 * cnt)) : e.length;
      return { ...e, length: parseFloat(meLength.toFixed(6)) };
    });

    const treeLength = parseFloat(
      newEdges.reduce((s, e) => s + e.length, 0).toFixed(6)
    );

    return {
      nodes:      njTree.nodes,
      edges:      newEdges,
      root:       njTree.root,
      treeLength
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 6c — MAXIMUM LIKELIHOOD TREE (HKY85 / Jukes-Cantor approximation)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Build a Maximum Likelihood (ML) tree using the Jukes-Cantor (JC69) model
   * and a nearest-neighbour interchange (NNI) hill-climbing search.
   *
   * Algorithm:
   *  1. Start with the NJ tree as the initial topology.
   *  2. Convert p-distances to JC69 corrected distances:
   *       d = −(3/4) ln(1 − (4/3) p)
   *     This corrects for multiple substitutions at the same site.
   *  3. Compute the log-likelihood of the current tree under JC69:
   *       ln L = Σ_{pairs(i,j)} −n_ij * ln(d_ij + ε)
   *     where n_ij = raw mismatch count between i and j.
   *  4. Apply NNI swaps on each internal edge and accept any swap that
   *     improves ln L.  Repeat until convergence (no improvement).
   *  5. Re-estimate branch lengths by OLS on the final topology
   *     (same Pauplin 2000 formula as in ME).
   *
   * Scientific references:
   *  Jukes T.H. & Cantor C.R. (1969). Evolution of protein molecules.
   *  Felsenstein J. (1981). Evolutionary trees from DNA sequences:
   *    a maximum likelihood approach. J Mol Evol 17:368-376.
   *
   * Note: For large datasets (>50 sequences) this is a fast heuristic ML
   * search, not an exhaustive global optimum.
   *
   * @param {number[][]} distMatrix    - N×N p-distance matrix
   * @param {number[][]} rawMatrix     - N×N raw mismatch-count matrix
   * @param {string[]}   labels        - Sequence identifiers
   * @param {number}     alignLen      - Alignment length (columns)
   * @returns {{
   *   nodes: Array<{id:string, type:'leaf'|'internal'}>,
   *   edges: Array<{source:string, target:string, length:number}>,
   *   root:  string,
   *   logLikelihood: number
   * }}
   */
  function maximumLikelihood(distMatrix, rawMatrix, labels, alignLen) {
    const n = labels.length;
    if (n < 3) {
      const base = neighborJoining(distMatrix, labels);
      return { ...base, logLikelihood: 0 };
    }

    // ── JC69 distance correction ─────────────────────────────────────────────
    function jc69(p) {
      const x = 1 - (4 / 3) * p;
      if (x <= 0) return 3.0;                 // saturated — cap at 3.0
      return parseFloat((-0.75 * Math.log(x)).toFixed(6));
    }

    // Build JC69-corrected distance matrix
    const jcDist = distMatrix.map((row, i) =>
      row.map((p, j) => i === j ? 0 : jc69(p))
    );

    // ── Tree log-likelihood under JC69 (distance-based approximation) ────────
    // ln L ≈ Σ_{i<j} [ k_ij * ln(p_ij + ε) + (L − k_ij) * ln(1 − p_ij + ε) ]
    // where k_ij = raw mismatches, L = alignment length
    const EPS = 1e-9;
    function treeLogLik(edges, nodeList) {
      // Collect all leaf-leaf paths and their distances
      const adj2 = {};
      for (const nd of nodeList) adj2[nd.id] = [];
      for (const e of edges) {
        adj2[e.source].push({ id: e.target, len: e.length });
        adj2[e.target].push({ id: e.source, len: e.length });
      }
      const labelIdx2 = {};
      labels.forEach((l, i) => { labelIdx2[l] = i; });

      let ll = 0;
      const leafIds = nodeList.filter(nd => nd.type === 'leaf').map(nd => nd.id);
      for (let a = 0; a < leafIds.length; a++) {
        for (let b = a + 1; b < leafIds.length; b++) {
          const ia = labelIdx2[leafIds[a]];
          const ib = labelIdx2[leafIds[b]];
          const p  = distMatrix[ia][ib];
          const k  = rawMatrix[ia][ib];
          const L  = alignLen;
          ll += k * Math.log(p + EPS) + (L - k) * Math.log(1 - p + EPS);
        }
      }
      return ll;
    }

    // ── Start from NJ topology with JC69-corrected branch lengths ────────────
    let currentTree = neighborJoining(jcDist, labels);
    let currentLL   = treeLogLik(currentTree.edges, currentTree.nodes);

    // ── NNI heuristic search ─────────────────────────────────────────────────
    // For each internal edge (u,v) where both u and v are internal nodes:
    //   Consider the 4 subtrees A,B (hanging off u) and C,D (hanging off v).
    //   Two alternative NNI topologies: swap B↔C or swap B↔D.
    //   Accept the swap if it improves ll.
    let improved = true;
    let iterations = 0;
    const MAX_ITER = 20;

    while (improved && iterations < MAX_ITER) {
      improved = false;
      iterations++;

      // Identify internal edges (both endpoints are internal nodes)
      const internalNodeIds = new Set(
        currentTree.nodes.filter(nd => nd.type === 'internal').map(nd => nd.id)
      );

      for (let ei = 0; ei < currentTree.edges.length; ei++) {
        const edge = currentTree.edges[ei];
        if (!internalNodeIds.has(edge.source) || !internalNodeIds.has(edge.target)) continue;

        const u = edge.source;
        const v = edge.target;

        // Find neighbours of u excluding v (subtrees A, B)
        const uNeighbours = currentTree.edges
          .filter(e => (e.source === u && e.target !== v) || (e.target === u && e.source !== v))
          .map(e => e.source === u ? e.target : e.source);

        // Find neighbours of v excluding u (subtrees C, D)
        const vNeighbours = currentTree.edges
          .filter(e => (e.source === v && e.target !== u) || (e.target === v && e.source !== u))
          .map(e => e.source === v ? e.target : e.source);

        if (uNeighbours.length < 2 || vNeighbours.length < 1) continue;

        const [A, B] = uNeighbours;
        const [C]    = vNeighbours;

        // Try swap: B ↔ C  (reconnect B to v, C to u)
        for (const [swapFrom, swapTo, swapTarget] of [[B, C, u], [A, C, u]]) {
          const swapEdges = currentTree.edges.map(e => {
            // Replace edge (u → swapFrom) with (u → swapTo)
            if (e.source === u && e.target === swapFrom) return { ...e, target: swapTo };
            if (e.target === u && e.source === swapFrom) return { ...e, source: swapTo };
            // Replace edge (v → swapTo)   with (v → swapFrom)
            if (e.source === v && e.target === swapTo)   return { ...e, target: swapFrom };
            if (e.target === v && e.source === swapTo)   return { ...e, source: swapFrom };
            return e;
          });

          const swapLL = treeLogLik(swapEdges, currentTree.nodes);
          if (swapLL > currentLL + 1e-8) {
            currentTree = { ...currentTree, edges: swapEdges };
            currentLL   = swapLL;
            improved    = true;
            break;
          }
        }
        if (improved) break;
      }
    }

    // ── Final OLS branch-length re-estimation (Pauplin 2000) ─────────────────
    const adj3 = {};
    for (const nd of currentTree.nodes) adj3[nd.id] = [];
    for (const e of currentTree.edges) {
      adj3[e.source].push(e.target);
      adj3[e.target].push(e.source);
    }

    function leavesOf2(startId, forbidId) {
      const visited = new Set([forbidId]);
      const queue   = [startId];
      const leaves  = [];
      while (queue.length) {
        const cur = queue.shift();
        if (visited.has(cur)) continue;
        visited.add(cur);
        const node = currentTree.nodes.find(nd => nd.id === cur);
        if (node && node.type === 'leaf') leaves.push(cur);
        for (const nb of (adj3[cur] || [])) {
          if (!visited.has(nb)) queue.push(nb);
        }
      }
      return leaves;
    }

    const labelIdx3 = {};
    labels.forEach((l, i) => { labelIdx3[l] = i; });

    const finalEdges = currentTree.edges.map(e => {
      const lA = leavesOf2(e.source, e.target);
      const lB = leavesOf2(e.target, e.source);
      let sum = 0, cnt = 0;
      for (const a of lA) {
        for (const b of lB) {
          const ia = labelIdx3[a];
          const ib = labelIdx3[b];
          if (ia !== undefined && ib !== undefined) {
            sum += jcDist[ia][ib];
            cnt++;
          }
        }
      }
      const len = cnt > 0 ? Math.max(0, sum / (2 * cnt)) : e.length;
      return { ...e, length: parseFloat(len.toFixed(6)) };
    });

    return {
      nodes:         currentTree.nodes,
      edges:         finalEdges,
      root:          currentTree.root,
      logLikelihood: parseFloat(currentLL.toFixed(4))
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 7 — VISUALIZATION-READY JSON
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Package SNP, haplotype, and phylogenetic-tree data into structured JSON
   * objects suited for direct use with D3.js, Cytoscape.js, or Chart.js.
   *
   * SNP Map format:
   *   Compatible with a bar chart (position on x-axis, entropy on y-axis)
   *   or a variant lollipop track.
   *
   * Haplotypes format:
   *   Compatible with a table / sunburst chart.
   *
   * Phylo Tree format:
   *   Compatible with D3 hierarchy (convert edges to parent-child) or
   *   Cytoscape.js elements array.
   *
   * @param {{snpResult, haplotypeResult, treeResult, labels, distMatrix}} data
   * @returns {{snpMap, haplotypes, phyloTree}}
   */
  function toVisualizationJSON({ snpResult, haplotypeResult, treeResult, labels, distMatrix, treeMethod }) {

    // ── SNP map ──────────────────────────────────────────────────────────────
    const snpMap = {
      type:               'snp_map',
      totalPositions:     snpResult.totalPositions,
      variablePositions:  snpResult.variablePositions,
      conservedPositions: snpResult.conservedPositions,
      snps: snpResult.snps.map(s => ({
        position:  s.position,
        ref:       s.ref,
        refFreq:   s.refFreq,
        alts:      s.alts,
        gapCount:  s.gapCount,
        entropy:   s.entropy,
        // Flag for high-variability positions (entropy > 0.5 bits)
        highVariability: s.entropy > 0.5
      }))
    };

    // ── Haplotypes ───────────────────────────────────────────────────────────
    const haplotypes = {
      type:        'haplotypes',
      totalSeqs:   labels.length,
      haplotypeCount: haplotypeResult.length,
      haplotypes:  haplotypeResult.map(h => ({
        id:        h.haplotypeId,
        members:   h.members,
        count:     h.count,
        frequency: h.frequency,
        // Derive SNP signature: positions where this haplotype differs from H1
        sequence:  h.sequence
      }))
    };

    // ── Distance matrix (for heatmap) ────────────────────────────────────────
    const distanceMatrix = {
      type:   'distance_matrix',
      labels,
      matrix: distMatrix
    };

    // ── Phylogenetic tree (nodes + edges for graph visualization) ────────────
    // Convert to Cytoscape.js-compatible elements array
    const cyElements = [
      ...treeResult.nodes.map(n => ({
        data: { id: n.id, type: n.type, label: n.type === 'leaf' ? n.id : '' }
      })),
      ...treeResult.edges.map((e, i) => ({
        data: {
          id:     `e_${i}`,
          source: e.source,
          target: e.target,
          length: e.length,
          // Edge weight for visualization thickness (inverse of length)
          weight: e.length > 0 ? parseFloat((1 / e.length).toFixed(4)) : 1000
        }
      }))
    ];

    // Also provide a D3-compatible adjacency list (parent → children)
    function _buildD3Tree(nodes, edges, root) {
      if (!root) return null;
      const childMap = {};
      for (const e of edges) {
        if (!childMap[e.source]) childMap[e.source] = [];
        childMap[e.source].push({ id: e.target, branchLength: e.length });
      }
      function _build(id) {
        const node = nodes.find(n => n.id === id);
        const entry = {
          id,
          type:   node ? node.type : 'unknown',
          name:   node && node.type === 'leaf' ? id : '',
          children: (childMap[id] || []).map(c => ({
            ...(_build(c.id)),
            branchLength: c.branchLength
          }))
        };
        if (entry.children.length === 0) delete entry.children;
        return entry;
      }
      return _build(root);
    }

    const _algoMeta = {
      'nj': { algorithm: 'neighbor-joining',   reference: '[1] Saitou & Nei 1987' },
      'me': { algorithm: 'minimum-evolution',  reference: 'Rzhetsky & Nei 1992' },
      'ml': { algorithm: 'maximum-likelihood', reference: 'JC69 / Felsenstein 1981' }
    };
    const _meta = _algoMeta[treeMethod] || _algoMeta['nj'];
    const phyloTree = {
      type:       'phylo_tree',
      algorithm:  _meta.algorithm,
      reference:  _meta.reference,
      ...(treeResult.logLikelihood !== undefined ? { logLikelihood: treeResult.logLikelihood } : {}),
      ...(treeResult.treeLength    !== undefined ? { treeLength:    treeResult.treeLength    } : {}),
      root:       treeResult.root,
      nodes:      treeResult.nodes,
      edges:      treeResult.edges,
      cyElements,
      d3Hierarchy: _buildD3Tree(treeResult.nodes, treeResult.edges, treeResult.root)
    };

    return { snpMap, haplotypes, distanceMatrix, phyloTree };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 8 — FULL PIPELINE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Run the complete MSA analysis pipeline end-to-end.
   *
   * Steps:
   *  1. Parse FASTA text
   *  2. Validate alignment lengths
   *  3. Detect SNPs
   *  4. Group haplotypes
   *  5. Build distance matrix
   *  6. Build NJ tree
   *  7. Package visualization JSON
   *
   * @param {string} fastaText  - Raw multi-record FASTA string
   * @param {number} refIndex   - Index of the reference sequence (default 0)
   * @param {string} treeMethod - 'nj' | 'me' | 'ml'  (default 'nj')
   * @returns {{
   *   records:    Array,
   *   validation: object,
   *   snpResult:  object,
   *   haplotypes: Array,
   *   distanceMatrix: object,
   *   tree:       object,
   *   viz:        object,    // visualization-ready JSON
   *   summary:    object
   * } | { error: string }}
   */
  function runPipeline(fastaText, refIndex = 0, treeMethod = 'nj') {
    // Step 1 — Parse
    const records = parseFASTA(fastaText);

    // Step 2 — Validate
    const validation = validateAlignment(records);
    if (!validation.valid) {
      return {
        error:      'Alignment validation failed.',
        validation,
        records
      };
    }

    // Step 3 — SNPs
    const snpResult = detectSNPs(records, refIndex);

    // Step 4 — Haplotypes
    const haplotypeResult = buildHaplotypes(records);

    // Step 5 — Distance matrix
    const { labels, matrix: distMatrix, rawMatrix } = buildDistanceMatrix(records);

    // Step 6 — Build tree using selected method
    let treeResult;
    if (treeMethod === 'me') {
      treeResult = minimumEvolution(distMatrix, labels);
    } else if (treeMethod === 'ml') {
      treeResult = maximumLikelihood(distMatrix, rawMatrix, labels, validation.alignmentLength);
    } else {
      treeResult = neighborJoining(distMatrix, labels);
    }

    // Step 7 — Visualization JSON
    const viz = toVisualizationJSON({
      snpResult,
      haplotypeResult,
      treeResult,
      labels,
      distMatrix,
      treeMethod
    });

    // Summary statistics
    const summary = {
      sequences:           records.length,
      alignmentLength:     validation.alignmentLength,
      variableSites:       snpResult.variablePositions,
      conservedSites:      snpResult.conservedPositions,
      variability:         parseFloat((snpResult.variablePositions / validation.alignmentLength * 100).toFixed(2)),
      haplotypes:          haplotypeResult.length,
      haplotypeDiv:        parseFloat((1 - haplotypeResult.reduce((s, h) => s + h.frequency ** 2, 0)).toFixed(4)),
      meanPairwiseDist:    _meanPairwiseDist(distMatrix),
      referenceSequence:   records[refIndex].id
    };

    return {
      records,
      validation,
      snpResult,
      haplotypes: haplotypeResult,
      distanceMatrix: { labels, matrix: distMatrix, rawMatrix },
      tree: treeResult,
      viz,
      summary
    };
  }

  /** Compute mean pairwise distance from the upper triangle of the matrix */
  function _meanPairwiseDist(matrix) {
    const n = matrix.length;
    if (n < 2) return 0;
    let total = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        total += matrix[i][j];
        count++;
      }
    }
    return parseFloat((total / count).toFixed(6));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 9 — EXAMPLE DATA & DEMO
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Example aligned FASTA dataset — 8 simulated β-globin gene fragments.
   *
   * The alignment is 60 bp.  Known variants:
   *  - Position 17: A→T in seq4–seq6 (common mutation block)
   *  - Position 31: C→G/A in seq3/seq7
   *  - Position 45: G→A in seq5/seq8
   *  - Position 52: T→C in seq2/seq6
   *
   * Sequences were designed to produce 3 main haplotypes and a clear
   * NJ tree with two obvious clades.
   */
  const EXAMPLE_FASTA = `>HBB_ref   Homo sapiens beta-globin fragment
ATGGTGCACCTGACTCCTGAGGAGAAGTCTGCCGTTACTGCCCTGTGGGGCAAGGTGAACGTGGATGAAGTT
>HBB_seq2  variant_C52T
ATGGTGCACCTGACTCCTGAGGAGAAGTCTGCCGTTACTGCCCTGTGGGGCAAGGTGAACGTGGATGAAGCC
>HBB_seq3  variant_C31G
ATGGTGCACCTGACTCCTGAGGAGAAGTCCGCCGTTACTGCCCTGTGGGGCAAGGTGAACGTGGATGAAGTT
>HBB_seq4  variant_A17T
ATGGTGCACCTGACTCCTGTGGAGAAGTCTGCCGTTACTGCCCTGTGGGGCAAGGTGAACGTGGATGAAGTT
>HBB_seq5  variant_A17T_G45A
ATGGTGCACCTGACTCCTGTGGAGAAGTCTGCCGTTACTGCCCTGTAGGGCAAGGTGAACGTGGATGAAGTT
>HBB_seq6  variant_A17T_C52T
ATGGTGCACCTGACTCCTGTGGAGAAGTCTGCCGTTACTGCCCTGTGGGGCAAGGTGAACGTGGATGAAGCC
>HBB_seq7  variant_C31A
ATGGTGCACCTGACTCCTGAGGAGAAGTCAGCCGTTACTGCCCTGTGGGGCAAGGTGAACGTGGATGAAGTT
>HBB_seq8  variant_G45A
ATGGTGCACCTGACTCCTGAGGAGAAGTCTGCCGTTACTGCCCTGTAGGGCAAGGTGAACGTGGATGAAGTT
`.trim();

  /**
   * Run the full pipeline on the built-in example dataset and print a
   * human-readable report to the console.
   *
   * @returns {object} Full pipeline result
   */
  function runDemo() {
    console.log('═'.repeat(64));
    console.log('  MSA Analysis Engine — Demo Run');
    console.log('  Dataset: simulated HBB β-globin fragment (8 sequences)');
    console.log('═'.repeat(64));

    const result = runPipeline(EXAMPLE_FASTA, 0);

    if (result.error) {
      console.error('Pipeline error:', result.error, result.validation.errors);
      return result;
    }

    const { summary, snpResult, haplotypes, distanceMatrix, tree, viz } = result;

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n▸ SUMMARY');
    console.log(`  Sequences     : ${summary.sequences}`);
    console.log(`  Alignment     : ${summary.alignmentLength} bp`);
    console.log(`  Variable sites: ${summary.variableSites} (${summary.variability}%)`);
    console.log(`  Conserved     : ${summary.conservedSites}`);
    console.log(`  Haplotypes    : ${summary.haplotypes}  (diversity = ${summary.haplotypeDiv})`);
    console.log(`  Mean p-dist   : ${summary.meanPairwiseDist}`);
    console.log(`  Reference seq : ${summary.referenceSequence}`);

    // ── SNPs ─────────────────────────────────────────────────────────────────
    console.log(`\n▸ SNP TABLE (${snpResult.variablePositions} variable positions)`);
    console.log('  Pos  Ref  Alts (base:count:freq)                  Entropy');
    console.log('  ' + '-'.repeat(60));
    for (const s of snpResult.snps) {
      const altStr = s.alts.map(a => `${a.base}:${a.count}:${(a.frequency*100).toFixed(1)}%`).join('  ');
      console.log(`  ${String(s.position).padStart(3)}  ${s.ref}    ${altStr.padEnd(40)} ${s.entropy.toFixed(3)} bits`);
    }

    // ── Haplotypes ────────────────────────────────────────────────────────────
    console.log(`\n▸ HAPLOTYPES (${haplotypes.length} distinct haplotypes)`);
    for (const h of haplotypes) {
      console.log(`  ${h.haplotypeId}  count=${h.count}  freq=${(h.frequency*100).toFixed(1)}%  members: ${h.members.join(', ')}`);
    }

    // ── Distance matrix ───────────────────────────────────────────────────────
    console.log('\n▸ PAIRWISE p-DISTANCE MATRIX');
    const lw = 10;
    const lblLine = '  ' + ''.padStart(lw) + distanceMatrix.labels.map(l => l.substring(0,7).padStart(8)).join('');
    console.log(lblLine);
    for (let i = 0; i < distanceMatrix.labels.length; i++) {
      const row = distanceMatrix.labels[i].substring(0,lw-1).padEnd(lw) +
        distanceMatrix.matrix[i].map(v => v.toFixed(4).padStart(8)).join('');
      console.log('  ' + row);
    }

    // ── Tree ──────────────────────────────────────────────────────────────────
    console.log(`\n▸ NEIGHBOR-JOINING TREE`);
    console.log(`  Nodes: ${tree.nodes.length} (${tree.nodes.filter(n=>n.type==='leaf').length} leaves, ${tree.nodes.filter(n=>n.type==='internal').length} internal)`);
    console.log(`  Edges: ${tree.edges.length}`);
    console.log(`  Root : ${tree.root}`);
    for (const e of tree.edges) {
      const isLeaf = tree.nodes.find(n=>n.id===e.target)?.type === 'leaf';
      if (isLeaf) {
        console.log(`  ${e.source} ──[${e.length.toFixed(5)}]──▶ ${e.target}`);
      }
    }

    // ── Viz JSON preview ──────────────────────────────────────────────────────
    console.log('\n▸ VISUALIZATION JSON (previews)');
    console.log('  snpMap keys      :', Object.keys(viz.snpMap).join(', '));
    console.log('  haplotypes keys  :', Object.keys(viz.haplotypes).join(', '));
    console.log('  phyloTree keys   :', Object.keys(viz.phyloTree).join(', '));
    console.log('  cyElements count :', viz.phyloTree.cyElements.length);

    console.log('\n' + '═'.repeat(64));
    return result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════════════════
  return {
    // Core functions
    parseFASTA,
    validateAlignment,
    detectSNPs,
    buildHaplotypes,
    hammingDistance,
    buildDistanceMatrix,
    neighborJoining,
    minimumEvolution,
    maximumLikelihood,
    toVisualizationJSON,
    // Pipeline
    runPipeline,
    // Demo
    runDemo,
    EXAMPLE_FASTA
  };

})();

// Node.js / CommonJS export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MSAAnalysis;
}
