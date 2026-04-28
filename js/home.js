/**
 * EpitopX AI — Home page logic
 * Gère la conversion ADN → Protéine et la vérification en base
 */

(function () {
  'use strict';

  let currentProtein = '';
  const input = () => document.getElementById('dna-input');

  // --- Init ---
  document.addEventListener('DOMContentLoaded', () => {
    setupInputListener();
    Utils.setupScrollAnimations();
    setupScrollBehavior();
  });

  // --- Scroll: progress bar + floating nav compact + close mobile menu on scroll ---
  function setupScrollBehavior() {
    const bar = document.getElementById('scroll-progress-bar');
    const nav = document.getElementById('float-nav');
    const mm  = document.getElementById('mobile-menu');
    window.addEventListener('scroll', () => {
      const pct = (window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100;
      if (bar) bar.style.width = Math.min(pct, 100) + '%';
      if (nav) nav.classList.toggle('scrolled', window.scrollY > 40);
      if (mm && mm.classList.contains('open')) mm.classList.remove('open');
    }, { passive: true });
  }

  // --- Input listener for live char count ---
  function setupInputListener() {
    const el = input();
    if (!el) return;
    el.addEventListener('input', () => {
      const clean = DNAUtils.cleanSequence(el.value);
      document.getElementById('char-count').textContent = `${clean.length} nucléotides`;
      hideErrors();
    });
  }

  // --- Tab switching ---
  window.switchTab = function (tab) {
    document.getElementById('panel-text').classList.toggle('hidden', tab !== 'text');
    document.getElementById('panel-file').classList.toggle('hidden', tab !== 'file');
    document.getElementById('tab-text').classList.toggle('active', tab === 'text');
    document.getElementById('tab-file').classList.toggle('active', tab !== 'text');
  };

  // --- Mobile menu ---
  window.toggleMobileMenu = function () {
    const mm = document.getElementById('mobile-menu');
    mm.classList.toggle('open');
    const isOpen = mm.classList.contains('open');
    const burger = document.getElementById('nav-hamburger');
    const close  = document.getElementById('nav-close');
    if (burger) burger.classList.toggle('hidden', isOpen);
    if (close)  close.classList.toggle('hidden', !isOpen);
  };

  // --- Load example DNA ---
  window.loadExampleDNA = function () {
    const proteins = ProteinDataset.getAll();
    const withDNA = proteins.filter(p => p.dna_sequence);
    if (withDNA.length === 0) return;
    const p = withDNA[Math.floor(Math.random() * withDNA.length)];
    input().value = `>${p.gene} ${p.organism}\n${p.dna_sequence}`;
    input().dispatchEvent(new Event('input'));
    switchTab('text');
    Utils.showToast(`Exemple chargé : ${p.name}`, 'info', 2000);
  };

  // --- File handling ---
  window.handleFileDrop = function (e) {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) readFile(file);
  };

  window.handleFileSelect = function (e) {
    const file = e.target.files[0];
    if (file) readFile(file);
  };

  function readFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      input().value = e.target.result;
      input().dispatchEvent(new Event('input'));
      document.getElementById('file-info').classList.remove('hidden');
      document.getElementById('file-name').textContent = file.name;
      Utils.showToast(`Fichier "${file.name}" chargé`, 'success');
    };
    reader.onerror = () => Utils.showToast('Erreur de lecture du fichier', 'error');
    reader.readAsText(file);
  }

  // --- Convert DNA → Protein ---
  window.convertDNA = async function () {
    const raw = input().value.trim();
    if (!raw) {
      showErrors(['Veuillez entrer une séquence ADN ou importer un fichier FASTA.']);
      return;
    }

    const parsed   = DNAUtils.parseFASTA(raw);
    const clean    = DNAUtils.cleanSequence(raw);
    const validation = DNAUtils.validateDNA(clean);

    // Hard errors = anything that is not a trailing-nt warning
    const hardErrors = validation.errors.filter(
      e => !e.includes('trailing') && !e.includes('multiple')
    );
    if (hardErrors.length > 0) {
      showErrors(hardErrors);
      return;
    }

    hideErrors();
    const btn = document.getElementById('btn-convert');
    btn.disabled = true;
    btn.innerHTML = '<span class="animate-spin inline-block mr-2">⟳</span> Translating…';

    try {
      // translate() now does ORF detection internally
      const data = DNAUtils.translate(raw);

      if (!data.protein || data.protein.length === 0) {
        showErrors(['Translation produced no amino acids. Verify that your sequence contains a valid ATG start codon.']);
        return;
      }

      currentProtein = data.protein;
      showResult(data, parsed.header, raw);

      if (data.warnings && data.warnings.length > 0) {
        Utils.showToast(data.warnings[0], 'warning', 5000);
      } else {
        Utils.showToast(
          `Translation complete — ${data.length} aa, ORF in frame ${data.orf_frame}`,
          'success'
        );
      }
    } catch (err) {
      showErrors([`Error: ${err.message}`]);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg> Convertir en protéine`;
    }
  };

  // ── Result tabs ───────────────────────────────────────────────────────────
  window.switchResultTab = function (tab) {
    ['seq','analysis','composition','frames'].forEach(t => {
      const btn = document.getElementById('rtab-' + t);
      const pnl = document.getElementById('rpanel-' + t);
      if (btn) btn.classList.toggle('active', t === tab);
      if (pnl) pnl.classList.toggle('hidden', t !== tab);
    });
  };

  // ── Show result ───────────────────────────────────────────────────────────
  function showResult(data, header, rawDna) {
    document.getElementById('result-empty').classList.add('hidden');
    document.getElementById('result-content').classList.remove('hidden');

    const stats  = DNAUtils.proteinStats(data.protein);
    const fmtNum = n => new Intl.NumberFormat('en-US').format(Math.round(n));
    const fmtF   = (n, d = 2) => n != null ? n.toFixed(d) : '—';

    // ── Tab: Sequence ────────────────────────────────────────────────────
    const seqEl = document.getElementById('protein-sequence');
    seqEl.innerHTML = DNAUtils.sequenceToHTML(data.protein);

    const orfFrameLabel = data.orf_frame > 0 ? `+${data.orf_frame}` : `${data.orf_frame}`;
    document.getElementById('protein-length').textContent =
      `${data.length} aa · ${data.orf_codons} codons · ${data.orf_nt} nt (ORF) · ` +
      `${data.dna_length} nt (input) · ` +
      `frame ${orfFrameLabel} · pos ${data.orf_start}–${data.orf_end} · ` +
      `GC ${data.gc_orf ?? data.gc_content}% (ORF) · stop: ${data.stop_codon || 'none'}`;

    if (header) {
      const hEl = document.getElementById('result-header');
      if (hEl) { hEl.textContent = '>' + header; hEl.classList.remove('hidden'); }
    }

    // Copy FASTA button
    document.getElementById('protein-fasta-txt').value =
      (header ? `>${header}\n` : '>translated_protein\n') + data.protein;

    // ── Tab: Analysis ────────────────────────────────────────────────────
    document.getElementById('rpanel-analysis').innerHTML = `
      <p class="text-[10px] text-gray-400 mb-4">
        Physicochemical parameters computed by the ExPASy ProtParam method
        <span class="italic">(Gasteiger et al., 2005)</span>.
      </p>
      <div class="grid grid-cols-2 gap-3">
        ${statCard('Residues','aa-stat-card-blue', data.length, 'aa')}
        ${statCard('Mol. Weight','aa-stat-card-teal', fmtNum(stats.molecular_weight), 'Da')}
        ${statCard('MW (kDa)','aa-stat-card-sky', stats.molecular_weight_kda.toFixed(2), 'kDa')}
        ${statCard('pI','aa-stat-card-violet',
          stats.pI != null ? stats.pI : '—',
          '',
          'Isoelectric point · Bjellqvist et al., 1993')}
        ${statCard('GRAVY','aa-stat-card-indigo',
          stats.gravy != null ? stats.gravy : '—',
          '',
          'Grand Average of Hydropathicity · Kyte & Doolittle, 1982')}
        ${statCard('ε₂₈₀','aa-stat-card-amber',
          fmtNum(stats.extinction_coefficient),
          'M⁻¹cm⁻¹',
          'Extinction coefficient at 280 nm · Pace et al., 1995')}
        ${statCard('Instability','aa-stat-card-' + (stats.is_stable === false ? 'rose' : 'emerald'),
          stats.instability_index != null ? stats.instability_index : '—',
          '',
          `Instability index · Guruprasad et al., 1990 · ${stats.is_stable === false ? 'Unstable > 40' : stats.is_stable ? 'Stable ≤ 40' : ''}`)}
        ${statCard('Aliphatic Idx','aa-stat-card-orange',
          stats.aliphatic_index != null ? stats.aliphatic_index : '—',
          '',
          'Aliphatic index · Ikai, 1980')}
        ${statCard('GC Content','aa-stat-card-green', data.gc_content, '%',
          'GC content of the input DNA · Lobry, 1994')}
      </div>
      <div class="mt-4 text-[10px] text-gray-400 space-y-0.5 border-t border-gray-100 pt-3">
        <p><strong>References</strong></p>
        <p>[1] NCBI Standard Genetic Code (Table 1). ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi</p>
        <p>[2] Gasteiger E. et al. (2005). Proteomics Protocols Handbook. DOI:10.1385/1592598900</p>
        <p>[3] Bjellqvist B. et al. (1993). Electrophoresis 14:1023–1031.</p>
        <p>[4] Kyte J. & Doolittle R.F. (1982). J Mol Biol 157:105–132.</p>
        <p>[5] Pace C.N. et al. (1995). Protein Science 4:2411–2423.</p>
        <p>[6] Guruprasad K. et al. (1990). Protein Engineering 4:155–161.</p>
        <p>[7] Ikai A. (1980). J Biochem 88:1895–1898.</p>
      </div>
    `;

    // ── Tab: Composition ─────────────────────────────────────────────────
    const compEntries = Object.entries(stats.composition)
      .sort((a, b) => b[1] - a[1]);
    const maxCount = compEntries[0]?.[1] || 1;
    const compRows = compEntries.map(([aa, cnt]) => {
      const pct = ((cnt / data.length) * 100).toFixed(1);
      const barW = Math.round((cnt / maxCount) * 100);
      const cls = { nonpolar:'bg-blue-400', polar:'bg-teal-400',
                    positive:'bg-violet-400', negative:'bg-rose-400' };
      const barCls = cls[DNAUtils.AA_CLASS[aa]] || 'bg-gray-300';
      return `
        <div class="flex items-center gap-2 text-xs">
          <span class="w-5 font-mono font-bold text-gray-700">${aa}</span>
          <span class="w-28 text-gray-400 text-[10px] truncate">${DNAUtils.AA_NAMES[aa] || ''}</span>
          <div class="flex-1 bg-gray-100 rounded-full h-2">
            <div class="${barCls} h-2 rounded-full" style="width:${barW}%"></div>
          </div>
          <span class="w-8 text-right text-gray-500">${cnt}</span>
          <span class="w-10 text-right text-gray-400">${pct}%</span>
        </div>`;
    }).join('');

    const cls = stats.class_composition;
    // FIX: only render class chips whose count > 0 — prevents showing
    // "Polar 0 (0%)" for a pure nonpolar sequence like MPPP.
    const classChipsHtml = [
      ['Nonpolar / Hydrophobic', cls.nonpolar, data.length, 'bg-blue-100 text-blue-700'],
      ['Polar / Uncharged',      cls.polar,    data.length, 'bg-teal-100 text-teal-700'],
      ['Positively charged',     cls.positive, data.length, 'bg-violet-100 text-violet-700'],
      ['Negatively charged',     cls.negative, data.length, 'bg-rose-100 text-rose-700'],
    ].filter(([, count]) => count > 0)
     .map(args => classChip(...args))
     .join('');
    document.getElementById('rpanel-composition').innerHTML = `
      <div class="flex gap-3 mb-4 flex-wrap">
        ${classChipsHtml}
      </div>
      <div class="space-y-1.5">${compRows}</div>
    `;

    // ── Tab: All 6 Reading Frames (ExPASy Translate-style) ─────────────────
    const allSixFrames = DNAUtils.translateAllSixFrames(rawDna || '');
    const bestFrameLabel = data.orf_frame ? `+${data.orf_frame}` : null;

    function renderFrameCard(f) {
      const isFwd  = f.strand === '+';
      const isBest = f.label === bestFrameLabel;
      const cardBorder  = isBest ? 'border-blue-400' : isFwd ? 'border-emerald-200' : 'border-violet-200';
      const cardBg      = isBest ? 'bg-blue-50/40'   : 'bg-white';
      const headerBg    = isBest ? 'bg-blue-50 border-blue-100'
                        : isFwd  ? 'bg-emerald-50/60 border-emerald-100'
                                 : 'bg-violet-50/60 border-violet-100';
      const labelCls    = isBest ? 'bg-blue-600 text-white'
                        : isFwd  ? 'bg-emerald-100 text-emerald-800'
                                 : 'bg-violet-100 text-violet-800';
      const escapedProt = f.protein.replace(/`/g, '\\`');
      return `
        <div class="border ${cardBorder} ${cardBg} rounded-xl overflow-hidden transition-shadow hover:shadow-md">
          <div class="flex items-center justify-between px-4 py-2 border-b ${headerBg} flex-wrap gap-2">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-bold font-mono text-xs px-2 py-0.5 rounded-md ${labelCls}">Frame ${f.label}</span>
              ${isBest ? '<span class="text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded-full">✓ Selected</span>' : ''}
              <span class="text-xs text-gray-500 font-medium">${f.length} aa</span>
              <span class="text-xs flex items-center gap-0.5">
                <span class="aa-stop font-bold">*</span>
                <span class="text-gray-500">${f.stopCount} stop${f.stopCount !== 1 ? 's' : ''}</span>
              </span>
              <span class="text-xs flex items-center gap-0.5">
                <span class="aa-start font-bold">M</span>
                <span class="text-gray-500">${f.startCount} Met</span>
              </span>
              <span class="text-xs text-gray-400">${f.orfCount} ORF${f.orfCount !== 1 ? 's' : ''}</span>
            </div>
            <button class="text-[11px] text-blue-500 hover:text-blue-700 flex items-center gap-1 transition-colors"
                    onclick="copyFrameSeq('${f.label}', \`${escapedProt}\`)">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
              Copy
            </button>
          </div>
          <div class="px-3 py-2.5">
            <div class="frame-seq-display" style="background:${isBest ? '#eff6ff' : isFwd ? '#f0fdf4' : '#faf5ff'}">
              ${DNAUtils.frameSequenceToHTML(
                f.protein,
                isBest ? 'rgba(59,130,246,0.22)' :
                isFwd  ? 'rgba(16,185,129,0.22)' :
                         'rgba(139,92,246,0.22)'
              )}
            </div>
          </div>
        </div>`;
    }

    const fwdCards = allSixFrames.filter(f => f.strand === '+').map(renderFrameCard).join('');
    const revCards = allSixFrames.filter(f => f.strand === '-').map(renderFrameCard).join('');

    document.getElementById('rpanel-frames').innerHTML = `
      <div class="flex items-start justify-between gap-2 mb-4 flex-wrap">
        <div>
          <p class="text-xs font-semibold text-gray-800">Six-Frame Translation</p>
          <p class="text-[10px] text-gray-400 mt-0.5">
            ExPASy-style &mdash; NCBI Standard Genetic Code (Table 1) &middot; ${data.dna_length} nt &middot; GC ${data.gc_content}%
          </p>
        </div>
        <div class="flex flex-wrap gap-2.5 text-[10px] leading-none items-center">
          <span class="flex items-center gap-1"><span class="aa-start font-bold text-xs">M</span> Start (Met)</span>
          <span class="flex items-center gap-1"><span class="aa-stop  font-bold text-xs">*</span> Stop codon</span>
          <span class="flex items-center gap-1"><span class="aa-nonpolar font-bold text-xs">A</span> Nonpolar</span>
          <span class="flex items-center gap-1"><span class="aa-polar    font-bold text-xs">S</span> Polar</span>
          <span class="flex items-center gap-1"><span class="aa-positive font-bold text-xs">K</span> Basic</span>
          <span class="flex items-center gap-1"><span class="aa-negative font-bold text-xs">D</span> Acidic</span>
        </div>
      </div>

      <div class="mb-5">
        <div class="flex items-center gap-2 mb-3">
          <div class="h-px flex-1 bg-emerald-200"></div>
          <span class="text-[11px] font-semibold text-emerald-700 uppercase tracking-widest px-2">&#10230; Forward strand 5&#x27;&#x2192;3&#x27;</span>
          <div class="h-px flex-1 bg-emerald-200"></div>
        </div>
        <div class="space-y-3">${fwdCards}</div>
      </div>

      <div>
        <div class="flex items-center gap-2 mb-3">
          <div class="h-px flex-1 bg-violet-200"></div>
          <span class="text-[11px] font-semibold text-violet-700 uppercase tracking-widest px-2">&#10229; Reverse complement 3&#x27;&#x2192;5&#x27;</span>
          <div class="h-px flex-1 bg-violet-200"></div>
        </div>
        <div class="space-y-3">${revCards}</div>
      </div>
    `;

    document.getElementById('db-result').innerHTML = '';
    switchResultTab('seq');
    Utils.animateIn(document.getElementById('result-content'));
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  function statCard(label, colorClass, value, unit, tooltip = '') {
    return `
      <div class="${colorClass} rounded-xl p-3 text-center" title="${tooltip}">
        <div class="text-base font-bold leading-tight">${value}${unit ? `<span class="text-[10px] font-normal ml-0.5">${unit}</span>` : ''}</div>
        <div class="text-[10px] uppercase tracking-wider mt-0.5 opacity-70">${label}</div>
      </div>`;
  }

  function classChip(label, count, total, cls) {
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0';
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium ${cls}">
      ${label} <span class="font-bold">${count} (${pct}%)</span>
    </span>`;
  }

  // --- Copy a frame sequence to clipboard ---
  window.copyFrameSeq = function (label, seq) {
    navigator.clipboard.writeText(seq)
      .then(() => Utils.showToast(`Frame ${label} copied to clipboard`, 'success'))
      .catch(() => Utils.showToast('Copy failed — try again', 'error'));
  };

  // --- Check in DB ---
  window.checkInDatabase = async function () {
    if (!currentProtein) {
      Utils.showToast('Aucune protéine à vérifier', 'warning');
      return;
    }

    const btn = document.getElementById('btn-check-db');
    btn.disabled = true;
    btn.innerHTML = '<span class="animate-spin inline-block mr-2">⟳</span> Recherche...';

    try {
      const response = await API.checkProteinInDB(currentProtein);
      const container = document.getElementById('db-result');

      if (response.found) {
        const p = response.data;
        container.innerHTML = `
          <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-5 animate-fade-in">
            <div class="flex items-center gap-2 mb-3">
              <svg class="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              <span class="text-emerald-700 font-semibold">Protéine trouvée !</span>
            </div>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between"><span class="text-gray-400">Nom</span><span class="font-medium text-gray-900">${p.name} — ${p.full_name}</span></div>
              <div class="flex justify-between"><span class="text-gray-400">Organisme</span><span class="text-gray-700">${p.organism}</span></div>
              <div class="flex justify-between"><span class="text-gray-400">Famille</span><span class="text-gray-700">${p.family}</span></div>
              <div class="flex justify-between"><span class="text-gray-400">Masse mol.</span><span class="text-gray-700">${Utils.formatNumber(p.molecular_weight)} Da</span></div>
              <p class="text-gray-500 text-xs mt-2">${p.description}</p>
              <div class="flex gap-2 mt-3 flex-wrap">
                ${p.tags.map(t => `<span class="tag tag-violet">${t}</span>`).join('')}
              </div>
            </div>
            <div class="flex gap-2 mt-4">
              <a href="viewer.html?id=${p.id}" class="btn-primary text-xs flex items-center gap-1 flex-1 justify-center">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5"/></svg>
                Voir en 3D
              </a>
              <a href="dashboard.html" class="btn-secondary text-xs flex items-center gap-1">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"/></svg>
                Dashboard
              </a>
            </div>
          </div>
        `;
        Utils.showToast(`Correspondance trouvée : ${p.name}`, 'success');
      } else {
        container.innerHTML = `
          <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 animate-fade-in">
            <div class="flex items-center gap-2 mb-2">
              <svg class="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.268 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg>
              <span class="text-amber-600 font-semibold">Protéine non trouvée</span>
            </div>
            <p class="text-sm text-gray-500">Cette séquence protéique ne correspond à aucune entrée dans la base de données locale.</p>
            <p class="text-xs text-gray-400 mt-2">Essayez une des séquences d'exemple ou explorez le dashboard.</p>
          </div>
        `;
        Utils.showToast('Aucune correspondance trouvée', 'warning');
      }
    } catch (err) {
      Utils.showToast(`Erreur: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg> Vérifier dans la base`;
    }
  };

  // --- Copy protein ---
  window.copyProtein = function () {
    if (currentProtein) Utils.copyToClipboard(currentProtein);
  };

  // --- Copy protein as FASTA ---
  window.copyFASTA = function () {
    const txt = document.getElementById('protein-fasta-txt');
    if (txt && txt.value) Utils.copyToClipboard(txt.value);
  };

  // --- Clear ---
  window.clearInput = function () {
    input().value = '';
    input().dispatchEvent(new Event('input'));
    currentProtein = '';
    document.getElementById('result-empty').classList.remove('hidden');
    document.getElementById('result-content').classList.add('hidden');
    document.getElementById('db-result').innerHTML = '';
    hideErrors();
    document.getElementById('file-info').classList.add('hidden');
  };

  // --- Errors ---
  function showErrors(errors) {
    const box = document.getElementById('error-box');
    const list = document.getElementById('error-list');
    list.innerHTML = errors.map(e => `<li>• ${e}</li>`).join('');
    box.classList.remove('hidden');
    Utils.animateIn(box);
  }

  function hideErrors() {
    document.getElementById('error-box').classList.add('hidden');
  }
})();
