/**
 * EpitopX AI — NCBI Protein Search (rebuilt UI)
 */
(function () {
  'use strict';

  // Route through local proxy for caching & throttling
  const NCBI         = '/api/ncbi/entrez/eutils';
  const NCBI_DIRECT  = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  const UNIPROT      = '/api/uniprot/uniprotkb';
  const UNI_FIELDS = 'accession,id,protein_name,gene_names,organism_name,sequence,reviewed,length';
  // Optional: set your NCBI API key in localStorage as 'ncbiApiKey' to unlock up to 10/s requests
  const _apiKey   = () => localStorage.getItem('ncbiApiKey') || '';
  const _apiParam = () => { const k = _apiKey(); return k ? `&api_key=${encodeURIComponent(k)}` : ''; };

  // Pagination safety
  const BLAST_PAGE_DELAY_MS = 500;   // 500ms between pages
  const BLAST_MAX_PAGES     = 6;     // Hard cap: max 6 pages (3,000 candidates)

  // Name-search background pagination
  const NAME_BATCH_SIZE    = 200;   // NCBI esummary max per call
  const NAME_PAGE_DELAY_MS = 350;   // 350ms between pages (polite to NCBI rate limits)
  const NAME_MAX_PAGES     = 50;    // Hard cap: 50 pages × 200 = 10,000 results max

  let _mode        = 'name';
  let _results     = [];
  let _searchToken = 0;
  let _page        = 1;
  const PAGE_SIZE  = 50;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Mode toggle ────────────────────────────────────────────────────────────
  window.switchMode = function (mode) {
    _mode = mode;
    document.getElementById('panel-name').classList.toggle('hidden', mode !== 'name');
    document.getElementById('panel-blast').classList.toggle('hidden', mode !== 'blast');
    document.getElementById('tab-name').classList.toggle('active', mode === 'name');
    document.getElementById('tab-blast').classList.toggle('active', mode === 'blast');
    // show relevant filter wrap
    const nf = document.getElementById('name-filters-wrap');
    const bf = document.getElementById('blast-filters-wrap');
    if (nf) nf.classList.toggle('hidden', mode !== 'name');
    if (bf) bf.classList.toggle('hidden', mode !== 'blast');
  };

  // ── Entry point ────────────────────────────────────────────────────────────
  window.runSearch = async function () {
    if (_mode === 'name') await _searchByName();
    else await _searchByBlast();
  };

  window.quickSearch = function (term) {
    document.getElementById('name-input').value = term;
    switchMode('name');
    runSearch();
  };

  // ── BLAST db pill selector ─────────────────────────────────────────────────
  window.setBlastDb = function (db, btn) {
    document.getElementById('blast-db').value = db;
    document.querySelectorAll('.db-pill').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
  };

  // ── Sequence char counter ──────────────────────────────────────────────────
  window.updateSeqCount = function (el) {
    const raw = el.value.trim();
    const seq = raw.startsWith('>') ?
      raw.split('\n').filter(l => !l.startsWith('>')).join('').replace(/\s/g, '') :
      raw.replace(/\s/g, '');
    const el2 = document.getElementById('seq-char-count');
    if (el2) el2.textContent = seq.length.toLocaleString() + ' aa';
  };

  // ── Result sorting ─────────────────────────────────────────────────────────
  window.sortResults = function (order) {
    _page = 1;
    if (!_results.length) return;
    const arr = [..._results];
    if (order === 'length-asc')  arr.sort((a,b) => (a.length||0) - (b.length||0));
    if (order === 'length-desc') arr.sort((a,b) => (b.length||0) - (a.length||0));
    if (order === 'name-asc')    arr.sort((a,b) => a.name.localeCompare(b.name));
    _renderList(arr);
  };

  // ── Filter helpers ─────────────────────────────────────────────────────────
  function _getNameFilters() {
    return {
      organism: document.getElementById('filter-organism')?.value.trim() || '',
      source:   document.getElementById('filter-source')?.value || '',
      lenMin:   parseInt(document.getElementById('filter-len-min')?.value) || 0,
      lenMax:   parseInt(document.getElementById('filter-len-max')?.value) || 0,
    };
  }

  function _getBlastFilters() {
    return {
      identity: parseInt(document.getElementById('blast-filter-identity')?.value) || 0,
    };
  }

  function _buildEntrezFilter(f) {
    const parts = [];
    if (f.organism) parts.push(`${f.organism}[Organism]`);
    if (f.source === 'refseq')    parts.push('refseq[Filter]');
    if (f.source === 'swissprot') parts.push('swissprot[Filter]');
    if (f.source === 'pdb')       parts.push('pdb[Filter]');
    if (f.source === 'embl')      parts.push('embl[Filter]');
    if (f.lenMin && f.lenMax) parts.push(`${f.lenMin}:${f.lenMax}[Sequence Length]`);
    else if (f.lenMin)        parts.push(`${f.lenMin}:99999999[Sequence Length]`);
    else if (f.lenMax)        parts.push(`1:${f.lenMax}[Sequence Length]`);
    return parts.join(' AND ');
  }

  window.toggleFilters = function () {
    const panel   = document.getElementById('filters-panel');
    const chevron = document.getElementById('filters-chevron');
    const open    = panel.classList.toggle('open');
    chevron.style.transform = open ? 'rotate(180deg)' : '';
  };

  window.resetFilters = function () {
    ['filter-organism','filter-source','filter-len-min','filter-len-max'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('filters-active-badge')?.classList.add('hidden');
  };

  window.toggleBlastFilters = function () {
    const panel   = document.getElementById('blast-filters-panel');
    const chevron = document.getElementById('blast-filters-chevron');
    const open    = panel.classList.toggle('open');
    chevron.style.transform = open ? 'rotate(180deg)' : '';
  };

  window.resetBlastFilters = function () {
    const iEl = document.getElementById('blast-filter-identity');
    if (iEl) iEl.value = '';
  };

  // ── UniProt helper for sequence search ───────────────────────────────────────
  async function _fetchUniPage(url) {
    // Rewrite direct UniProt URLs to go through our proxy
    const proxyUrl = url.replace('https://rest.uniprot.org/', '/api/uniprot/');
    const resp = await fetch(proxyUrl);
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('Retry-After') || '5', 10);
      console.warn(`[ncbi-search] Rate limited, waiting ${retryAfter}s…`);
      await sleep(retryAfter * 1000);
      const retryResp = await fetch(proxyUrl);
      if (!retryResp.ok) throw new Error(`UniProt returned HTTP ${retryResp.status} (after retry)`);
      const data = await retryResp.json();
      const link = retryResp.headers.get('Link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      return { results: data.results || [], nextUrl: m ? m[1] : null };
    }
    if (!resp.ok) throw new Error(`UniProt returned HTTP ${resp.status}`);
    const data = await resp.json();
    const link = resp.headers.get('Link') || '';
    const m    = link.match(/<([^>]+)>;\s*rel="next"/);
    return { results: data.results || [], nextUrl: m ? m[1] : null };
  }

  // ── k-mer Jaccard similarity (k=3 — better remote-homolog sensitivity) ─────
  function _kmerSim(s1, s2, k = 3) {
    if (!s1 || !s2 || s1.length < k || s2.length < k) return 0;
    const set1 = new Set(), set2 = new Set();
    for (let i = 0; i <= s1.length - k; i++) set1.add(s1.slice(i, i + k));
    for (let i = 0; i <= s2.length - k; i++) set2.add(s2.slice(i, i + k));
    let inter = 0;
    for (const km of set1) if (set2.has(km)) inter++;
    const union = set1.size + set2.size - inter;
    return union ? inter / union : 0;
  }

  // ── 2. Local sequence similarity search ────────────────────────────────
  async function _searchByBlast() {
    const rawSeq = document.getElementById('seq-input')?.value.trim() || '';
    const seq = (rawSeq.startsWith('>')
      ? rawSeq.split('\n').filter(l => !l.startsWith('>')).join('')
      : rawSeq
    ).replace(/\s/g, '').toUpperCase();

    if (seq.length < 10) {
      _setUiState('error', 'Sequence too short (minimum 10 amino acids).');
      return;
    }

    const keyword = document.getElementById('ncbi-seq-keyword')?.value.trim() || '';
    const hitlistVal = document.getElementById('hitlist-select')?.value || '20';
    const hitlist = hitlistVal === 'all' ? Infinity : (parseInt(hitlistVal) || 20);
    const f       = _getBlastFilters();
    const minSim  = f.identity / 100;
    const token   = ++_searchToken;

    _setUiState('loading');
    _setLoadingMsg('Fetching candidate proteins from UniProt…');

    try {
      const lenMin  = Math.max(1, Math.round(seq.length * 0.2));
      const lenMax  = Math.round(seq.length * 5);
      let uniQuery  = `length:[${lenMin} TO ${lenMax}]`;
      if (keyword) {
        const term = keyword.includes(' ') ? `"${keyword}"` : keyword;
        uniQuery   = `(${term}) AND ${uniQuery}`;
      }

      const url = `${UNIPROT}/search?query=${encodeURIComponent(uniQuery)}&format=json&size=500&fields=${UNI_FIELDS}`;
      let { results: page1, nextUrl } = await _fetchUniPage(url);
      if (token !== _searchToken) return;
      if (!page1.length) { _setUiState('empty'); return; }

      // ── Score helper ──────────────────────────────────────────────────────
      const scoreBatch = entries => {
        const out = [];
        for (const e of entries) {
          const acc     = e.primaryAccession || e.accession || '';
          const nameObj = e.proteinDescription?.recommendedName?.fullName ??
                          e.proteinDescription?.submittedName?.[0]?.fullName;
          const name    = nameObj?.value || e.id || 'Unknown protein';
          const organism = e.organism?.scientificName || '';
          const seqStr  = (e.sequence?.value || '').toUpperCase();
          const length  = e.sequence?.length || seqStr.length || 0;
          if (!seqStr || seqStr.length < 3) continue;
          const sim = _kmerSim(seq, seqStr);
          if (minSim > 0 && sim < minSim) continue;
          out.push({
            uid: acc, accession: acc, name, organism,
            length, source: 'UniProt',
            identity: Math.round(sim * 100), evalue: null, coverage: null,
            score: Math.round(sim * 100), type: 'blast',
            _sim: sim,
          });
        }
        return out;
      };

      _setLoadingMsg(`Scoring ${page1.length} candidates…`);
      await new Promise(r => setTimeout(r, 0));

      let allScored = scoreBatch(page1);
      allScored.sort((a, b) => b._sim - a._sim);
      _results = allScored.slice(0, hitlist);

      const makeLabel = (scanning) => {
        const base = keyword || `sequence (${seq.length} aa)`;
        return scanning ? `${base} — scanning more…` : base;
      };

      if (_results.length > 0) {
        _renderResults(_results, makeLabel(!!nextUrl), _results.length);
        _setUiState('results');
      }

      // ── Background pages — refine results silently (throttled, capped) ────
      for (let pg = 1; pg < BLAST_MAX_PAGES && nextUrl; pg++) {
        if (token !== _searchToken) return;
        // Throttle: wait between requests to avoid rate limiting
        await sleep(BLAST_PAGE_DELAY_MS);
        const more = await _fetchUniPage(nextUrl);
        if (token !== _searchToken) return;
        nextUrl   = more.nextUrl;
        allScored = allScored.concat(scoreBatch(more.results));
        allScored.sort((a, b) => b._sim - a._sim);
        _results  = allScored.slice(0, hitlist);
        if (_results.length > 0) {
          _renderResults(_results, makeLabel(!!nextUrl), _results.length);
          _setUiState('results');
        }
      }

      if (token !== _searchToken) return;
      if (!_results.length) _setUiState('empty');

    } catch (err) {
      if (token !== _searchToken) return;
      _setUiState('error', err.message);
    }
  }
  async function _searchByName() {
    const query    = document.getElementById('name-input').value.trim();
    if (!query) return;
    const limitVal = document.getElementById('retmax-select').value;
    const limit    = limitVal === 'all' ? Infinity : (parseInt(limitVal, 10) || 50);
    const filters  = _getNameFilters();
    const token    = ++_searchToken;

    const hasFilter = !!(filters.organism || filters.source || filters.lenMin || filters.lenMax);
    document.getElementById('filters-active-badge')?.classList.toggle('hidden', !hasFilter);

    _setUiState('loading');
    _results = [];
    _page    = 1;
    _setLoadingMsg('Searching NCBI protein database…');

    const progressEl = document.getElementById('loading-progress');
    if (progressEl) { progressEl.textContent = ''; progressEl.classList.add('hidden'); }

    try {
      const filterStr = _buildEntrezFilter(filters);
      const fullQuery = filterStr ? `(${query}) AND ${filterStr}` : query;
      const label     = fullQuery !== query ? `${query} (filtered)` : query;

      // Step 1 — get total count + history server handle (WebEnv / query_key)
      const esearchData = await _fetchJson(
        `${NCBI}/esearch.fcgi?db=protein&term=${encodeURIComponent(fullQuery)}&usehistory=y&retmax=0&retmode=json${_apiParam()}`
      );
      if (token !== _searchToken) return;

      const totalCount = parseInt(esearchData.esearchresult?.count) || 0;
      const webEnv     = esearchData.esearchresult?.webenv     || '';
      const queryKey   = esearchData.esearchresult?.querykey   || '';

      if (!totalCount || !webEnv) { _setUiState('empty'); return; }

      // Effective limit: user choice vs hard cap vs available records
      const maxFetchable    = NAME_MAX_PAGES * NAME_BATCH_SIZE;
      const effectiveLimit  = Math.min(
        totalCount,
        limit === Infinity ? maxFetchable : limit
      );

      _setLoadingMsg(`Found ${totalCount.toLocaleString()} proteins — loading first results…`);

      // Step 2 — paginate esummary using history handle; show UI after first batch
      let firstPageDone = false;

      for (let retstart = 0; retstart < effectiveLimit; retstart += NAME_BATCH_SIZE) {
        if (token !== _searchToken) return;

        const batchSize = Math.min(NAME_BATCH_SIZE, effectiveLimit - retstart);
        const data = await _fetchJson(
          `${NCBI}/esummary.fcgi?db=protein&query_key=${queryKey}&WebEnv=${encodeURIComponent(webEnv)}&retstart=${retstart}&retmax=${batchSize}&retmode=json${_apiParam()}`
        );
        if (token !== _searchToken) return;

        let batch = (data.result?.uids || []).map(uid => {
          const doc = data.result[uid];
          if (!doc || doc.error) return null;
          return {
            uid,
            accession: doc.accessionversion || uid,
            name:      doc.title || 'Unknown protein',
            organism:  doc.organism || '',
            length:    doc.slen || 0,
            source:    doc.sourcedb || '',
            type:      'name',
          };
        }).filter(Boolean);

        if (filters.lenMin) batch = batch.filter(p => p.length >= filters.lenMin);
        if (filters.lenMax) batch = batch.filter(p => !p.length || p.length <= filters.lenMax);

        _results = _results.concat(batch);

        if (!firstPageDone) {
          // Show results immediately after the very first batch
          if (_results.length > 0) {
            _renderResults(_results, label, totalCount);
            _setUiState('results');
            firstPageDone = true;
          } else if (retstart + batchSize >= effectiveLimit) {
            _setUiState('empty');
            return;
          }
        } else {
          // Background: update counter; keep current pagination page intact
          _updateCountBadge(totalCount);
          if (progressEl) {
            const pct = Math.round((_results.length / effectiveLimit) * 100);
            progressEl.textContent = `Loading… ${_results.length.toLocaleString()} / ${effectiveLimit.toLocaleString()} proteins (${pct}%)`;
            progressEl.classList.remove('hidden');
          }
        }

        // Be polite to NCBI rate limits between batches
        if (retstart + NAME_BATCH_SIZE < effectiveLimit) await sleep(NAME_PAGE_DELAY_MS);
      }

      if (token !== _searchToken) return;
      if (!_results.length) { _setUiState('empty'); return; }

      _updateCountBadge(totalCount);
      if (progressEl) progressEl.classList.add('hidden');

    } catch (err) {
      if (token !== _searchToken) return;
      _setUiState('error', err.message);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function _renderResults(results, query, total) {
    // Summary bar
    document.getElementById('results-summary').textContent = `Results for "${query}"`;
    // Reset sort & page
    const sortSel = document.getElementById('sort-select');
    if (sortSel) sortSel.value = 'default';
    _page = 1;
    _updateCountBadge(total);
    _renderPage();
  }

  // Update the count badge + hero-stats without resetting pagination
  function _updateCountBadge(total) {
    const shown = _results.length;
    const countEl = document.getElementById('results-count-badge');
    if (countEl) countEl.textContent =
      `${shown.toLocaleString()}${total && total > shown ? ' of ' + total.toLocaleString() : ''} proteins`;
    const stats = document.getElementById('hero-stats');
    if (stats) stats.classList.remove('hidden');
    const st = document.getElementById('stat-total');
    const ss = document.getElementById('stat-shown');
    if (st) st.textContent = total ? total.toLocaleString() : shown.toLocaleString();
    if (ss) ss.textContent = shown.toLocaleString();
  }

  function _renderPage() {
    const container = document.getElementById('results-container');
    if (!container) return;
    const total   = _results.length;
    const pages   = Math.ceil(total / PAGE_SIZE);
    const start   = (_page - 1) * PAGE_SIZE;
    const end     = Math.min(start + PAGE_SIZE, total);
    const slice   = _results.slice(start, end);

    container.innerHTML = slice.map((p, i) => _rowHtml(p, start + i)).join('');

    // update count badge to show current slice
    const cb = document.getElementById('results-count-badge');
    if (cb) cb.textContent = `${start + 1}–${end} of ${total} proteins`;

    // render pagination bar
    _renderPagination(pages);

    // scroll to top of results smoothly
    document.getElementById('results-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function _renderPagination(pages) {
    let bar = document.getElementById('pagination-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'pagination-bar';
      document.getElementById('results-container')?.after(bar);
    }
    if (pages <= 1) { bar.innerHTML = ''; return; }

    const prev = _page > 1;
    const next = _page < pages;

    // build page number buttons (show up to 7 around current)
    let pageBtns = '';
    const range = [];
    for (let i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || (i >= _page - 2 && i <= _page + 2)) range.push(i);
    }
    let last = 0;
    for (const p of range) {
      if (last && p - last > 1) pageBtns += `<span class="px-1 text-gray-300 select-none">…</span>`;
      pageBtns += `<button onclick="_goPage(${p})" class="page-btn${p === _page ? ' page-btn-active' : ''}">${p}</button>`;
      last = p;
    }

    bar.innerHTML = `
      <div class="flex items-center justify-center gap-2 mt-6 flex-wrap">
        <button onclick="_goPage(${_page - 1})" ${prev ? '' : 'disabled'} class="page-btn ${prev ? '' : 'opacity-40 cursor-not-allowed'}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
        </button>
        ${pageBtns}
        <button onclick="_goPage(${_page + 1})" ${next ? '' : 'disabled'} class="page-btn ${next ? '' : 'opacity-40 cursor-not-allowed'}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
        </button>
        <span class="text-xs text-gray-400 ml-2">Page ${_page} of ${pages}</span>
      </div>`;
  }

  window._goPage = function (p) {
    const pages = Math.ceil(_results.length / PAGE_SIZE);
    _page = Math.max(1, Math.min(p, pages));
    _renderPage();
  };

  function _rowHtml(p, idx) {
    const isBlast  = p.type === 'blast';
    const ncbiUrl  = `https://www.ncbi.nlm.nih.gov/protein/${encodeURIComponent(p.accession)}`;
    const accClass = isBlast ? 'acc-blast' : 'acc-ncbi';
    const label    = isBlast ? 'BLAST' : 'NCBI';

      const blastMetrics = isBlast ? `
      <div style="display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.45rem;">
        ${p.identity != null ? `<span class="metric-chip chip-id">${p.identity}% ${p.evalue == null ? 'similarity' : 'identity'}</span>` : ''}
        ${p.coverage  != null ? `<span class="metric-chip chip-cov">${p.coverage}% coverage</span>` : ''}
        ${p.evalue    != null ? `<span class="metric-chip chip-eval">E-value: ${_fmtEval(p.evalue)}</span>` : ''}
        ${p.score             ? `<span class="metric-chip chip-score">${p.evalue == null ? 'Score' : 'Bit score'}: ${p.score}</span>` : ''}
      </div>` : '';

    return `<div class="glass-card p-5 result-card fade-in">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 flex-wrap mb-2">
            <span class="acc-badge ${accClass}">${_esc(p.accession)}</span>
            <span class="source-badge">${label}</span>
            ${p.source ? `<span class="source-badge" style="background:#eff6ff;color:#3b82f6;">${_esc(p.source)}</span>` : ''}
          </div>
          <p class="font-semibold text-sm text-gray-900 leading-snug mb-1 truncate" title="${_esc(p.name)}">
            ${_esc(p.name.length > 120 ? p.name.slice(0,120) + '\u2026' : p.name)}
          </p>
          ${p.organism ? `<p class="text-xs text-gray-400 italic mb-1">${_esc(p.organism)}</p>` : ''}
          ${blastMetrics}
        </div>
        <div class="text-right shrink-0 pt-0.5">
          <span class="text-xs font-bold text-gray-400 whitespace-nowrap">${p.length ? p.length.toLocaleString() + ' aa' : '—'}</span>
        </div>
      </div>
      <div class="flex gap-2 flex-wrap mt-4 pt-3 border-t border-gray-100">
        <a href="${ncbiUrl}" target="_blank" rel="noopener noreferrer" class="action-btn action-ncbi">
          <svg style="width:.75rem;height:.75rem;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
          </svg>
          View on NCBI
        </a>
        <button onclick="downloadFasta('${_esc(p.accession)}')" class="action-btn action-fasta">
          <svg style="width:.75rem;height:.75rem;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
          </svg>
          FASTA
        </button>
        <a href="viewer.html?accession=${encodeURIComponent(p.accession)}" class="action-btn action-view">
          <svg style="width:.75rem;height:.75rem;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0zM2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
          </svg>
          3D Viewer
        </a>
      </div>
    </div>`;
  }

  function _fmtEval(e) {
    if (e === 0) return '0.0';
    if (typeof e !== 'number') return String(e);
    if (e < 1e-99) return e.toExponential(0);
    if (e < 0.001) return e.toExponential(1);
    return e.toPrecision(2);
  }

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Download FASTA ─────────────────────────────────────────────────────────
  window.downloadFasta = async function (acc) {
    _showToast(`Fetching FASTA for ${acc}…`, 'info');
    try {
      const res = await fetch(`${NCBI}/efetch.fcgi?db=protein&id=${encodeURIComponent(acc)}&rettype=fasta&retmode=text`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const a = Object.assign(document.createElement('a'), {
        href:     URL.createObjectURL(new Blob([text], { type: 'text/plain' })),
        download: `${acc}.fasta`,
      });
      a.click();
      URL.revokeObjectURL(a.href);
      _showToast(`Downloaded ${acc}.fasta`, 'success');
    } catch (err) {
      _showToast('FASTA download failed: ' + err.message, 'error');
    }
  };

  // ── Download All FASTA ─────────────────────────────────────────────────────
  window.downloadAllFasta = async function () {
    if (!_results || !_results.length) { _showToast('No results to download.', 'info'); return; }
    _showToast(`Fetching FASTA for ${_results.length} proteins…`, 'info');
    const accs = _results.map(r => r.accession).join(',');
    try {
      const res = await fetch(`${NCBI}/efetch.fcgi?db=protein&id=${encodeURIComponent(accs)}&rettype=fasta&retmode=text`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const a = Object.assign(document.createElement('a'), {
        href:     URL.createObjectURL(new Blob([text], { type: 'text/plain' })),
        download: `ncbi-proteins-${Date.now()}.fasta`,
      });
      a.click();
      URL.revokeObjectURL(a.href);
      _showToast(`Downloaded ${_results.length} sequences.`, 'success');
    } catch (err) {
      _showToast('Download failed: ' + err.message, 'error');
    }
  };

  // ── UI state ───────────────────────────────────────────────────────────────
  function _setUiState(state, errMsg) {
    ['loading-section','error-section','empty-section','results-section'].forEach(id =>
      document.getElementById(id)?.classList.add('hidden')
    );
    if (state !== 'idle') document.getElementById(state + '-section')?.classList.remove('hidden');
    if (state === 'error' && errMsg) {
      const el = document.getElementById('error-msg');
      if (el) el.textContent = errMsg;
    }
    if (state !== 'results') {
      const stats = document.getElementById('hero-stats');
      if (stats && state === 'loading') stats.classList.add('hidden');
    }
  }

  function _setLoadingMsg(msg) {
    const el = document.getElementById('loading-msg');
    if (el) el.textContent = msg;
  }

  async function _fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`NCBI API error HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  function _showToast(msg, type) {
    const colors = { success: '#10b981', error: '#ef4444', info: '#2563eb' };
    const el = document.createElement('div');
    el.style.cssText = `pointer-events:auto;background:#fff;border:1px solid #e2e8f0;border-left:4px solid ${colors[type]||colors.info};border-radius:10px;padding:10px 14px;font-size:.8rem;font-weight:500;box-shadow:0 4px 16px rgba(0,0,0,.1);max-width:320px;word-break:break-word;color:#1e293b;`;
    el.textContent = msg;
    const c = document.getElementById('toast-container');
    if (!c) return;
    c.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 4000);
  }

})();
