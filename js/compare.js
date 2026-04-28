/**
 * EpitopX AI — Comparaison de protéines (multi)
 * Supporte 2 à 6 protéines avec paires calculées et matrice de similarité
 */

(function () {
  'use strict';

  const MAX_PROTEINS = 6;
  const esc = Utils.escapeHTML;
  const SLOT_COLORS = ['#2563eb', '#0d9488', '#7c3aed', '#d97706', '#e11d48', '#4f46e5'];
  const SLOT_GRADIENTS = [
    'from-blue-100 to-blue-200 text-blue-700',
    'from-teal-100 to-teal-200 text-teal-700',
    'from-violet-100 to-violet-200 text-violet-700',
    'from-amber-100 to-amber-200 text-amber-700',
    'from-rose-100 to-rose-200 text-rose-700',
    'from-indigo-100 to-indigo-200 text-indigo-700',
  ];

  let allProteins = [];
  let selectedProteins = [null, null];
  let lastComparisons = [];

  // --- Init ---
  document.addEventListener('DOMContentLoaded', async () => {
    await loadProteins();
    renderSlots();
    const params = new URLSearchParams(window.location.search);
    const p1 = params.get('p1');
    const p2 = params.get('p2');
    if (p1) { selectedProteins[0] = allProteins.find(p => p.id === Number(p1)) || null; }
    if (p2) { selectedProteins[1] = allProteins.find(p => p.id === Number(p2)) || null; }
    if (p1 || p2) renderSlots();
    updateCompareButton();
  });

  async function loadProteins() {
    try {
      const cached = API.getCachedProteins();
      allProteins = cached.length ? cached : (await API.getAllProteins()).data || [];
    } catch (err) {
      console.warn('Could not load protein list', err);
    }
  }

  // --- Render all slots ---
  function renderSlots() {
    const container = document.getElementById('protein-slots');
    container.innerHTML = '';
    selectedProteins.forEach((protein, idx) => {
      container.appendChild(createSlotElement(idx, protein));
    });
    updateAddButton();
    updateCompareButton();
  }

  function createSlotElement(idx, protein) {
    const color = SLOT_COLORS[idx % SLOT_COLORS.length];
    const gradient = SLOT_GRADIENTS[idx % SLOT_GRADIENTS.length];
    const options = allProteins.map(p =>
      `<option value="${Number(p.id)}"${protein && protein.id === p.id ? ' selected' : ''}>${esc(p.name)} — ${esc(p.organism)}</option>`
    ).join('');

    const div = document.createElement('div');
    div.className = 'relative';
    div.dataset.slot = idx;
    div.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <label class="text-xs font-medium text-gray-400 uppercase tracking-wider">Protéine ${idx + 1}</label>
        ${selectedProteins.length > 2
          ? `<button onclick="removeSlot(${idx})" class="text-gray-300 hover:text-red-400 transition-colors" title="Supprimer">
               <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
             </button>`
          : ''}
      </div>
      <select class="input-field" onchange="onSlotChange(${idx}, this.value)">
        <option value="">— Sélectionner —</option>
        ${options}
      </select>
      <div class="slot-preview mt-3"></div>
    `;
    if (protein) {
      const preview = div.querySelector('.slot-preview');
      preview.innerHTML = `
        <div class="bg-gray-50 rounded-xl p-3 animate-fade-in">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-gradient-to-br ${gradient} flex items-center justify-center text-sm font-bold shrink-0">
              ${esc(protein.name.charAt(0))}
            </div>
            <div class="min-w-0">
              <p class="font-medium text-sm truncate text-gray-900">${esc(protein.name)}</p>
              <p class="text-[10px] text-gray-400">${esc(protein.organism)} • ${protein.sequence.length} aa</p>
            </div>
          </div>
        </div>
      `;
    }
    return div;
  }

  function updateAddButton() {
    const btn = document.getElementById('btn-add-protein');
    if (btn) btn.style.display = selectedProteins.length >= MAX_PROTEINS ? 'none' : '';
  }

  // --- Slot operations ---
  window.onSlotChange = function (idx, val) {
    selectedProteins[idx] = val ? allProteins.find(p => p.id === Number(val)) || null : null;
    const slotEl = document.querySelector(`#protein-slots [data-slot="${idx}"]`);
    const preview = slotEl ? slotEl.querySelector('.slot-preview') : null;
    if (preview) {
      const protein = selectedProteins[idx];
      const gradient = SLOT_GRADIENTS[idx % SLOT_GRADIENTS.length];
      preview.innerHTML = protein ? `
        <div class="bg-gray-50 rounded-xl p-3 animate-fade-in">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-gradient-to-br ${gradient} flex items-center justify-center text-sm font-bold shrink-0">
              ${esc(protein.name.charAt(0))}
            </div>
            <div class="min-w-0">
              <p class="font-medium text-sm truncate text-gray-900">${esc(protein.name)}</p>
              <p class="text-[10px] text-gray-400">${esc(protein.organism)} • ${protein.sequence.length} aa</p>
            </div>
          </div>
        </div>
      ` : '';
    }
    updateCompareButton();
  };

  window.addSlot = function () {
    if (selectedProteins.length >= MAX_PROTEINS) return;
    selectedProteins.push(null);
    renderSlots();
  };

  window.removeSlot = function (idx) {
    if (selectedProteins.length <= 2) return;
    selectedProteins.splice(idx, 1);
    renderSlots();
  };

  function updateCompareButton() {
    const filled = selectedProteins.filter(p => p !== null);
    const btn = document.getElementById('btn-compare');
    if (!btn) return;
    const ids = filled.map(p => p.id);
    const hasDupes = ids.length !== new Set(ids).size;
    btn.disabled = filled.length < 2 || hasDupes;
  }

  // --- Run comparisons ---
  window.runComparison = async function () {
    const filled = selectedProteins.filter(p => p !== null);
    if (filled.length < 2) return;
    const ids = filled.map(p => p.id);
    if (ids.length !== new Set(ids).size) {
      Utils.showToast('Des protéines en double ont été sélectionnées', 'warning');
      return;
    }

    const btn = document.getElementById('btn-compare');
    btn.disabled = true;
    btn.innerHTML = '<span class="animate-spin inline-block mr-2">⟳</span> Analyse en cours...';

    // All pairwise combinations
    const pairs = [];
    for (let i = 0; i < filled.length; i++) {
      for (let j = i + 1; j < filled.length; j++) {
        pairs.push([filled[i], filled[j]]);
      }
    }

    try {
      const comparisons = [];
      for (const [pA, pB] of pairs) {
        const response = await API.calculateSimilarity(pA.id, pB.id);
        if (!response.success) {
          Utils.showToast(`Erreur pour ${pA.name} vs ${pB.name}: ${response.error || 'Échec'}`, 'error');
          continue;
        }
        comparisons.push({ p1: pA, p2: pB, data: response.data });
      }
      lastComparisons = comparisons;
      showResults(filled, comparisons);
      Utils.showToast('Comparaison terminée', 'success');
    } catch (err) {
      Utils.showToast(`Erreur: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg> Comparer`;
    }
  };

  // --- Show results ---
  function showResults(proteins, comparisons) {
    document.getElementById('results-section').classList.remove('hidden');
    document.getElementById('compare-empty').classList.add('hidden');
    if (comparisons.length === 0) return;

    const isTwo = proteins.length === 2 && comparisons.length === 1;
    const first = comparisons[0];

    // Summary scores
    if (isTwo) {
      document.getElementById('score-identity').textContent = `${first.data.identity}%`;
      document.getElementById('score-matches').textContent = `${first.data.matches}/${first.data.total}`;
      document.getElementById('score-rmsd').textContent = `≈${first.data.rmsd}`;
      document.getElementById('score-gaps').textContent = `${first.data.gaps}`;
    } else {
      const avgIdentity = (comparisons.reduce((s, c) => s + c.data.identity, 0) / comparisons.length).toFixed(1);
      const avgRmsd = (comparisons.reduce((s, c) => s + parseFloat(c.data.rmsd), 0) / comparisons.length).toFixed(2);
      const totalGaps = comparisons.reduce((s, c) => s + c.data.gaps, 0);
      document.getElementById('score-identity').textContent = `${avgIdentity}%`;
      document.getElementById('score-matches').textContent = `${comparisons.length} paires`;
      document.getElementById('score-rmsd').textContent = `≈${avgRmsd}`;
      document.getElementById('score-gaps').textContent = `${totalGaps}`;
    }

    const identityVal = isTwo ? first.data.identity
      : parseFloat((comparisons.reduce((s, c) => s + c.data.identity, 0) / comparisons.length).toFixed(1));
    const bar = document.getElementById('identity-bar');
    bar.style.width = '0%';
    requestAnimationFrame(() => { bar.style.width = `${identityVal}%`; });

    // Similarity matrix (multi only)
    const matrixSection = document.getElementById('matrix-section');
    if (proteins.length > 2) {
      matrixSection.classList.remove('hidden');
      renderMatrix(proteins, comparisons);
    } else {
      matrixSection.classList.add('hidden');
    }

    // Properties table
    renderPropertiesTable(proteins);

    // Alignments
    renderAlignments(comparisons);

    // 3D links
    const linksContainer = document.getElementById('view-links');
    linksContainer.innerHTML = proteins.map(p => `
      <a href="viewer.html?id=${Number(p.id)}" class="btn-secondary flex items-center gap-2">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5"/></svg>
        Voir ${esc(p.name)}
      </a>
    `).join('');

    document.getElementById('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // --- Similarity matrix ---
  function renderMatrix(proteins, comparisons) {
    const lookup = {};
    comparisons.forEach(c => {
      lookup[`${c.p1.id}-${c.p2.id}`] = c.data;
      lookup[`${c.p2.id}-${c.p1.id}`] = c.data;
    });
    const headerCells = proteins.map((p, i) =>
      `<th class="py-2 px-3 text-center text-[10px] font-semibold" style="color:${SLOT_COLORS[i % SLOT_COLORS.length]}">${esc(p.name)}</th>`
    ).join('');
    const rows = proteins.map((pRow, i) => {
      const cells = proteins.map((pCol, j) => {
        if (i === j) return `<td class="py-2 px-3 text-center text-xs text-gray-300">—</td>`;
        const data = lookup[`${pRow.id}-${pCol.id}`];
        const identity = data ? data.identity : '?';
        const pct = typeof identity === 'number' ? identity : 0;
        const bg = pct >= 70 ? 'bg-emerald-100 text-emerald-700' : pct >= 40 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700';
        return `<td class="py-2 px-3 text-center text-xs font-semibold"><span class="inline-block px-2 py-0.5 rounded-full ${bg}">${identity}%</span></td>`;
      }).join('');
      return `<tr class="border-b border-gray-100">
        <td class="py-2 px-3 text-[10px] font-semibold" style="color:${SLOT_COLORS[i % SLOT_COLORS.length]}">${esc(pRow.name)}</td>
        ${cells}
      </tr>`;
    }).join('');
    document.getElementById('matrix-container').innerHTML = `
      <table class="w-full text-sm">
        <thead><tr class="border-b border-gray-200">
          <th class="py-2 px-3 text-left text-[10px] text-gray-400 uppercase tracking-wider">Protéine</th>
          ${headerCells}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // --- Properties table (N columns dynamic) ---
  function renderPropertiesTable(proteins) {
    const thead = document.querySelector('#properties-table thead tr');
    thead.innerHTML = `<th class="text-left py-3 px-4 text-gray-400 text-xs uppercase tracking-wider font-medium">Propriété</th>`
      + proteins.map((p, i) =>
          `<th class="text-center py-3 px-4 text-xs uppercase tracking-wider font-medium" style="color:${SLOT_COLORS[i % SLOT_COLORS.length]}">${esc(p.name)}</th>`
        ).join('');

    const propDefs = [
      { label: 'Nom complet', get: p => p.full_name },
      { label: 'Organisme', get: p => p.organism },
      { label: 'Longueur', get: p => `${p.sequence.length} aa` },
      { label: 'Masse moléculaire', get: p => `${Utils.formatNumber(p.molecular_weight)} Da` },
    ];
    document.getElementById('properties-body').innerHTML = propDefs.map(({ label, get }) => {
      const vals = proteins.map(get);
      const allSame = vals.every(v => v === vals[0]);
      const cells = vals.map(v =>
        `<td class="py-3 px-4 text-center text-xs ${allSame ? 'text-emerald-600' : 'text-gray-700'}">${esc(String(v))}</td>`
      ).join('');
      return `<tr class="border-b border-gray-100 hover:bg-gray-50 transition-colors">
        <td class="py-3 px-4 text-gray-500 text-xs">${label}</td>${cells}
      </tr>`;
    }).join('');
  }

  // --- Alignment visualization ---
  function renderAlignments(comparisons) {
    const container = document.getElementById('alignment-view');
    if (comparisons.length === 1) {
      container.innerHTML = renderAlignmentChunks(comparisons[0]);
    } else {
      container.innerHTML = comparisons.map((cmp, idx) => {
        const identity = cmp.data.identity;
        const pct = identity >= 70 ? 'text-emerald-600' : identity >= 40 ? 'text-amber-600' : 'text-red-500';
        return `
          <div class="border border-gray-200 rounded-xl mb-2 overflow-hidden">
            <button class="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50 transition-colors" onclick="toggleAlignment(${idx})">
              <span class="text-xs font-semibold text-gray-700">${esc(cmp.p1.name)} vs ${esc(cmp.p2.name)}</span>
              <div class="flex items-center gap-3">
                <span class="text-xs font-bold ${pct}">${identity}% identité</span>
                <svg id="align-chevron-${idx}" class="w-4 h-4 text-gray-400 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
              </div>
            </button>
            <div id="align-body-${idx}" class="hidden overflow-x-auto pb-4 px-3 pt-2">
              ${renderAlignmentChunks(cmp)}
            </div>
          </div>
        `;
      }).join('');
    }
  }

  window.toggleAlignment = function (idx) {
    document.getElementById(`align-body-${idx}`).classList.toggle('hidden');
    document.getElementById(`align-chevron-${idx}`).classList.toggle('rotate-180');
  };

  function renderAlignmentChunks(cmp) {
    const alignment = cmp.data.alignment;
    if (!alignment || alignment.length === 0) return '<p class="text-gray-400 text-xs py-2">Alignement indisponible</p>';
    const chunkSize = 50;
    const chunks = [];
    for (let i = 0; i < alignment.length; i += chunkSize) chunks.push(alignment.slice(i, i + chunkSize));
    return chunks.map((chunk, ci) => {
      const startPos = ci * chunkSize + 1;
      const row1 = chunk.map(a => {
        const cls = a.match ? 'match' : (a.aa1 === '-' || a.aa2 === '-' ? 'gap' : 'mismatch');
        return `<div class="alignment-cell ${cls}" title="Pos ${a.position}">${a.aa1}</div>`;
      }).join('');
      const mid = chunk.map(a => {
        const sym = a.match ? '|' : (a.aa1 === '-' || a.aa2 === '-' ? ' ' : '·');
        return `<div class="alignment-cell ${a.match ? 'text-emerald-600' : 'text-gray-300'}" style="height:1.2rem;font-size:0.6rem;border:none;">${sym}</div>`;
      }).join('');
      const row2 = chunk.map(a => {
        const cls = a.match ? 'match' : (a.aa1 === '-' || a.aa2 === '-' ? 'gap' : 'mismatch');
        return `<div class="alignment-cell ${cls}" title="Pos ${a.position}">${a.aa2}</div>`;
      }).join('');
      return `
        <div class="mb-4">
          <div class="text-[10px] text-gray-300 mb-1 font-mono">${startPos}</div>
          <div class="flex items-center gap-1 mb-0.5">
            <span class="text-[10px] w-14 shrink-0 text-right font-mono" style="color:#2563eb">${esc(cmp.p1.name)}</span>
            <div class="alignment-row">${row1}</div>
          </div>
          <div class="flex items-center gap-1 mb-0.5">
            <span class="w-14 shrink-0"></span>
            <div class="alignment-row">${mid}</div>
          </div>
          <div class="flex items-center gap-1">
            <span class="text-[10px] w-14 shrink-0 text-right font-mono" style="color:#0d9488">${esc(cmp.p2.name)}</span>
            <div class="alignment-row">${row2}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // --- Export ---
  window.exportComparison = function () {
    if (!lastComparisons.length) {
      Utils.showToast('Aucun résultat à exporter', 'warning');
      return;
    }
    const filled = selectedProteins.filter(p => p !== null);
    const lines = [
      '═══════════════════════════════════════════════════',
      '      EpitopX AI — Rapport de comparaison',
      '═══════════════════════════════════════════════════',
      '',
      `Date: ${new Date().toLocaleString('fr-FR')}`,
      `Protéines analysées: ${filled.length}`,
      '',
    ];
    filled.forEach((p, i) => {
      lines.push(`── Protéine ${i + 1}: ${p.name} ──`);
      lines.push(`Nom: ${p.full_name}`);
      lines.push(`Organisme: ${p.organism}`);
      lines.push(`Longueur: ${p.sequence.length} résidus`);
      lines.push(`Masse: ${p.molecular_weight} Da`);
      lines.push(`Séquence: ${p.sequence}`);
      lines.push('');
    });
    lines.push('── Résultats par paire ──');
    lastComparisons.forEach(cmp => {
      lines.push(`\n${cmp.p1.name} vs ${cmp.p2.name}:`);
      lines.push(`  Identité: ${cmp.data.identity}%`);
      lines.push(`  Correspondances: ${cmp.data.matches}/${cmp.data.total}`);
      lines.push(`  RMSD: ${cmp.data.rmsd} Å`);
      lines.push(`  Gaps: ${cmp.data.gaps}`);
      lines.push('  Alignement:');
      if (cmp.data.alignment) {
        const chunkSize = 60;
        for (let i = 0; i < cmp.data.alignment.length; i += chunkSize) {
          const chunk = cmp.data.alignment.slice(i, i + chunkSize);
          lines.push(`  ${cmp.p1.name}: ${chunk.map(a => a.aa1).join('')}`);
          lines.push(`  ${''.padStart(cmp.p1.name.length)}: ${chunk.map(a => a.match ? '|' : (a.aa1 === '-' || a.aa2 === '-' ? ' ' : '.')).join('')}`);
          lines.push(`  ${cmp.p2.name}: ${chunk.map(a => a.aa2).join('')}`);
          lines.push('');
        }
      }
    });
    lines.push('═══════════════════════════════════════════════════');
    lines.push('Généré par EpitopX AI v1.0');
    const names = filled.map(p => p.name).join('_vs_');
    Utils.downloadFile(lines.join('\n'), `comparison_${names}.txt`);
    Utils.showToast('Rapport exporté', 'success');
  };

  // --- Mobile menu ---
  window.toggleMobileMenu = function () {
    document.getElementById('mobile-menu').classList.toggle('open');
  };
})();
