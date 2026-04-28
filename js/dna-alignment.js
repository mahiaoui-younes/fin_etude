/**
 * dna-alignment.js — Multiple DNA Sequence Alignment
 * EpitopX AI — Structural Bioinformatics Platform
 *
 * Algorithms available:
 *   1. "local"  — Remote API: https://a381-41-98-106-109.ngrok-free.app/msa/align/
 *                 (proxied via /api/alignment/msa/align/)
 *   2. "nw"     — Needleman-Wunsch global alignment (client-side, star strategy)
 *   3. "star"   — Star alignment using NW as pairwise kernel (client-side)
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════
     ── API Configuration ─────────────────────────────────────────────
     Proxied through server.js /api/alignment/* → ngrok backend.
  ═══════════════════════════════════════════════════════════════════ */
  const ALIGNMENT_API_URL = '/api/msa/align/';

  /* ═══════════════════════════════════════════════════════════════════
     ── Constants ────────────────────────────────────────────────────
  ═══════════════════════════════════════════════════════════════════ */
  const SEQ_COLORS = [
    '#2563eb','#0d9488','#7c3aed','#db2777','#ea580c',
    '#16a34a','#0284c7','#9333ea','#b45309','#0f766e',
  ];

  const BLOCK_WIDTH = 60; // nucleotides per display block

  /* ═══════════════════════════════════════════════════════════════════
     ── State ────────────────────────────────────────────────────────
  ═══════════════════════════════════════════════════════════════════ */
  let parsedSeqs   = [];   // [{ id, seq }]
  let alignedSeqs  = [];   // [{ id, aligned }]  ← gap-padded
  let currentBlock = 0;
  let totalBlocks  = 0;

  /* ═══════════════════════════════════════════════════════════════════
     ── FASTA PARSER ─────────────────────────────────────────────────
  ═══════════════════════════════════════════════════════════════════ */
  function parseFasta(text) {
    const records = [];
    let current = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('>')) {
        if (current) records.push(current);
        current = { id: line.slice(1).trim() || ('Seq' + (records.length + 1)), seq: '' };
      } else if (current) {
        // Accept DNA / RNA chars + ambiguity codes
        current.seq += line.toUpperCase().replace(/[^ATGCURYMKSWHBVDN]/g, '');
      }
    }
    if (current && current.seq) records.push(current);
    return records;
  }

  /* ═══════════════════════════════════════════════════════════════════
     ── NEEDLEMAN-WUNSCH (global pairwise) ───────────────────────────
  ═══════════════════════════════════════════════════════════════════ */
  function needlemanWunsch(seqA, seqB, match, mismatch, gapOpen) {
    const m = seqA.length, n = seqB.length;
    // DP matrix
    const score = [];
    for (let i = 0; i <= m; i++) {
      score[i] = new Int32Array(n + 1);
    }
    for (let i = 0; i <= m; i++) score[i][0] = i * gapOpen;
    for (let j = 0; j <= n; j++) score[0][j] = j * gapOpen;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const diag = score[i-1][j-1] + (seqA[i-1] === seqB[j-1] ? match : mismatch);
        const up   = score[i-1][j] + gapOpen;
        const left = score[i][j-1] + gapOpen;
        score[i][j] = Math.max(diag, up, left);
      }
    }

    // Traceback
    let alignA = '', alignB = '';
    let i = m, j = n;
    while (i > 0 && j > 0) {
      const s = score[i][j];
      if (s === score[i-1][j-1] + (seqA[i-1] === seqB[j-1] ? match : mismatch)) {
        alignA = seqA[i-1] + alignA;
        alignB = seqB[j-1] + alignB;
        i--; j--;
      } else if (s === score[i-1][j] + gapOpen) {
        alignA = seqA[i-1] + alignA;
        alignB = '-' + alignB;
        i--;
      } else {
        alignA = '-' + alignA;
        alignB = seqB[j-1] + alignB;
        j--;
      }
    }
    while (i > 0) { alignA = seqA[i-1] + alignA; alignB = '-' + alignB; i--; }
    while (j > 0) { alignA = '-' + alignA; alignB = seqB[j-1] + alignB; j--; }

    return { alignA, alignB, score: score[m][n] };
  }

  /* ═══════════════════════════════════════════════════════════════════
     ── STAR ALIGNMENT (multiple sequences via star strategy) ────────
     Centre = sequence with highest pairwise sum-of-scores.
  ═══════════════════════════════════════════════════════════════════ */
  function starAlignment(seqs, match, mismatch, gapOpen) {
    if (seqs.length === 1) return [{ id: seqs[0].id, aligned: seqs[0].seq }];
    if (seqs.length === 2) {
      const { alignA, alignB } = needlemanWunsch(seqs[0].seq, seqs[1].seq, match, mismatch, gapOpen);
      return [
        { id: seqs[0].id, aligned: alignA },
        { id: seqs[1].id, aligned: alignB },
      ];
    }

    // Find centre sequence (highest total pairwise score)
    const n = seqs.length;
    const totals = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const { score } = needlemanWunsch(seqs[i].seq, seqs[j].seq, match, mismatch, gapOpen);
        totals[i] += score;
        totals[j] += score;
      }
    }
    const centreIdx = totals.indexOf(Math.max(...totals));

    // Align every sequence against centre
    const centreSeq = seqs[centreIdx].seq;
    const pairAligns = seqs.map((s, idx) => {
      if (idx === centreIdx) return { centre: s.seq, other: s.seq };
      const { alignA, alignB } = needlemanWunsch(centreSeq, s.seq, match, mismatch, gapOpen);
      return { centre: alignA, other: alignB };
    });

    // Merge gap columns: propagate gaps introduced in centre across all others
    const alignLen = pairAligns[centreIdx].centre.length;

    // Build a common gap-merged centre from all pairwise centres
    // We need to reconcile gap positions across different pairwise alignments
    // Use simple column-by-column merging
    const mergedAligns = mergeStarAlignments(pairAligns, centreIdx);

    return seqs.map((s, idx) => ({ id: s.id, aligned: mergedAligns[idx] }));
  }

  function mergeStarAlignments(pairAligns, centreIdx) {
    // Each pairAligns[i] = { centre: gapped-centre, other: gapped-other }
    // We need to reconcile gaps in the centres across all pairs
    const n = pairAligns.length;

    // Start with the centre's alignment from the first non-centre pair
    let refCentre = null;
    for (let i = 0; i < n; i++) {
      if (i !== centreIdx) { refCentre = pairAligns[i].centre; break; }
    }
    if (!refCentre) {
      // only the centre itself (n==1 handled above)
      return [pairAligns[centreIdx].other];
    }

    // Progressively merge gap columns
    let masterCentre = refCentre.split('');
    const masterOthers = new Array(n).fill(null).map(() => []);

    // Reconstruct others from pairAligns relative to refCentre
    for (let seqIdx = 0; seqIdx < n; seqIdx++) {
      if (seqIdx === centreIdx) {
        // Centre sequence itself — copy without gaps
        masterOthers[seqIdx] = masterCentre.slice();
        continue;
      }
      const pc = pairAligns[seqIdx].centre.split('');
      const po = pairAligns[seqIdx].other.split('');

      // Map centre residues to masterCentre positions
      let masterPos = 0;
      let pairPos   = 0;
      const mapped  = [];

      while (pairPos < pc.length && masterPos < masterCentre.length) {
        const mc = masterCentre[masterPos];
        const cc = pc[pairPos];

        if (mc === '-' && cc !== '-') {
          // gap in master but not in this pair → insert gap in other
          mapped.push('-');
          masterPos++;
        } else if (mc !== '-' && cc === '-') {
          // gap in this pair but not in master → skip pair gap (insert in master later — simplified)
          mapped.push(po[pairPos]);
          pairPos++;
        } else {
          mapped.push(po[pairPos]);
          masterPos++;
          pairPos++;
        }
      }
      while (pairPos < po.length) { mapped.push(po[pairPos++]); }
      masterOthers[seqIdx] = mapped;
    }

    // Ensure all rows same length (pad with gaps)
    const maxLen = Math.max(...masterOthers.map(r => r.length));
    return masterOthers.map(row => {
      while (row.length < maxLen) row.push('-');
      return row.join('');
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     ── REMOTE API CALL ──────────────────────────────────────────────
     Fill in the body construction and response parsing below
     once your API is ready.
  ═══════════════════════════════════════════════════════════════════ */
  async function callAlignmentAPI(seqs, params) {
    if (!ALIGNMENT_API_URL) throw new Error('API_NOT_CONFIGURED');

    const token = (typeof Auth !== 'undefined' ? Auth.getAuthToken() : null);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Token ' + token;

    /* ── Build request body ──────────────────────────────────────────
       API expects: { sequences: ["SEQ1", "SEQ2", ...], gap_open, gap_extend }
       sequences is an array of plain sequence strings (no FASTA headers).
    ─────────────────────────────────────────────────────────────── */
    const body = JSON.stringify({
      sequences:  seqs.map(s => s.seq),
      gap_open:   params.gapOpen,
      gap_extend: params.gapExtend,
    });

    const res = await fetch(ALIGNMENT_API_URL, {
      method: 'POST',
      headers,
      body,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errMsg = `HTTP ${res.status}`;
      try { const j = JSON.parse(errText); errMsg = j.detail || j.error || j.message || errMsg; } catch {}
      throw new Error(errMsg);
    }

    const rawText = await res.text();

    /* ── Parse response ──────────────────────────────────────────────
       API returns:
       {
         success: true,
         alignment: ["ALIGNED_SEQ1", "ALIGNED_SEQ2", ...],
         consensus: "CONSENSUS",
         identity_scores: [100.0, 87.5, ...],
         method: "progressive_msa",
         num_sequences: N,
         alignment_length: N
       }
    ─────────────────────────────────────────────────────────────── */
    let parsed;
    try { parsed = JSON.parse(rawText); } catch { parsed = null; }

    if (parsed && Array.isArray(parsed.alignment)) {
      return parsed.alignment.map((alignedSeq, i) => ({
        id:      seqs[i] ? seqs[i].id : `seq${i + 1}`,
        aligned: alignedSeq,
      }));
    }

    // Fallback: try other common JSON shapes
    if (parsed) {
      const list = parsed.aligned || parsed.sequences || parsed.results || parsed.data;
      if (Array.isArray(list)) {
        return list.map((r, i) => ({
          id:      (typeof r === 'string') ? (seqs[i] ? seqs[i].id : `seq${i+1}`) : (r.id || r.name || `seq${i+1}`),
          aligned: (typeof r === 'string') ? r : (r.sequence || r.aligned || r.seq || ''),
        }));
      }
    }

    // Fallback: parse as FASTA text
    const fastaResult = parseFasta(rawText);
    if (!fastaResult.length) throw new Error('Réponse API vide ou non reconnue');
    return fastaResult.map(r => ({ id: r.id, aligned: r.seq }));
  }

  /* ═══════════════════════════════════════════════════════════════════
     ── STATISTICS ───────────────────────────────────────────────────
  ═══════════════════════════════════════════════════════════════════ */
  function computeStats(aligned) {
    const len = aligned[0] ? aligned[0].aligned.length : 0;
    let conserved = 0, gapCols = 0, identical = 0;
    for (let c = 0; c < len; c++) {
      const col = aligned.map(r => r.aligned[c]);
      const hasGap = col.includes('-');
      if (hasGap) gapCols++;
      const nonGap = col.filter(x => x !== '-');
      if (nonGap.length > 0 && nonGap.every(x => x === nonGap[0])) {
        if (!hasGap) { conserved++; identical++; }
        else conserved++;
      }
    }
    // Pairwise identity matrix
    const n = aligned.length;
    const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      matrix[i][i] = 100;
      for (let j = i + 1; j < n; j++) {
        let matches = 0, total = 0;
        for (let c = 0; c < len; c++) {
          const a = aligned[i].aligned[c], b = aligned[j].aligned[c];
          if (a !== '-' && b !== '-') { total++; if (a === b) matches++; }
        }
        const pct = total ? Math.round(matches / total * 1000) / 10 : 0;
        matrix[i][j] = pct;
        matrix[j][i] = pct;
      }
    }
    return { len, conserved, gapCols, identical, matrix };
  }

  function buildConsensus(aligned) {
    if (!aligned.length) return '';
    const len = aligned[0].aligned.length;
    let cons = '';
    for (let c = 0; c < len; c++) {
      const col = aligned.map(r => r.aligned[c]);
      const nonGap = col.filter(x => x !== '-');
      if (!nonGap.length) { cons += '-'; continue; }
      const freq = {};
      for (const x of nonGap) freq[x] = (freq[x] || 0) + 1;
      const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
      cons += top[1] / nonGap.length >= 0.5 ? top[0] : (top[1] / nonGap.length >= 0.25 ? '+' : '.');
    }
    return cons;
  }

  function computeConservation(aligned) {
    if (!aligned.length) return [];
    const len = aligned[0].aligned.length;
    const vals = [];
    for (let c = 0; c < len; c++) {
      const col = aligned.map(r => r.aligned[c]);
      const nonGap = col.filter(x => x !== '-');
      if (!nonGap.length) { vals.push(0); continue; }
      const freq = {};
      for (const x of nonGap) freq[x] = (freq[x] || 0) + 1;
      const top = Math.max(...Object.values(freq));
      vals.push(top / nonGap.length);
    }
    return vals;
  }

  /* ═══════════════════════════════════════════════════════════════════
     ── RENDERING ────────────────────────────────────────────────────
  ═══════════════════════════════════════════════════════════════════ */
  const NT_CLASS = { A:'nt-A', T:'nt-T', G:'nt-G', C:'nt-C', U:'nt-U', '-':'nt-gap' };

  function ntClass(c) {
    return NT_CLASS[c] || 'nt-N';
  }

  function renderBlock(blockIdx, aligned, consensus, conservation, opts) {
    const start = blockIdx * BLOCK_WIDTH;
    const end   = Math.min(start + BLOCK_WIDTH, aligned[0].aligned.length);
    const viewer = document.getElementById('alignment-viewer');
    viewer.innerHTML = '';

    // Ruler
    if (opts.ruler) {
      const rulerRow = document.createElement('div');
      rulerRow.className = 'align-ruler';
      rulerRow.innerHTML = '<div class="ruler-label">Position</div>';
      const rulerSeq = document.createElement('div');
      for (let c = start; c < end; c++) {
        const span = document.createElement('div');
        span.className = 'ruler-tick';
        span.textContent = ((c + 1) % 10 === 0) ? (c + 1) : ((c + 1) % 5 === 0 ? '·' : '');
        rulerSeq.appendChild(span);
      }
      rulerRow.appendChild(rulerSeq);
      viewer.appendChild(rulerRow);
    }

    // Sequence rows
    aligned.forEach((row, ri) => {
      const div = document.createElement('div');
      div.className = 'align-row';
      const labelDiv = document.createElement('div');
      labelDiv.className = 'align-label';
      labelDiv.title = row.id;
      // Colour dot
      const dot = document.createElement('span');
      dot.style.cssText = `display:inline-block;width:7px;height:7px;border-radius:50%;background:${SEQ_COLORS[ri % SEQ_COLORS.length]};margin-right:4px;flex-shrink:0;`;
      labelDiv.appendChild(dot);
      labelDiv.appendChild(document.createTextNode(row.id));
      div.appendChild(labelDiv);

      const seqDiv = document.createElement('div');
      seqDiv.className = 'align-seq';
      for (let c = start; c < end; c++) {
        const ch = row.aligned[c] || '-';
        const cell = document.createElement('span');
        cell.className = 'nt-cell ' + (opts.colors ? ntClass(ch) : '');
        cell.textContent = ch;
        seqDiv.appendChild(cell);
      }
      div.appendChild(seqDiv);
      viewer.appendChild(div);
    });

    // Consensus row
    if (opts.consensus && consensus) {
      const div = document.createElement('div');
      div.className = 'align-row consensus-row';
      const labelDiv = document.createElement('div');
      labelDiv.className = 'align-label';
      labelDiv.style.color = '#2563eb';
      labelDiv.style.fontWeight = '700';
      labelDiv.textContent = 'Consensus';
      div.appendChild(labelDiv);
      const seqDiv = document.createElement('div');
      seqDiv.className = 'align-seq';
      for (let c = start; c < end; c++) {
        const ch = consensus[c] || '-';
        const cell = document.createElement('span');
        cell.className = 'nt-cell ' + (opts.colors ? ntClass(ch) : '');
        cell.style.color = '#1e40af';
        cell.textContent = ch;
        seqDiv.appendChild(cell);
      }
      div.appendChild(seqDiv);
      viewer.appendChild(div);
    }

    // Conservation bar row
    if (opts.conservation && conservation.length) {
      const div = document.createElement('div');
      div.className = 'align-row';
      const labelDiv = document.createElement('div');
      labelDiv.className = 'align-label';
      labelDiv.style.color = '#64748b';
      labelDiv.textContent = 'Conservation';
      div.appendChild(labelDiv);
      const seqDiv = document.createElement('div');
      seqDiv.className = 'align-seq';
      for (let c = start; c < end; c++) {
        const val = conservation[c] || 0;
        const wrap = document.createElement('span');
        wrap.className = 'conserv-cell';
        const bar = document.createElement('span');
        bar.className = 'conserv-bar';
        bar.style.height = Math.round(val * 14) + 'px';
        bar.style.background = val >= 0.8 ? '#2563eb' : val >= 0.5 ? '#0d9488' : '#94a3b8';
        wrap.appendChild(bar);
        seqDiv.appendChild(wrap);
      }
      div.appendChild(seqDiv);
      viewer.appendChild(div);
    }
  }

  function renderStats(stats, n) {
    const pct = stats.len ? Math.round(stats.identical / stats.len * 100) : 0;
    const conservPct = stats.len ? Math.round(stats.conserved / stats.len * 100) : 0;
    const gapPct = stats.len ? Math.round(stats.gapCols / stats.len * 100) : 0;

    document.getElementById('stats-row').innerHTML = `
      <div class="stat-box">
        <p class="text-xs text-gray-400 mb-0.5">Séquences</p>
        <p class="text-xl font-bold text-gray-900">${n}</p>
      </div>
      <div class="stat-box">
        <p class="text-xs text-gray-400 mb-0.5">Longueur alignée</p>
        <p class="text-xl font-bold text-gray-900">${stats.len} <span class="text-xs font-normal">nt</span></p>
      </div>
      <div class="stat-box">
        <p class="text-xs text-gray-400 mb-0.5">Colonnes identiques</p>
        <p class="text-xl font-bold" style="color:#16a34a;">${pct}%</p>
      </div>
      <div class="stat-box">
        <p class="text-xs text-gray-400 mb-0.5">Colonnes avec gaps</p>
        <p class="text-xl font-bold" style="color:${gapPct > 30 ? '#ef4444' : '#f59e0b'};">${gapPct}%</p>
      </div>
    `;
  }

  function renderMatrix(stats, aligned) {
    const n = aligned.length;
    const labels = aligned.map(r => r.id.slice(0, 12));
    let html = '<table style="border-collapse:separate;border-spacing:3px;">';
    // Header
    html += '<tr><th style="width:120px;"></th>';
    for (let j = 0; j < n; j++) {
      html += `<th style="font-size:9px;color:#64748b;font-weight:600;text-align:center;width:52px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${aligned[j].id}">${labels[j]}</th>`;
    }
    html += '</tr>';
    for (let i = 0; i < n; i++) {
      html += `<tr><td style="font-size:9px;color:#475569;font-weight:600;padding-right:4px;text-align:right;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${aligned[i].id}">${labels[i]}</td>`;
      for (let j = 0; j < n; j++) {
        const val = stats.matrix[i][j];
        const bg = i === j ? '#dbeafe' : val >= 80 ? '#bbf7d0' : val >= 60 ? '#fef08a' : val >= 40 ? '#fed7aa' : '#fecaca';
        const color = i === j ? '#1e40af' : val >= 80 ? '#14532d' : val >= 60 ? '#713f12' : val >= 40 ? '#7c2d12' : '#7f1d1d';
        html += `<td><div class="matrix-cell" style="background:${bg};color:${color};">${i === j ? '—' : val + '%'}</div></td>`;
      }
      html += '</tr>';
    }
    html += '</table>';
    document.getElementById('identity-matrix').innerHTML = html;
  }

  function renderFastaOutput(aligned) {
    const lines = aligned.map(r => `>${r.id}\n${r.aligned}`).join('\n\n');
    document.getElementById('fasta-output').textContent = lines;
  }

  /* ═══════════════════════════════════════════════════════════════════
     ── UI HELPERS ───────────────────────────────────────────────────
  ═══════════════════════════════════════════════════════════════════ */
  function showEmpty()   { setVisible('empty-state', true); setVisible('loading-state', false); setVisible('results-container', false); }
  function showLoading(msg) {
    setVisible('empty-state', false); setVisible('loading-state', true); setVisible('results-container', false);
    const el = document.getElementById('loading-msg');
    if (el) el.textContent = msg || 'Alignement en cours…';
  }
  function showResults() { setVisible('empty-state', false); setVisible('loading-state', false); setVisible('results-container', true); }
  function setVisible(id, v) { const el = document.getElementById(id); if (el) el.style.display = v ? '' : 'none'; }

  function getParams() {
    return {
      algo:         (document.getElementById('algo-select') || {}).value || 'nw',
      gapOpen:      parseInt((document.getElementById('gap-open') || {}).value  || '-2', 10),
      gapExtend:    parseInt((document.getElementById('gap-extend') || {}).value || '-1', 10),
      matchScore:   parseInt((document.getElementById('match-score') || {}).value || '1', 10),
      mismatchScore:parseInt((document.getElementById('mismatch-score') || {}).value || '-1', 10),
      showConsensus:   (document.getElementById('show-consensus')    || { checked: true }).checked,
      showConservation:(document.getElementById('show-conservation') || { checked: true }).checked,
      showRuler:       (document.getElementById('show-ruler')        || { checked: true }).checked,
      colorNt:         (document.getElementById('color-nt')          || { checked: true }).checked,
    };
  }

  function updateBlockNav(n) {
    const nav = document.getElementById('block-nav');
    if (n <= 1) { if (nav) nav.style.setProperty('display', 'none', 'important'); return; }
    if (nav) nav.style.removeProperty('display');
    const indicator = document.getElementById('block-indicator');
    const range     = document.getElementById('block-range');
    const slider    = document.getElementById('block-slider');
    if (indicator) indicator.textContent = `${currentBlock + 1} / ${n}`;
    const start = currentBlock * BLOCK_WIDTH + 1;
    const end   = Math.min((currentBlock + 1) * BLOCK_WIDTH, alignedSeqs[0] ? alignedSeqs[0].aligned.length : 0);
    if (range) range.textContent = `pos. ${start}–${end}`;
    if (slider) { slider.max = n - 1; slider.value = currentBlock; }
  }

  /* ═══════════════════════════════════════════════════════════════════
     ── PUBLIC FUNCTIONS (called from HTML) ──────────────────────────
  ═══════════════════════════════════════════════════════════════════ */

  /** Parse textarea and update detected-sequence preview */
  window.onFastaInput = function (text) {
    parsedSeqs = parseFasta(text);
    renderSeqPreview();
  };

  function renderSeqPreview() {
    const preview = document.getElementById('seq-list-preview');
    const items   = document.getElementById('seq-list-items');
    const badge   = document.getElementById('seq-count-badge');
    const num     = document.getElementById('seq-count-num');
    if (!preview || !items) return;

    if (parsedSeqs.length === 0) {
      preview.style.display = 'none';
      if (badge) badge.style.display = 'none';
      return;
    }
    preview.style.display = '';
    if (badge) badge.style.display = 'inline-flex';
    if (num) num.textContent = parsedSeqs.length;

    items.innerHTML = parsedSeqs.map((s, i) => `
      <div class="seq-info-row">
        <span class="seq-dot" style="background:${SEQ_COLORS[i % SEQ_COLORS.length]};"></span>
        <span class="text-xs font-medium text-gray-700 flex-1 truncate" title="${Utils.escapeHTML(s.id)}">${Utils.escapeHTML(s.id)}</span>
        <span class="text-xs text-gray-400 font-mono">${s.seq.length} nt</span>
      </div>
    `).join('');
  }

  /** Load FASTA file */
  window.loadFastaFile = function (event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
      const textarea = document.getElementById('fasta-input');
      if (textarea) { textarea.value = e.target.result; onFastaInput(e.target.result); }
    };
    reader.readAsText(file);
  };

  /** Load example sequences */
  window.loadExample = function () {
    const example = [
      '>TaSP_Theileria_annulata',
      'ATGCGATCGATCGATCGATCGAATCGATCGATCGGCTATCGATCGATCG',
      '>TpMSP_Theileria_parva',
      'ATGCGATCGATCGATTGATCGAATCGATCGATCGGCTATCGATCGATCG',
      '>ToRON2_Theileria_orientalis',
      'ATGCGCTCGATCGATCGATCGAATCGCTCGATCGGCTATCGATCGATCG',
      '>TaHSP70_Theileria_annulata',
      'ATGCGATCGATCGATCGATCAAATCGATCGATCGGCAATCGATCGATCG',
    ].join('\n');
    const textarea = document.getElementById('fasta-input');
    if (textarea) { textarea.value = example; onFastaInput(example); }
  };

  /** Clear input */
  window.clearInput = function () {
    const textarea = document.getElementById('fasta-input');
    if (textarea) { textarea.value = ''; onFastaInput(''); }
    parsedSeqs = [];
    alignedSeqs = [];
    showEmpty();
  };

  /** Main — run alignment */
  window.runAlignment = function () {
    if (parsedSeqs.length < 2) {
      Utils.showToast('Veuillez entrer au moins 2 séquences FASTA.', 'warning');
      return;
    }
    if (parsedSeqs.length > 130) {
      Utils.showToast('Maximum 130 séquences par alignement.', 'warning');
      return;
    }

    const params = getParams();
    const algo   = params.algo;

    if (algo === 'local' && !ALIGNMENT_API_URL) {
      Utils.showToast('URL d\'API non configurée. Utilisez un algorithme local.', 'warning');
      return;
    }

    showLoading(algo === 'local' ? 'Appel API d\'alignement…' : 'Alignement en cours (local)…');

    // Debounce to let the loading spinner paint
    setTimeout(async () => {
      try {
        if (algo === 'local') {
          alignedSeqs = await callAlignmentAPI(parsedSeqs, params);
        } else {
          alignedSeqs = starAlignment(
            parsedSeqs,
            params.matchScore,
            params.mismatchScore,
            params.gapOpen
          );
        }

        const stats       = computeStats(alignedSeqs);
        const consensus   = buildConsensus(alignedSeqs);
        const conservation = computeConservation(alignedSeqs);

        totalBlocks  = Math.ceil((alignedSeqs[0] ? alignedSeqs[0].aligned.length : 1) / BLOCK_WIDTH);
        currentBlock = 0;

        const opts = {
          consensus:    params.showConsensus,
          conservation: params.showConservation,
          ruler:        params.showRuler,
          colors:       params.colorNt,
        };

        showResults();
        renderStats(stats, alignedSeqs.length);
        renderBlock(currentBlock, alignedSeqs, consensus, conservation, opts);
        updateBlockNav(totalBlocks);
        renderMatrix(stats, alignedSeqs);
        renderFastaOutput(alignedSeqs);

        // Store for block navigation
        window._alignState = { alignedSeqs, consensus, conservation, opts };

      } catch (err) {
        showEmpty();
        Utils.showToast('Erreur : ' + err.message, 'error');
      }
    }, 30);
  };

  /** Block navigation */
  window.prevBlock = function () {
    if (currentBlock > 0) { currentBlock--; _refreshBlock(); }
  };
  window.nextBlock = function () {
    if (currentBlock < totalBlocks - 1) { currentBlock++; _refreshBlock(); }
  };
  window.goToBlock = function (idx) {
    currentBlock = idx;
    _refreshBlock();
  };

  function _refreshBlock() {
    if (!window._alignState) return;
    const { alignedSeqs, consensus, conservation, opts } = window._alignState;
    renderBlock(currentBlock, alignedSeqs, consensus, conservation, opts);
    updateBlockNav(totalBlocks);
  }

  /** Copy aligned FASTA text */
  window.copyAlignmentText = function () {
    const text = document.getElementById('fasta-output') ? document.getElementById('fasta-output').textContent : '';
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => Utils.showToast('FASTA copié !', 'success'));
  };

  /** Download aligned FASTA */
  window.downloadFasta = function () {
    const text = document.getElementById('fasta-output') ? document.getElementById('fasta-output').textContent : '';
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aligned_sequences.fasta';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ═══════════════════════════════════════════════════════════════════
     ── INIT ─────────────────────────────────────────────────────────
  ═══════════════════════════════════════════════════════════════════ */
  document.addEventListener('DOMContentLoaded', function () {
    showEmpty();
    // Show API banner when algorithm is "local" but no API configured
    const algoSel = document.getElementById('algo-select');
    const banner  = document.getElementById('api-status-banner');
    if (algoSel && banner) {
      algoSel.addEventListener('change', function () {
        if (this.value === 'local' && !ALIGNMENT_API_URL) {
          banner.style.removeProperty('display');
        } else {
          banner.style.setProperty('display', 'none', 'important');
        }
      });
    }
    // Re-render on option checkbox change
    ['show-consensus', 'show-conservation', 'show-ruler', 'color-nt'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => {
        if (window._alignState && alignedSeqs.length) {
          window._alignState.opts = getParams();
          _refreshBlock();
        }
      });
    });
  });

})();
