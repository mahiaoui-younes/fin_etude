/**
 * EpitopX AI — Epitope Search
 * Predict epitopes for a reference protein, then search them in a FASTA dataset.
 */

(function () {
  'use strict';

  let refProtein = null;
  let predictedEpitopes = [];
  let fastaProteins = [];   // [{ header, name, sequence }]
  let activeEpitope = null;
  let lastSearchResults = null;
  let lastAnalysisData = null;  // full API response for details modal

  // ─── Init ────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    await loadRefProteinList();
  });

  async function loadRefProteinList() {
    let proteins = [];
    try {
      const cached = API.getCachedProteins();
      proteins = cached.length ? cached : (await API.getAllProteins()).data || [];
    } catch (e) {
      console.warn('Could not load proteins', e);
    }
    const select = document.getElementById('ref-protein-select');
    proteins.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} — ${p.organism}`;
      select.appendChild(opt);
    });
  }

  // ─── Reference protein ────────────────────────────────────────────────────
  window.onRefProteinChange = function () {
    const val = document.getElementById('ref-protein-select').value;
    const cached = API.getCachedProteins();
    refProtein = val ? (cached.find(p => p.id === Number(val)) || null) : null;

    const preview = document.getElementById('ref-protein-preview');
    if (refProtein) {
      const esc = Utils.escapeHTML;
      preview.innerHTML = `
        <div class="bg-gray-50 rounded-xl p-3 animate-fade-in mt-2">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-100 to-teal-100 flex items-center justify-center text-sm font-bold text-blue-700 shrink-0">
              ${esc(refProtein.name.charAt(0))}
            </div>
            <div class="min-w-0">
              <p class="font-medium text-sm truncate text-gray-900">${esc(refProtein.name)}</p>
              <p class="text-[10px] text-gray-400">${esc(refProtein.organism)} • ${refProtein.sequence.length} aa</p>
            </div>
          </div>
        </div>`;
    } else {
      preview.innerHTML = '';
    }

    document.getElementById('btn-predict').disabled = !refProtein;
    // Reset epitopes display
    predictedEpitopes = [];
    activeEpitope = null;
    lastAnalysisData = null;
    document.getElementById('epitopes-card').style.display = 'none';
    document.getElementById('search-results-section').classList.add('hidden');
    document.getElementById('main-empty').style.display = '';
  };

  // ─── Epitope prediction ──────────────────────────────────────────────────
  window.predictEpitopes = async function () {
    if (!refProtein) return;

    const btn = document.getElementById('btn-predict');
    const loading = document.getElementById('predict-loading');
    btn.disabled = true;
    btn.classList.add('opacity-50');
    loading.classList.remove('hidden');

    try {
      const response = await API.analyzeEpitopes({
        protein_id: refProtein.id,
        sequence: refProtein.sequence,
        method: document.getElementById('ep-method').value,
        min_length: parseInt(document.getElementById('ep-min-len').value) || 9,
        max_length: parseInt(document.getElementById('ep-max-len').value) || 20,
        min_score: parseFloat(document.getElementById('ep-min-score').value) || 0.5,
        top_n: parseInt(document.getElementById('ep-top-n').value) || 20,
      });

      if (!response.success) {
        Utils.showToast('Erreur: ' + (response.error || 'Échec de la prédiction'), 'error');
        return;
      }

      const raw = response.data;
      lastAnalysisData = raw;
      predictedEpitopes = (raw.epitopes || raw.results || []).map(ep => {
        const start = ep.start || ep.start_position || 1;
        const end = ep.end || ep.end_position || start;
        let seq = ep.sequence || ep.peptide || '';
        if (!seq && refProtein.sequence && start !== '?' && end !== '?') {
          seq = refProtein.sequence.slice(start - 1, end);
        }
        return {
          ...ep,
          start, end,
          sequence: seq,
          score: ep.score || ep.combined_score || 0,
        };
      }).filter(ep => ep.sequence);

      renderEpitopeList();
      document.getElementById('main-empty').style.display = 'none';
      Utils.showToast(`${predictedEpitopes.length} épitopes prédits — cliquez pour rechercher`, 'success');
    } catch (err) {
      Utils.showToast('Erreur: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('opacity-50');
      loading.classList.add('hidden');
    }
  };

  function renderEpitopeList() {
    const card = document.getElementById('epitopes-card');
    const list = document.getElementById('epitope-list');
    const badge = document.getElementById('ep-count-badge');

    badge.textContent = `${predictedEpitopes.length} épitope${predictedEpitopes.length !== 1 ? 's' : ''}`;

    list.innerHTML = predictedEpitopes.map((ep, idx) => {
      const pct = Math.round(ep.score * 100);
      const barColor = pct >= 70 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-500' : 'bg-blue-400';
      const scoreColor = pct >= 70 ? 'text-red-600' : pct >= 50 ? 'text-amber-600' : 'text-blue-600';
      return `
        <div class="epitope-card p-2.5 rounded-lg border border-gray-200 hover:border-blue-300 cursor-pointer"
             id="ep-card-${idx}" onclick="searchEpitope(${idx})">
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs font-semibold text-gray-700">#${idx + 1} &nbsp;<span class="font-normal text-gray-400">Pos ${ep.start}–${ep.end}</span></span>
            <span class="text-xs font-bold ${scoreColor}">${ep.score.toFixed(3)}</span>
          </div>
          <div class="font-mono text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-1.5 py-1 break-all leading-5 select-all mb-1.5">${Utils.escapeHTML(ep.sequence)}</div>
          <div class="flex items-center justify-between mt-1.5">
            <div class="progress-thin flex-1"><div class="progress-thin-fill ${barColor}" style="width:${pct}%"></div></div>
            <button class="ml-2 text-[10px] font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-md px-2 py-0.5 transition" onclick="event.stopPropagation(); showEpitopeDetails(${idx})">
              Détails
            </button>
          </div>
        </div>`;
    }).join('');

    card.style.display = '';
  }

  // ─── FASTA handling ──────────────────────────────────────────────────────
  window.loadFastaFile = function (input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      document.getElementById('fasta-input').value = e.target.result;
      parseFasta();
    };
    reader.readAsText(file);
    input.value = ''; // reset so same file can be reloaded
  };

  window.clearFasta = function () {
    document.getElementById('fasta-input').value = '';
    document.getElementById('fasta-status').textContent = '';
    fastaProteins = [];
    document.getElementById('fasta-proteins-card').style.display = 'none';
  };

  window.parseFasta = function () {
    const text = document.getElementById('fasta-input').value.trim();
    if (!text) {
      Utils.showToast('Collez d\'abord du contenu FASTA', 'warning');
      return;
    }
    fastaProteins = parseFASTAText(text);
    if (fastaProteins.length === 0) {
      Utils.showToast('Aucune séquence FASTA valide trouvée', 'error');
      document.getElementById('fasta-status').textContent = 'Format invalide';
      return;
    }
    document.getElementById('fasta-status').textContent = `${fastaProteins.length} protéine${fastaProteins.length > 1 ? 's' : ''} chargée${fastaProteins.length > 1 ? 's' : ''}`;
    renderFastaProteins();
    Utils.showToast(`${fastaProteins.length} protéine(s) FASTA chargée(s)`, 'success');
  };

  function parseFASTAText(text) {
    const proteins = [];
    const lines = text.split(/\r?\n/);
    let current = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('>')) {
        if (current && current.sequence.length > 0) proteins.push(current);
        const header = trimmed.slice(1).trim();
        // Short display name: first word of header
        const name = header.split(/\s+/)[0] || header;
        current = { header, name, sequence: '' };
      } else if (current) {
        current.sequence += trimmed.toUpperCase().replace(/[^A-Z*]/g, '').replace(/\*/g, '');
      }
    }
    if (current && current.sequence.length > 0) proteins.push(current);
    return proteins;
  }

  function renderFastaProteins() {
    const card = document.getElementById('fasta-proteins-card');
    const list = document.getElementById('fasta-protein-list');
    const badge = document.getElementById('fasta-count-badge');

    badge.textContent = `${fastaProteins.length} séquence${fastaProteins.length !== 1 ? 's' : ''}`;

    list.innerHTML = fastaProteins.map((p, i) => `
      <div class="flex items-center gap-2 p-2 rounded-lg bg-gray-50 border border-gray-100">
        <span class="w-5 h-5 rounded-full bg-violet-100 text-violet-700 text-[9px] font-bold flex items-center justify-center shrink-0">${i + 1}</span>
        <div class="min-w-0">
          <p class="text-xs font-medium text-gray-700 truncate">${escapeHTML(p.name)}</p>
          <p class="text-[10px] text-gray-400">${p.sequence.length} aa</p>
        </div>
      </div>`).join('');

    card.style.display = '';
  }

  // ─── Epitope search ───────────────────────────────────────────────────────
  window.searchEpitope = function (idx) {
    if (fastaProteins.length === 0) {
      Utils.showToast('Chargez d\'abord des protéines FASTA', 'warning');
      return;
    }

    // Update active card styling
    document.querySelectorAll('.epitope-card').forEach(c => c.classList.remove('active'));
    document.getElementById(`ep-card-${idx}`).classList.add('active');

    activeEpitope = predictedEpitopes[idx];
    const minIdentity = parseFloat(document.getElementById('search-min-identity').value) || 70;

    const allHits = [];
    for (const fp of fastaProteins) {
      const hits = searchEpitopeInSequence(activeEpitope.sequence, fp.sequence, minIdentity / 100);
      hits.forEach(h => allHits.push({ protein: fp, ...h }));
    }

    lastSearchResults = { epitope: activeEpitope, minIdentity, hits: allHits };
    renderSearchResults(allHits);

    document.getElementById('search-results-section').classList.remove('hidden');
    document.getElementById('main-empty').style.display = 'none';
    document.getElementById('search-results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /**
   * Search for epitopeSeq inside targetSeq using exact + sliding-window fuzzy match.
   * Returns an array of hits: { start, end, matchedSeq, identity, isExact }
   */
  function searchEpitopeInSequence(epitopeSeq, targetSeq, minIdentity) {
    const L = epitopeSeq.length;
    const hits = [];
    const seen = new Set();

    // Exact matches (can be multiple)
    let pos = 0;
    while ((pos = targetSeq.indexOf(epitopeSeq, pos)) !== -1) {
      const key = `${pos}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ start: pos + 1, end: pos + L, matchedSeq: epitopeSeq, identity: 100, isExact: true });
      }
      pos++;
    }

    // Fuzzy sliding window — skip positions already covered by exact matches
    if (targetSeq.length >= L) {
      for (let i = 0; i <= targetSeq.length - L; i++) {
        if (seen.has(`${i}`)) continue;
        const window = targetSeq.slice(i, i + L);
        let matches = 0;
        for (let j = 0; j < L; j++) {
          if (window[j] === epitopeSeq[j]) matches++;
        }
        const identity = matches / L;
        if (identity >= minIdentity) {
          hits.push({ start: i + 1, end: i + L, matchedSeq: window, identity: Math.round(identity * 100), isExact: false });
          seen.add(`${i}`);
        }
      }
    }

    // Sort by identity desc, then by position
    hits.sort((a, b) => b.identity - a.identity || a.start - b.start);
    return hits;
  }

  function renderSearchResults(hits) {
    const ep = activeEpitope;
    document.getElementById('searched-epitope-seq').textContent = ep.sequence;
    document.getElementById('searched-epitope-meta').textContent =
      `Pos ${ep.start}–${ep.end} · Score ${ep.score.toFixed(3)} · ${ep.sequence.length} aa`;

    const subtitleEl = document.getElementById('search-subtitle');
    const summaryEl = document.getElementById('search-hit-summary');

    if (hits.length === 0) {
      subtitleEl.textContent = 'Aucune correspondance trouvée.';
      summaryEl.innerHTML = '';
      document.getElementById('results-tbody').innerHTML = '';
      document.getElementById('no-hits').classList.remove('hidden');
      return;
    }

    document.getElementById('no-hits').classList.add('hidden');
    const exactCount = hits.filter(h => h.isExact).length;
    const fuzzyCount = hits.length - exactCount;
    subtitleEl.textContent = `${hits.length} correspondance${hits.length > 1 ? 's' : ''} dans ${new Set(hits.map(h => h.protein.name)).size} protéine(s)`;
    summaryEl.innerHTML = [
      exactCount ? `<span class="fasta-protein-badge bg-emerald-100 text-emerald-700">${exactCount} exact${exactCount > 1 ? 's' : ''}</span>` : '',
      fuzzyCount ? `<span class="fasta-protein-badge bg-amber-100 text-amber-700">${fuzzyCount} approx.</span>` : '',
    ].join('');

    document.getElementById('results-tbody').innerHTML = hits.map(h => {
      const idPct = h.identity;
      const idClass = idPct === 100 ? 'bg-emerald-100 text-emerald-700'
        : idPct >= 80 ? 'bg-teal-100 text-teal-700'
        : idPct >= 60 ? 'bg-amber-100 text-amber-700'
        : 'bg-rose-100 text-rose-700';
      const highlightedSeq = buildHighlightedSeq(ep.sequence, h.matchedSeq, h.isExact);
      return `
        <tr class="hit-row border-b border-gray-100">
          <td class="py-3 px-4">
            <p class="text-xs font-medium text-gray-800 truncate max-w-[200px]" title="${escapeHTML(h.protein.header)}">${escapeHTML(h.protein.name)}</p>
            <p class="text-[10px] text-gray-400">${h.protein.sequence.length} aa</p>
          </td>
          <td class="py-3 px-4 text-center">
            <span class="text-xs font-mono text-gray-600">${h.start}–${h.end}</span>
          </td>
          <td class="py-3 px-4 text-center">
            <span class="identity-pill ${idClass}">${idPct}%</span>
            <div class="progress-thin mt-1 mx-auto w-16">
              <div class="progress-thin-fill ${idPct === 100 ? 'bg-emerald-500' : idPct >= 80 ? 'bg-teal-500' : idPct >= 60 ? 'bg-amber-500' : 'bg-rose-400'}" style="width:${idPct}%"></div>
            </div>
          </td>
          <td class="py-3 px-4">
            <div class="seq-highlight">${highlightedSeq}</div>
          </td>
        </tr>`;
    }).join('');
  }

  /** Build an HTML string that highlights matching positions */
  function buildHighlightedSeq(epitopeSeq, matchedSeq, isExact) {
    if (isExact) {
      return `<mark class="exact">${escapeHTML(matchedSeq)}</mark>`;
    }
    let html = '';
    for (let i = 0; i < matchedSeq.length; i++) {
      if (matchedSeq[i] === epitopeSeq[i]) {
        html += `<mark>${escapeHTML(matchedSeq[i])}</mark>`;
      } else {
        html += `<span class="text-rose-500">${escapeHTML(matchedSeq[i])}</span>`;
      }
    }
    return html;
  }

  // ─── Export ───────────────────────────────────────────────────────────────
  window.exportSearchResults = function () {
    if (!lastSearchResults) {
      Utils.showToast('Aucun résultat à exporter', 'warning');
      return;
    }
    const { epitope, minIdentity, hits } = lastSearchResults;
    const lines = [
      '═══════════════════════════════════════════════════',
      '   EpitopX AI — Rapport de recherche d\'épitopes',
      '═══════════════════════════════════════════════════',
      '',
      `Date: ${new Date().toLocaleString('fr-FR')}`,
      `Protéine de référence: ${refProtein ? refProtein.name : '—'}`,
      `Épitope: ${epitope.sequence}`,
      `Position: ${epitope.start}–${epitope.end}`,
      `Score: ${epitope.score.toFixed(3)}`,
      `Identité min: ${minIdentity}%`,
      `Correspondances: ${hits.length}`,
      '',
      '── Résultats ──',
    ];
    if (hits.length === 0) {
      lines.push('Aucune correspondance trouvée.');
    } else {
      hits.forEach((h, i) => {
        lines.push(`\n${i + 1}. ${h.protein.name}`);
        lines.push(`   Header: ${h.protein.header}`);
        lines.push(`   Position: ${h.start}–${h.end}`);
        lines.push(`   Identité: ${h.identity}%`);
        lines.push(`   Séquence: ${h.matchedSeq}`);
        lines.push(`   Type: ${h.isExact ? 'Exact' : 'Approximatif'}`);
      });
    }
    lines.push('', '═══════════════════════════════════════════════════');
    lines.push('Généré par EpitopX AI v1.0');
    const filename = `epitope_search_${(epitope.sequence || 'ep').slice(0, 12)}.txt`;
    Utils.downloadFile(lines.join('\n'), filename);
    Utils.showToast('Rapport exporté', 'success');
  };

  // ─── Epitope Details Modal ────────────────────────────────────────────────
  window.showEpitopeDetails = function (idx) {
    const ep = predictedEpitopes[idx];
    if (!ep || !lastAnalysisData) return;

    const d = lastAnalysisData;
    const seqInfo = d.sequence_information || {};
    const modRes = d.module_results || {};
    const resStat = d.residue_statistics || {};
    const aaComp = d.amino_acid_composition || {};

    const pct = Math.round(ep.score * 100);
    const scoreColor = pct >= 70 ? 'text-red-600 bg-red-50 border-red-200' : pct >= 50 ? 'text-amber-600 bg-amber-50 border-amber-200' : 'text-blue-600 bg-blue-50 border-blue-200';

    const modal = document.getElementById('epitope-details-modal');
    const body = document.getElementById('epitope-details-body');

    body.innerHTML = `
      <!-- Epitope header -->
      <div class="bg-gradient-to-r from-blue-50 to-teal-50 rounded-xl p-4 mb-4 border border-blue-100">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-sm font-bold text-gray-800">Épitope #${idx + 1}</h3>
          <span class="text-xs font-bold px-2 py-0.5 rounded-full border ${scoreColor}">Score: ${ep.score.toFixed(4)}</span>
        </div>
        <div class="font-mono text-xs text-blue-800 bg-white/70 border border-blue-100 rounded-lg px-3 py-2 break-all leading-6 select-all mb-2">${escapeHTML(ep.epitope_sequence || ep.sequence)}</div>
        <div class="flex flex-wrap gap-3 text-xs text-gray-500">
          <span><b class="text-gray-700">Position:</b> ${ep.start}–${ep.end}</span>
          <span><b class="text-gray-700">Longueur:</b> ${(ep.epitope_sequence || ep.sequence).length} aa</span>
          <span><b class="text-gray-700">Méthode:</b> ${escapeHTML(ep.method || d.method || '—')}</span>
          ${ep.epitope_id ? `<span><b class="text-gray-700">ID:</b> ${ep.epitope_id}</span>` : ''}
        </div>
      </div>

      <!-- Sequence Information -->
      <div class="mb-4">
        <h4 class="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          Informations de la séquence
        </h4>
        <div class="grid grid-cols-2 gap-2">
          ${detailItem('En-tête', seqInfo.header)}
          ${detailItem('Longueur', seqInfo.length)}
          ${detailItem('PDB', seqInfo.pdb)}
          ${detailItem('Date', seqInfo.date)}
        </div>
      </div>

      <!-- Module Results -->
      <div class="mb-4">
        <h4 class="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
          Résultats des modules
        </h4>
        <div class="grid grid-cols-2 gap-2 mb-2">
          ${detailItem('Méthodes', modRes.methods)}
          ${detailItem('Épitopes trouvés', modRes.epitopes_found)}
        </div>
        ${modRes.top_candidates ? `
          <div class="mt-2">
            <p class="text-[10px] font-semibold text-gray-500 mb-1">Top candidats</p>
            <pre class="text-[10px] font-mono text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-x-auto whitespace-pre leading-5">${escapeHTML(modRes.top_candidates)}</pre>
          </div>` : ''}
      </div>

      <!-- Residue Statistics -->
      <div class="mb-4">
        <h4 class="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5 text-teal-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
          Statistiques des résidus
        </h4>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          ${statCard('Score moyen', resStat.mean_global_score, 'blue')}
          ${statCard('Médiane', resStat.median, 'teal')}
          ${statCard('Écart-type', resStat.std_deviation, 'gray')}
          ${statCard('Min', resStat.min, 'green')}
          ${statCard('Max', resStat.max, 'red')}
          ${statCard('Résidus exposés', resStat.exposed_residues, 'violet')}
        </div>
      </div>

      <!-- Amino Acid Composition -->
      <div class="mb-2">
        <h4 class="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"/></svg>
          Composition en acides aminés
        </h4>
        <div class="grid grid-cols-3 gap-2">
          ${compBar('Hydrophiles', aaComp.hydrophilic, 'blue')}
          ${compBar('Hydrophobes', aaComp.hydrophobic, 'amber')}
          ${compBar('Chargés', aaComp.charged, 'rose')}
        </div>
      </div>
    `;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setTimeout(() => modal.querySelector('.modal-content').classList.add('scale-100', 'opacity-100'), 10);
  };

  window.closeEpitopeDetails = function () {
    const modal = document.getElementById('epitope-details-modal');
    const content = modal.querySelector('.modal-content');
    content.classList.remove('scale-100', 'opacity-100');
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }, 200);
  };

  function detailItem(label, value) {
    return `<div class="bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
      <p class="text-[10px] text-gray-400 mb-0.5">${escapeHTML(label)}</p>
      <p class="text-xs font-medium text-gray-700 truncate" title="${escapeHTML(String(value || '—'))}">${escapeHTML(String(value || '—'))}</p>
    </div>`;
  }

  const colorMap = {
    blue:   { bg: 'bg-blue-50',   border: 'border-blue-100',   text: 'text-blue-700',   fill: 'bg-blue-500' },
    teal:   { bg: 'bg-teal-50',   border: 'border-teal-100',   text: 'text-teal-700',   fill: 'bg-teal-500' },
    gray:   { bg: 'bg-gray-50',   border: 'border-gray-200',   text: 'text-gray-700',   fill: 'bg-gray-500' },
    green:  { bg: 'bg-green-50',  border: 'border-green-100',  text: 'text-green-700',  fill: 'bg-green-500' },
    red:    { bg: 'bg-red-50',    border: 'border-red-100',    text: 'text-red-700',    fill: 'bg-red-500' },
    violet: { bg: 'bg-violet-50', border: 'border-violet-100', text: 'text-violet-700', fill: 'bg-violet-500' },
    amber:  { bg: 'bg-amber-50',  border: 'border-amber-100',  text: 'text-amber-700',  fill: 'bg-amber-500' },
    rose:   { bg: 'bg-rose-50',   border: 'border-rose-100',   text: 'text-rose-700',   fill: 'bg-rose-500' },
  };

  function statCard(label, value, color) {
    const c = colorMap[color] || colorMap.gray;
    const display = value != null ? value : '—';
    return `<div class="text-center ${c.bg} rounded-lg px-2 py-2 border ${c.border}">
      <p class="text-[10px] text-gray-400 mb-0.5">${escapeHTML(label)}</p>
      <p class="text-sm font-bold ${c.text}">${escapeHTML(String(display))}</p>
    </div>`;
  }

  function compBar(label, value, color) {
    const c = colorMap[color] || colorMap.gray;
    const pctMatch = String(value || '').match(/([\d.]+)%/);
    const pct = pctMatch ? parseFloat(pctMatch[1]) : 0;
    return `<div class="${c.bg} rounded-lg px-3 py-2 border ${c.border}">
      <p class="text-[10px] text-gray-400 mb-1">${escapeHTML(label)}</p>
      <p class="text-xs font-bold ${c.text} mb-1">${escapeHTML(String(value || '—'))}</p>
      <div class="progress-thin"><div class="progress-thin-fill ${c.fill}" style="width:${pct}%"></div></div>
    </div>`;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

})();
