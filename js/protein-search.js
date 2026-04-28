/**
 * EpitopX AI — UniProt Protein FASTA Search
 *
 * Searches UniProt (rest.uniprot.org) for a protein by name:
 *  - First reviewed Swiss-Prot hit = reference protein
 *  - Top N hits (any review level) = similar proteins
 * Allows downloading individual or combined FASTA files.
 */

(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────
  let _refProtein   = null;   // { accession, name, organism, length, reviewed, sequence, fasta }
  let _similarList  = [];     // array of same shape
  let _currentQuery = '';
  let _activeTab    = 'ref';
  let _mode         = 'name'; // 'name' | 'blast'

  // ─── Render / pagination state ───────────────────────────────────────────
  const RENDER_BATCH = 50;   // cards appended per scroll-trigger
  let _renderedCount = 0;
  let _observer      = null;
  let _searchToken   = 0;    // incremented each search to cancel stale background fetches

  // Fields to request from UniProt REST
  const FIELDS = 'accession,id,protein_name,gene_names,organism_name,sequence,reviewed,length';

  // Route through local proxy for caching & throttling — falls back to direct for cursor URLs
  const UNIPROT_PROXY = '/api/uniprot/uniprotkb';
  const UNIPROT_DIRECT = 'https://rest.uniprot.org/uniprotkb';

  // ─── Pagination safety limits ────────────────────────────────────────────
  const MAX_BACKGROUND_PAGES = 20;       // Hard cap: max 20 background pages (10,000 results)
  const PAGE_DELAY_MS        = 400;      // 400ms delay between pagination requests
  const BLAST_MAX_PAGES      = 10;       // Max pages for sequence similarity search

  // ─── Entry point ─────────────────────────────────────────────────────────
  window.runSearch = async function () {
    if (_mode === 'blast') { await _searchByBlast(); return; }
    const raw = document.getElementById('search-input').value.trim();
    if (!raw) return;
    _currentQuery = raw;
    const sizeVal = document.getElementById('size-select').value;
    const size = sizeVal === 'all' ? 'all' : (parseInt(sizeVal, 10) || 20);
    await _doSearch(raw, size);
  };

  window.switchMode = function (mode) {
    _mode = mode;
    document.getElementById('uni-panel-name').classList.toggle('hidden', mode !== 'name');
    document.getElementById('uni-panel-blast').classList.toggle('hidden', mode !== 'blast');
    document.getElementById('uni-tab-name').classList.toggle('active', mode === 'name');
    document.getElementById('uni-tab-blast').classList.toggle('active', mode === 'blast');
  };

  window.toggleUniBlastFilters = function () {
    const panel   = document.getElementById('uni-blast-filters');
    const chevron = document.getElementById('uni-blast-chevron');
    if (!panel) return;
    const hidden = panel.classList.toggle('hidden');
    if (chevron) chevron.style.transform = hidden ? '' : 'rotate(-180deg)';
  };

  window.resetUniBlastFilters = function () {
    const id = document.getElementById('uni-blast-identity');
    if (id) id.value = '';
  };

  window.quickSearch = function (term) {
    document.getElementById('search-input').value = term;
    document.getElementById('size-select').value = 'all';
    runSearch();
  };

  window.setLenPreset = function (min, max) {
    document.getElementById('uni-len-min').value = min > 0 ? min : '';
    document.getElementById('uni-len-max').value = (max > 0 && max < 99999) ? max : '';
  };

  // ─── Sleep helper ─────────────────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * Fetch one UniProt page. Routes initial requests through the local proxy
   * (for server-side caching & throttling). Cursor URLs from UniProt's Link
   * header point directly to rest.uniprot.org — we rewrite them to go through
   * the proxy as well.
   */
  async function _fetchPage(url) {
    // Rewrite direct UniProt URLs to go through our proxy
    const proxyUrl = url.replace('https://rest.uniprot.org/', '/api/uniprot/');

    const resp = await fetch(proxyUrl);
    if (resp.status === 429) {
      // Rate limited — wait and retry once
      const retryAfter = parseInt(resp.headers.get('Retry-After') || '5', 10);
      console.warn(`[protein-search] Rate limited, waiting ${retryAfter}s…`);
      await sleep(retryAfter * 1000);
      const retryResp = await fetch(proxyUrl);
      if (!retryResp.ok) throw new Error(`UniProt returned HTTP ${retryResp.status} (after retry)`);
      const data = await retryResp.json();
      const link = retryResp.headers.get('Link') || '';
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      return { results: data.results || [], nextUrl: match ? match[1] : null };
    }
    if (!resp.ok) throw new Error(`UniProt returned HTTP ${resp.status}`);
    const data = await resp.json();
    const link = resp.headers.get('Link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    const nextUrl = match ? match[1] : null;
    return { results: data.results || [], nextUrl };
  }

  // ─── Core search — streams pages, shows UI after first page ──────────────
  async function _doSearch(query, size) {
    const token = ++_searchToken;  // invalidate any in-flight background fetch
    _setUiState('loading');
    _renderedCount = 0;
    _similarList   = [];
    _refProtein    = null;
    if (_observer) { _observer.disconnect(); _observer = null; }

    const progressEl = document.getElementById('loading-progress');
    if (progressEl) { progressEl.textContent = ''; progressEl.classList.add('hidden'); }

    try {
      const reviewedUrl  =
        `${UNIPROT_PROXY}/search?query=${encodeURIComponent(query + ' AND reviewed:true')}` +
        `&format=json&size=1&fields=${FIELDS}`;
      const firstPageUrl =
        `${UNIPROT_PROXY}/search?query=${encodeURIComponent(query)}` +
        `&format=json&size=500&fields=${FIELDS}`;

      // Fetch reference entry and first results page simultaneously
      const [reviewedPage, firstPage] = await Promise.all([
        _fetchPage(reviewedUrl),
        _fetchPage(firstPageUrl),
      ]);

      if (token !== _searchToken) return;  // superseded by a newer search

      if (firstPage.results.length === 0 && reviewedPage.results.length === 0) {
        _setUiState('empty');
        return;
      }

      const refRaw = reviewedPage.results[0] || firstPage.results[0];
      _refProtein  = _parseEntry(refRaw, true);

      const _lenMin = parseInt(document.getElementById('uni-len-min')?.value) || 0;
      const _lenMax = parseInt(document.getElementById('uni-len-max')?.value) || 0;
      const _lenFilter = p => (!_lenMin || p.length >= _lenMin) && (!_lenMax || p.length <= _lenMax);

      _similarList = firstPage.results
        .filter(e => _accession(e) !== _refProtein.accession)
        .map(e => _parseEntry(e, false))
        .filter(_lenFilter);

      // ── Show results immediately — don't wait for all pages ──
      _renderResults();
      _setUiState('results');
      switchTab('ref');

      // ── Fetch remaining pages in background (throttled, capped) ──────────
      const limit = size === 'all' ? Infinity : (size - 1);
      let nextUrl = firstPage.nextUrl;
      let pagesFetched = 0;

      while (nextUrl && _similarList.length < limit && pagesFetched < MAX_BACKGROUND_PAGES) {
        if (token !== _searchToken) return;  // new search started, stop

        // Throttle: wait between requests to avoid rate limiting
        await sleep(PAGE_DELAY_MS);

        const { results, nextUrl: next } = await _fetchPage(nextUrl);
        pagesFetched++;
        const newParsed = results
          .filter(e => _accession(e) !== _refProtein.accession)
          .map(e => _parseEntry(e, false))
          .filter(_lenFilter);

        _similarList = _similarList.concat(newParsed);
        _updateSimilarCount();
        if (progressEl) {
          progressEl.textContent = `${_similarList.length.toLocaleString()} proteins loaded… (page ${pagesFetched + 1}/${MAX_BACKGROUND_PAGES})`;
          progressEl.classList.remove('hidden');
        }
        nextUrl = next;
      }

      if (pagesFetched >= MAX_BACKGROUND_PAGES && nextUrl) {
        console.warn(`[protein-search] Stopped at ${MAX_BACKGROUND_PAGES} pages (${_similarList.length} results) to prevent rate limiting`);
      }

      if (token !== _searchToken) return;
      _updateSimilarCount();
      if (progressEl) progressEl.classList.add('hidden');

    } catch (err) {
      if (token !== _searchToken) return;
      console.error('[protein-search]', err);
      document.getElementById('error-msg').textContent = err.message;
      _setUiState('error');
    }
  }

  // ─── Parse a single UniProt entry ────────────────────────────────────────
  function _parseEntry(entry, isRef) {
    const acc      = _accession(entry);
    const name     = _proteinName(entry);
    const organism = entry.organism?.scientificName || entry.organism?.commonName || '—';
    const gene     = (entry.genes || []).map(g => g.geneName?.value || '').filter(Boolean).join(', ') || '—';
    const length   = entry.sequence?.length || 0;
    const sequence = entry.sequence?.value || '';
    const reviewed = entry.entryType === 'UniProtKB reviewed (Swiss-Prot)';

    const fastaHeader = `>${acc}|${isRef ? 'ref' : 'similar'}|${name} OS=${organism} GN=${gene} SV=1`;
    const fastaSeq    = _formatSeq(sequence);
    const fasta       = `${fastaHeader}\n${fastaSeq}`;

    return { accession: acc, name, organism, gene, length, sequence, reviewed, fasta, isRef };
  }

  function _accession(entry) {
    return entry.primaryAccession || entry.accession || 'N/A';
  }

  function _proteinName(entry) {
    return (
      entry.proteinDescription?.recommendedName?.fullName?.value ||
      entry.proteinDescription?.submittedName?.[0]?.fullName?.value ||
      entry.id ||
      'Unknown protein'
    );
  }

  // 60-char wrapped FASTA sequence
  function _formatSeq(seq) {
    return seq.match(/.{1,60}/g)?.join('\n') || '';
  }

  // ─── Render helpers ───────────────────────────────────────────────────────
  function _updateSimilarCount() {
    const total = (_mode === 'blast' ? 0 : 1) + _similarList.length;
    document.getElementById('results-count-badge').textContent =
      `${total.toLocaleString()} sequence${total !== 1 ? 's' : ''}`;
    document.getElementById('similar-count-label').textContent =
      _similarList.length.toLocaleString();
  }

  function _setupSentinel() {
    if (_observer) _observer.disconnect();
    const sentinel = document.getElementById('sim-sentinel');
    if (!sentinel) return;
    _observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) _renderMoreCards();
    }, { rootMargin: '400px' });
    _observer.observe(sentinel);
  }

  function _renderMoreCards() {
    const simContainer = document.getElementById('similar-proteins-container');
    const sentinel     = document.getElementById('sim-sentinel');
    if (!simContainer || !sentinel) return;

    const batch = _similarList.slice(_renderedCount, _renderedCount + RENDER_BATCH);
    if (batch.length === 0) return;

    const frag = document.createDocumentFragment();
    batch.forEach(p => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = _buildSimilarCard(p);
      frag.appendChild(wrapper.firstElementChild);
    });
    simContainer.insertBefore(frag, sentinel);
    _renderedCount += batch.length;
  }

  // ─── k-mer Jaccard similarity (k=3 — better remote-homolog sensitivity) ──────
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

  // ─── Local sequence similarity search ─────────────────────────────────────────
  async function _searchByBlast() {
    const rawSeq = document.getElementById('uni-seq-input')?.value.trim() || '';
    const seq = (rawSeq.startsWith('>')
      ? rawSeq.split('\n').filter(l => !l.startsWith('>')).join('')
      : rawSeq
    ).replace(/\s/g, '').toUpperCase();

    if (seq.length < 10) {
      _setUiState('error');
      document.getElementById('error-msg').textContent = 'Sequence too short (minimum 10 amino acids).';
      return;
    }

    const keyword = document.getElementById('uni-seq-keyword')?.value.trim() || '';
    const hitlistVal = document.getElementById('uni-hitlist-select')?.value || '20';
    const hitlist = hitlistVal === 'all' ? Infinity : (parseInt(hitlistVal) || 20);
    const minSim  = (parseInt(document.getElementById('uni-blast-identity')?.value) || 0) / 100;
    const token   = ++_searchToken;

    _refProtein  = null;
    _similarList = [];
    _setUiState('loading');
    const loadMsg = document.getElementById('loading-msg');
    if (loadMsg) loadMsg.textContent = 'Fetching candidate proteins from UniProt…';

    try {
      const lenMin  = Math.max(1, Math.round(seq.length * 0.2));
      const lenMax  = Math.round(seq.length * 5);
      let uniQuery  = `length:[${lenMin} TO ${lenMax}]`;
      if (keyword) uniQuery = `(${encodeQueryTerm(keyword)}) AND ${uniQuery}`;

      // How many pages to fetch: 500 results/page × MAX_PAGES = max candidates
      // Always capped at BLAST_MAX_PAGES to prevent rate limiting
      const computed = hitlist === Infinity ? BLAST_MAX_PAGES : Math.ceil((hitlist * 4) / 500);
      const MAX_PAGES = Math.min(computed, BLAST_MAX_PAGES);

      const url = `${UNIPROT_PROXY}/search?query=${encodeURIComponent(uniQuery)}&format=json&size=500&fields=${FIELDS}`;
      let { results: page1, nextUrl } = await _fetchPage(url);
      if (token !== _searchToken) return;
      if (!page1.length) { _setUiState('empty'); return; }

      // ── Score helper ────────────────────────────────────────────────────────────────
      const scoreBatch = entries => {
        const out = [];
        for (const e of entries) {
          const p = _parseEntry(e, false);
          if (!p.sequence || p.sequence.length < 3) continue;
          const sim = _kmerSim(seq, p.sequence.toUpperCase());
          if (minSim > 0 && sim < minSim) continue;
          p.blastMeta = { score: sim, identity: Math.round(sim * 100), evalue: null, coverage: null };
          out.push(p);
        }
        return out;
      };

      if (loadMsg) loadMsg.textContent = `Scoring ${page1.length} candidates…`;
      await new Promise(r => setTimeout(r, 0));

      let allScored       = scoreBatch(page1);
      let totalCandidates = page1.length;
      allScored.sort((a, b) => b.blastMeta.score - a.blastMeta.score);
      _currentQuery = keyword || `sequence (${seq.length} aa)`;
      _similarList  = allScored.slice(0, hitlist);

      // ── Display helper — show immediately, re-call on each background page ─────
      let resultsShown = false;
      const showSeqResults = (scanning) => {
        _renderResults();
        if (!resultsShown) {
          _setUiState('results');
          switchTab('similar');
          resultsShown = true;
        }
        document.getElementById('ref-protein-container').innerHTML = `
          <div class="glass-card p-5 border border-blue-100 bg-blue-50">
            <div class="flex items-start gap-3">
              <svg class="w-5 h-5 text-blue-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
              </svg>
              <div class="min-w-0">
                <p class="font-semibold text-blue-800 text-sm">Local k-mer Similarity — ${_similarList.length} proteins shown</p>
                <p class="text-xs text-blue-600 mt-1">Query: ${seq.length} aa &nbsp;·&nbsp; Scored: ${allScored.length} / ${totalCandidates} candidates</p>
                <p class="font-mono text-xs text-blue-700 mt-2 bg-blue-100 p-2 rounded-lg break-all">${escHtml(seq.substring(0, 120))}${seq.length > 120 ? '…' : ''}</p>
              </div>
            </div>
          </div>`;
        document.getElementById('results-summary').textContent =
          scanning ? 'Sequence similarity (scanning more…)' : 'Sequence similarity results';
      };

      if (_similarList.length > 0) showSeqResults(!!nextUrl);

      // ── Background pages — refine results silently (throttled) ──────────────────────
      for (let pg = 1; pg < MAX_PAGES && nextUrl; pg++) {
        if (token !== _searchToken) return;
        // Throttle: wait between requests to avoid rate limiting
        await sleep(PAGE_DELAY_MS);

        if (loadMsg) loadMsg.textContent =
          `Scanning page ${pg + 1}/${MAX_PAGES} — ${allScored.length.toLocaleString()} candidates scored so far…`;

        const more = await _fetchPage(nextUrl);
        if (token !== _searchToken) return;
        nextUrl          = more.nextUrl;
        totalCandidates += more.results.length;
        allScored        = allScored.concat(scoreBatch(more.results));
        allScored.sort((a, b) => b.blastMeta.score - a.blastMeta.score);
        _similarList     = allScored.slice(0, hitlist);
        const stillMore = !!nextUrl && pg < MAX_PAGES - 1;
        if (_similarList.length > 0) showSeqResults(stillMore);
      }

      if (token !== _searchToken) return;
      // Always finalize — clears 'scanning more…' text
      if (_similarList.length > 0) {
        showSeqResults(false);
      } else {
        _setUiState('empty');
      }

    } catch (err) {
      if (token !== _searchToken) return;
      _setUiState('error');
      document.getElementById('error-msg').textContent = err.message;
    }
  }

  function encodeQueryTerm(t) {
    // Quote multi-word terms for UniProt
    return t.includes(' ') ? `"${t}"` : t;
  }

  // ─── Render ──────────────────────────────────────────────────────────────
  function _renderResults() {
    document.getElementById('results-summary').textContent =
      `Results for "${_currentQuery}"`;
    _updateSimilarCount();

    // Reference card
    document.getElementById('ref-protein-container').innerHTML =
      _refProtein ? _buildRefCard(_refProtein) : '<p class="text-gray-400 text-sm">No reference found.</p>';

    // Similar container: empty with a bottom sentinel for infinite scroll
    _renderedCount = 0;
    const simContainer = document.getElementById('similar-proteins-container');
    simContainer.innerHTML = '<div id="sim-sentinel" class="col-span-2 h-2"></div>';
    _setupSentinel();
    _renderMoreCards();  // render first batch straight away
  }

  function _buildRefCard(p) {
    return `
    <div class="glass-card p-6 ref-glow border border-blue-100 fade-in">
      <div class="flex flex-col lg:flex-row gap-6">
        <!-- Left: meta -->
        <div class="flex-1 min-w-0">
          <div class="flex items-start gap-3 mb-4">
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-teal-400 flex items-center justify-center text-white font-bold text-lg shrink-0 shadow">
              ${escHtml(p.name.charAt(0).toUpperCase())}
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap mb-1">
                <span class="text-xs font-bold px-2 py-0.5 rounded-full badge-ref">REFERENCE</span>
                <span class="text-xs px-2 py-0.5 rounded-full ${p.reviewed ? 'badge-reviewed' : 'badge-unreviewed'}">
                  ${p.reviewed ? '✓ Swiss-Prot' : 'TrEMBL'}
                </span>
              </div>
              <h2 class="text-base font-bold text-gray-900 leading-tight truncate">${escHtml(p.name)}</h2>
              <p class="text-xs text-gray-400 mt-0.5 italic">${escHtml(p.organism)}</p>
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
            <div class="glass-card p-3 text-center">
              <p class="text-xs text-gray-400 mb-0.5">Accession</p>
              <p class="font-mono font-bold text-blue-600 text-sm">${escHtml(p.accession)}</p>
            </div>
            <div class="glass-card p-3 text-center">
              <p class="text-xs text-gray-400 mb-0.5">Length</p>
              <p class="font-bold text-gray-800 text-sm">${p.length} <span class="font-normal text-xs text-gray-400">aa</span></p>
            </div>
            <div class="glass-card p-3 text-center">
              <p class="text-xs text-gray-400 mb-0.5">Gene</p>
              <p class="font-mono font-semibold text-gray-700 text-xs truncate">${escHtml(p.gene)}</p>
            </div>
          </div>

          <!-- FASTA preview -->
          <div class="mb-4">
            <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">FASTA Preview</p>
            <div class="fasta-box">${escHtml(p.fasta)}</div>
          </div>

          <!-- Actions -->
          <div class="flex gap-2 flex-wrap">
            <button onclick="downloadSingleFasta('${escHtml(p.accession)}', 'ref')"
                    class="btn-primary flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
              Download FASTA
            </button>
            <button onclick="copyFasta('${escHtml(p.accession)}', 'ref')"
                    class="btn-secondary flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
              Copy FASTA
            </button>
            <a href="https://www.uniprot.org/uniprotkb/${escHtml(p.accession)}" target="_blank" rel="noopener noreferrer"
               class="btn-secondary flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
              View on UniProt
            </a>
          </div>
        </div>
      </div>
    </div>`;
  }

  function _buildSimilarCard(p) {
    return `
    <div class="glass-card p-5 protein-card fade-in">
      <div class="flex items-start gap-3 mb-3">
        <div class="w-9 h-9 rounded-lg bg-gradient-to-br from-teal-100 to-blue-100 flex items-center justify-center text-sm font-bold text-teal-700 shrink-0">
          ${escHtml(p.name.charAt(0).toUpperCase())}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap mb-0.5">
            <span class="font-mono text-xs font-bold text-blue-600">${escHtml(p.accession)}</span>
            <span class="text-xs px-1.5 py-0.5 rounded-full ${p.reviewed ? 'badge-reviewed' : 'badge-unreviewed'}">
              ${p.reviewed ? '✓ Swiss-Prot' : 'TrEMBL'}
            </span>
          </div>
          <p class="text-sm font-semibold text-gray-800 truncate leading-tight">${escHtml(p.name)}</p>
          <p class="text-xs text-gray-400 italic truncate">${escHtml(p.organism)}</p>
        </div>
      </div>

      <div class="flex items-center gap-3 mb-3 text-xs text-gray-400 flex-wrap">
        <span>${p.length} aa</span>
        <span class="text-gray-200">·</span>
        <span class="truncate">${escHtml(p.gene)}</span>
        ${p.blastMeta ? `
        <span class="text-gray-200">·</span>
        <span class="px-1.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">ID ${p.blastMeta.identity ?? '?'}%</span>
        <span class="px-1.5 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-700">Cov ${p.blastMeta.coverage ?? '?'}%</span>
        <span class="px-1.5 py-0.5 rounded-full text-xs font-bold bg-purple-100 text-purple-700">E: ${p.blastMeta.evalue != null ? p.blastMeta.evalue.toExponential(1) : '?'}</span>` : ''}
      </div>

      <!-- Short FASTA preview -->
      <div class="fasta-box mb-3" style="max-height:80px;font-size:10px;">${escHtml(p.fasta.substring(0, 200))}${p.fasta.length > 200 ? '…' : ''}</div>

      <div class="flex gap-2">
        <button onclick="downloadSingleFasta('${escHtml(p.accession)}', 'similar')"
                class="flex-1 btn-primary py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
          FASTA
        </button>
        <button onclick="copyFasta('${escHtml(p.accession)}', 'similar')"
                class="flex-1 btn-secondary py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          Copy
        </button>
        <a href="https://www.uniprot.org/uniprotkb/${escHtml(p.accession)}" target="_blank" rel="noopener noreferrer"
           class="flex-1 btn-secondary py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
          UniProt
        </a>
      </div>
    </div>`;
  }

  // ─── Download / Copy helpers ──────────────────────────────────────────────
  window.downloadSingleFasta = function (accession, type) {
    const protein = type === 'ref'
      ? (_refProtein?.accession === accession ? _refProtein : null)
      : _similarList.find(p => p.accession === accession);
    if (!protein) return;
    _triggerDownload(protein.fasta, `${accession}.fasta`, 'text/plain');
    showToast(`Downloaded ${accession}.fasta`);
  };

  window.copyFasta = function (accession, type) {
    const protein = type === 'ref'
      ? (_refProtein?.accession === accession ? _refProtein : null)
      : _similarList.find(p => p.accession === accession);
    if (!protein) return;
    navigator.clipboard.writeText(protein.fasta).then(() => {
      showToast('FASTA copied to clipboard!');
    }).catch(() => {
      showToast('Copy failed — try manually.', 'error');
    });
  };

  window.downloadAllFasta = function () {
    const proteins = [...(_refProtein ? [_refProtein] : []), ..._similarList];
    if (!proteins.length) {
      showToast('No proteins to download.', 'warning');
      return;
    }
    const all = proteins.map(p => p.fasta).join('\n\n');
    const filename = `${(_currentQuery || 'proteins').replace(/\s+/g, '_')}_proteins.fasta`;
    _triggerDownload(all, filename, 'text/plain');
    showToast(`Downloaded ${filename} (${proteins.length} sequence${proteins.length !== 1 ? 's' : ''})`);
  };

  window.copyCombinedFasta = function () {
    const proteins = [...(_refProtein ? [_refProtein] : []), ..._similarList];
    if (!proteins.length) {
      showToast('No proteins to copy.', 'warning');
      return;
    }
    const all = proteins.map(p => p.fasta).join('\n\n');
    navigator.clipboard.writeText(all).then(() => {
      showToast(`Copied ${proteins.length} FASTA sequence${proteins.length !== 1 ? 's' : ''}!`);
    }).catch(() => {
      showToast('Copy failed — try manually.', 'error');
    });
  };

  function _triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Delay revoke — browser needs the URL to still be valid when it processes the click
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 2000);
  }

  // ─── Tab switching ────────────────────────────────────────────────────────
  window.switchTab = function (tab) {
    _activeTab = tab;
    document.getElementById('panel-ref').classList.toggle('hidden', tab !== 'ref');
    document.getElementById('panel-similar').classList.toggle('hidden', tab !== 'similar');
    document.getElementById('tab-ref').classList.toggle('active', tab === 'ref');
    document.getElementById('tab-similar').classList.toggle('active', tab === 'similar');
  };

  // ─── UI state machine ────────────────────────────────────────────────────
  function _setUiState(state) {
    const sections = ['loading-section', 'error-section', 'empty-section', 'results-section'];
    sections.forEach(id => document.getElementById(id).classList.add('hidden'));

    const stateMap = {
      loading : 'loading-section',
      error   : 'error-section',
      empty   : 'empty-section',
      results : 'results-section',
    };
    if (stateMap[state]) {
      document.getElementById(stateMap[state]).classList.remove('hidden');
    }

    const btn = document.getElementById('btn-search');
    if (btn) btn.disabled = state === 'loading';
  }

  // ─── Toast notifications ──────────────────────────────────────────────────
  window.showToast = function (msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    const color = type === 'error' ? 'bg-red-600' : 'bg-gray-900';
    toast.className = `${color} text-white text-xs font-medium px-4 py-2.5 rounded-xl shadow-lg pointer-events-auto`;
    toast.style.cssText = 'animation:fadeIn .2s ease both;';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity .3s';
      setTimeout(() => container.removeChild(toast), 300);
    }, 2800);
  };

  // ─── XSS-safe HTML escaping ───────────────────────────────────────────────
  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

})();
