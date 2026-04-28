/**
 * EpitopX AI — API Hooks
 * Fetches proteins from the remote API via the local proxy (server.js).
 * DNA translation and similarity stay client-side.
 *
 * Improvements:
 *  - Request deduplication (prevents duplicate in-flight requests)
 *  - Retry with exponential backoff for transient errors
 *  - TTL-based cache invalidation
 *  - AbortController for request cancellation
 */

var API = typeof API !== 'undefined' ? API : (() => {
  // Proxied through server.js on same origin — no CORS issues
  const API_BASE_URL = '/api/proteins';

  // ── Cache with TTL ──────────────────────────────────────────────────────
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  let cachedProteins = [];
  let cacheTimestamp = 0;

  function _persistCache(list) {
    try { sessionStorage.setItem('_epitopx_proteins', JSON.stringify(list)); } catch (_) {}
    cacheTimestamp = Date.now();
  }

  function _isCacheValid() {
    return cachedProteins.length > 0 && (Date.now() - cacheTimestamp) < CACHE_TTL_MS;
  }

  // Warm-start from sessionStorage
  try {
    const stored = sessionStorage.getItem('_epitopx_proteins');
    if (stored) {
      cachedProteins = JSON.parse(stored);
      cacheTimestamp = Date.now(); // treat session-restored data as fresh
    }
  } catch (_) {}

  // ── Request deduplication ───────────────────────────────────────────────
  const _inflightRequests = new Map();

  // ── Fetch with retry & dedup ────────────────────────────────────────────
  async function fetchJSON(url, options = {}, retries = 2) {
    const token = (typeof Auth !== 'undefined' && Auth.getAuthToken) ? Auth.getAuthToken() : sessionStorage.getItem('_authToken');
    const headers = { ...(options.headers || {}) };
    if (token) headers['Authorization'] = `Token ${token}`;

    const cacheKey = options.method && options.method !== 'GET' ? null : url;

    // Dedup identical GET requests
    if (cacheKey && _inflightRequests.has(cacheKey)) {
      return _inflightRequests.get(cacheKey);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const promise = (async () => {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await fetch(url, {
            ...options,
            headers,
            signal: controller.signal,
          });
          if (res.status === 429) {
            // Rate limited — wait and retry
            const retryAfter = parseInt(res.headers.get('Retry-After') || '2', 10);
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            continue;
          }
          if (!res.ok) throw new Error(`API Error ${res.status}: ${res.statusText}`);
          return await res.json();
        } catch (err) {
          lastError = err;
          if (err.name === 'AbortError') throw new Error('Request timeout');
          if (attempt < retries && !err.message.includes('4')) {
            // Exponential backoff for server errors
            await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
          }
        }
      }
      throw lastError;
    })();

    promise.finally(() => {
      clearTimeout(timeoutId);
      if (cacheKey) _inflightRequests.delete(cacheKey);
    });

    if (cacheKey) _inflightRequests.set(cacheKey, promise);
    return promise;
  }

  /**
   * Normalize a protein object from the remote API to the shape
   * expected by the dashboard / viewer / compare pages.
   */
  function normalizeProtein(raw) {
    if (!raw) return null;
    const seq = raw.sequence || '';
    // molecular_weight is no longer returned by the API — compute from sequence
    const weight = Math.round(seq.length * 110);
    return {
      id: raw.id,
      name: raw.name || 'Protein',
      full_name: raw.fullname || raw.full_name || raw.name || '',
      sequence: seq,
      organism: raw.organism || 'Inconnu',
      molecular_weight: weight,
      description: raw.description || '',
      pdb_url: raw.pdb_file || raw.pdp_file || null,
      cif_url: raw.cif_file || null,
      epitope_id: raw.epitope_id || null,
      epitope_count: raw.epitope_count || 0,
      // kept with defaults so UI components that reference them don't break
      tags: raw.tags || [],
      family: raw.family || '',
      pI: raw.pI || null,
      resolution: raw.resolution || null,
      method: raw.method || null,
      gene: raw.gene || '',
      dna_sequence: raw.dna_sequence || '',
      created_at: raw.created_at,
      updated_at: raw.updated_at
    };
  }

  function getCachedProteins() { return [...cachedProteins]; }

  /** Force cache refresh on next getAllProteins call */
  function invalidateCache() {
    cacheTimestamp = 0;
    cachedProteins = [];
    try { sessionStorage.removeItem('_epitopx_proteins'); } catch (_) {}
  }

  // --- API : Convertir ADN → Protéine (client-side) ---
  async function convertDNAToProtein(dnaSequence) {
    const result = DNAUtils.translate(dnaSequence);
    return { success: true, data: result };
  }

  // --- API : Vérifier protéine dans la base ---
  async function checkProteinInDB(proteinSequence) {
    if (cachedProteins.length === 0) await getAllProteins();
    const clean = proteinSequence.replace(/\s+/g, '').toUpperCase();
    const match = cachedProteins.find(p =>
      (p.sequence || '').replace(/\s+/g, '').toUpperCase() === clean
    );
    return { success: true, found: !!match, data: match || null };
  }

  // --- API : Récupérer toutes les protéines ---
  async function getAllProteins(query = '', filters = {}) {
    try {
      // Use cached data if still valid and no search query
      if (!query && !filters.organism && !filters.family && _isCacheValid()) {
        return { success: true, data: [...cachedProteins], total: cachedProteins.length };
      }

      const params = new URLSearchParams();
      if (query) params.set('search', query);
      const qs = params.toString();
      const url = `${API_BASE_URL}/${qs ? '?' + qs : ''}`;
      const data = await fetchJSON(url);

      // API returns { count, results: [...] }
      const list = Array.isArray(data.results) ? data.results
                 : Array.isArray(data) ? data : [];
      const mapped = list.map(normalizeProtein).filter(Boolean);

      // Client-side filters
      let results = mapped;
      if (filters.organism) {
        results = results.filter(p =>
          p.organism.toLowerCase().includes(filters.organism.toLowerCase())
        );
      }
      if (filters.family) {
        results = results.filter(p =>
          p.family.toLowerCase().includes(filters.family.toLowerCase())
        );
      }

      if (mapped.length > 500) {
        console.warn(`[EpitopX] getAllProteins: ${mapped.length} proteins loaded into client-side memory — consider adding server-side pagination.`);
      }
      cachedProteins = mapped; // cache full list
      _persistCache(mapped);
      return { success: true, data: results, total: results.length };
    } catch (err) {
      console.error('getAllProteins error:', err);
      return { success: false, data: [], total: 0, error: err.message };
    }
  }

  // --- API : Récupérer données 3D d'une protéine ---
  async function getProtein3D(proteinId) {
    try {
      const detail = await fetchJSON(`${API_BASE_URL}/${proteinId}/`);
      const protein = normalizeProtein(detail);
      if (!protein) return { success: false, error: 'Protéine introuvable' };

      let structureData = '';
      let fileFormat = 'pdb';
      let structureSource = 'generated'; // 'server' | 'alphafold' | 'generated'

      // Helper to resolve /media/ paths through the local proxy.
      // Handles absolute URLs (https://ngrok.../media/...), relative paths (/media/...),
      // and bare paths that have no /media/ prefix.
      function resolveMediaUrl(u) {
        if (!u) return '';
        // If it's already a relative /media/ path, use as-is
        if (u.startsWith('/media/')) return u;
        // Strip the origin from absolute URLs to route through the local proxy
        const idx = u.indexOf('/media/');
        if (idx !== -1) return u.substring(idx);
        // Fallback: treat as-is (e.g. already a relative API path)
        return u;
      }

      // Helper: reject HTML error pages (ngrok warnings, 502 proxy pages, etc.)
      function isValidStructureText(text) {
        return text.length > 50 && !text.trimStart().startsWith('<');
      }

      console.log(`[3D] Loading structure for protein "${protein.name}" (id=${proteinId})`);
      console.log(`[3D] pdb_url="${protein.pdb_url}"  cif_url="${protein.cif_url}"`);

      // 1. Try PDB from the backend
      if (protein.pdb_url) {
        try {
          const resolvedUrl = resolveMediaUrl(protein.pdb_url);
          console.log(`[3D] Fetching PDB: ${resolvedUrl}`);
          const r = await fetch(resolvedUrl);
          console.log(`[3D] PDB response: ${r.status} ${r.statusText}`);
          if (r.ok) {
            const text = await r.text();
            if (isValidStructureText(text)) {
              structureData = text;
              fileFormat = 'pdb';
              structureSource = 'server';
              console.log(`[3D] PDB loaded from server (${text.length} bytes)`);
            } else {
              console.warn('[3D] PDB response looks like an error page — first 200 chars:', text.substring(0, 200));
            }
          }
        } catch (e) {
          console.warn('[3D] PDB download failed', e);
        }
      }

      // 2. Try CIF from the backend
      if (!structureData && protein.cif_url) {
        try {
          const resolvedUrl = resolveMediaUrl(protein.cif_url);
          console.log(`[3D] Fetching CIF: ${resolvedUrl}`);
          const r = await fetch(resolvedUrl);
          console.log(`[3D] CIF response: ${r.status} ${r.statusText}`);
          if (r.ok) {
            const text = await r.text();
            if (isValidStructureText(text)) {
              structureData = text;
              fileFormat = 'cif';
              structureSource = 'server';
              console.log(`[3D] CIF loaded from server (${text.length} bytes)`);
            } else {
              console.warn('[3D] CIF response looks like an error page — first 200 chars:', text.substring(0, 200));
            }
          }
        } catch (e) {
          console.warn('[3D] CIF download failed', e);
        }
      }

      // 3. Try AlphaFold via UniProt lookup
      if (!structureData) {
        try {
          const af = await fetchAlphaFoldStructure(protein.name, protein.organism);
          if (af) {
            structureData = af;
            fileFormat = 'pdb';
            structureSource = 'alphafold';
          }
        } catch (e) {
          console.warn('AlphaFold fetch failed', e);
        }
      }

      // 4. Fall back to locally generated model
      if (!structureData) {
        structureData = PDBGenerator.generate(protein.sequence, protein.name);
        fileFormat = 'pdb';
        structureSource = 'generated';
      }

      return { success: true, data: { ...protein, pdb_data: structureData, file_format: fileFormat, structure_source: structureSource } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // --- Fetch real 3D structure from AlphaFold via UniProt ---
  async function fetchAlphaFoldStructure(proteinName, organism) {
    // Build a UniProt search query using the protein name (and organism if available)
    const query = [proteinName, organism].filter(Boolean).join(' ');
    // Route through local proxy for caching & throttling
    const uniprotUrl =
      `/api/uniprot/uniprotkb/search?query=${encodeURIComponent(query)}&fields=accession&format=json&size=5`;

    const uniprotRes = await fetch(uniprotUrl);
    if (!uniprotRes.ok) return '';
    const uniprotData = await uniprotRes.json();
    const results = uniprotData.results || [];
    if (!results.length) return '';

    // For each UniProt hit, ask the AlphaFold API for the actual model metadata
    // then download whichever version exists — avoids blind version guessing
    for (const entry of results) {
      const uniprotId = entry.primaryAccession;
      if (!uniprotId) continue;

      try {
        // AlphaFold REST API returns metadata including the real pdbUrl
        const metaRes = await fetch(
          `https://alphafold.ebi.ac.uk/api/prediction/${uniprotId}`,
          { headers: { 'Accept': 'application/json' } }
        );
        if (!metaRes.ok) continue;
        const metaList = await metaRes.json();
        const meta = Array.isArray(metaList) ? metaList[0] : metaList;
        const pdbUrl = meta && (meta.pdbUrl || meta.cifUrl);
        if (!pdbUrl) continue;

        const afRes = await fetch(pdbUrl);
        if (!afRes.ok) continue;
        const pdbText = await afRes.text();
        if (pdbText.length > 100 && pdbText.includes('ATOM')) {
          console.log(`[3D] AlphaFold structure loaded for ${uniprotId} (${pdbText.length} bytes)`);
          return pdbText;
        }
      } catch (_) { /* try next accession */ }

      // Small delay between AlphaFold lookups to be polite
      await new Promise(r => setTimeout(r, 300));
    }
    return '';
  }

  // --- API : Calculer similarité (client-side) ---
  async function calculateSimilarity(id1, id2) {
    const p1 = cachedProteins.find(p => p.id === Number(id1));
    const p2 = cachedProteins.find(p => p.id === Number(id2));
    if (!p1 || !p2) return { success: false, error: 'Protéine(s) non trouvée(s)' };
    return { success: true, data: computeLocalSimilarity(p1.sequence, p2.sequence) };
  }

  // --- Local similarity computation ---
  function computeLocalSimilarity(seq1, seq2) {
    const len = Math.min(seq1.length, seq2.length);
    let matches = 0;
    const alignment = [];

    for (let i = 0; i < len; i++) {
      const match = seq1[i] === seq2[i];
      if (match) matches++;
      alignment.push({ position: i + 1, aa1: seq1[i] || '-', aa2: seq2[i] || '-', match });
    }

    const maxLen = Math.max(seq1.length, seq2.length);
    for (let i = len; i < maxLen; i++) {
      alignment.push({ position: i + 1, aa1: seq1[i] || '-', aa2: seq2[i] || '-', match: false });
    }

    const identity = len > 0 ? (matches / maxLen) * 100 : 0;

    // Estimated RMSD based on sequence identity (empirical Chothia & Lesk formula).
    // Real RMSD requires 3D coordinate superposition which is not available client-side.
    const identityFraction = identity / 100;
    const estimatedRmsd = identityFraction > 0
      ? Math.max(0.3, 1.5 * Math.exp(-1.87 * identityFraction))
      : 10.0;

    return {
      identity: Math.round(identity * 10) / 10,
      matches,
      total: maxLen,
      rmsd: Math.round(estimatedRmsd * 100) / 100,
      rmsdEstimated: true,
      alignment,
      gaps: Math.abs(seq1.length - seq2.length)
    };
  }

  // --- API : Epitope prediction ---
  // Route through the local proxy (/api/epitopes/*) to avoid CORS issues
  const EPITOPE_API_URL = '/api/epitopes/analyze/';

  /**
   * Predict epitope candidates for a protein sequence.
   * @param {Object} params
   * @param {string} params.sequence   - Protein sequence (FASTA or raw)
   * @param {string} [params.method]   - 'core', 'bio', or 'iedb' (default: 'core')
   * @param {number} [params.min_length] - Min epitope length (default: 9)
   * @param {number} [params.max_length] - Max epitope length (default: 20)
   * @param {number} [params.min_score]  - Min score 0-1 (default: 0.5)
   * @param {number} [params.top_n]      - Number of top epitopes (default: 20)
   * @param {File|Blob} [params.pdb_file] - Optional PDB file
   * @param {string} [params.chain_id]   - PDB chain ID (default: 'A')
   * @returns {Promise<{success:boolean, data?:any, error?:string}>}
   */
  async function analyzeEpitopes(params = {}) {
    async function doRequest(includePdb) {
      const formData = new FormData();
      if (params.protein_id != null) {
        formData.append('protein_id', String(params.protein_id));
      }
      formData.append('sequence', params.sequence || '');
      formData.append('method', params.method || 'core');
      formData.append('min_length', String(params.min_length || 9));
      formData.append('max_length', String(params.max_length || 20));
      formData.append('min_score', String(params.min_score || 0.5));
      formData.append('top_n', String(params.top_n || 20));
      formData.append('chain_id', params.chain_id || 'A');
      if (includePdb && params.pdb_file) {
        formData.append('pdb_file', params.pdb_file);
      }
      return fetch(EPITOPE_API_URL, {
        method: 'POST',
        headers: { 'ngrok-skip-browser-warning': 'true' },
        body: formData
      });
    }

    try {
      let res = await doRequest(true);

      // If PDB caused a parse error, retry without it
      if (!res.ok && params.pdb_file) {
        const errBody = await res.text();
        const isPdbError = errBody.includes('PDB') || errBody.includes('pdb') ||
                           errBody.includes('out of bounds') || errBody.includes('parsing');
        if (isPdbError) {
          console.warn('analyzeEpitopes: PDB parsing error, retrying without PDB file:', errBody);
          res = await doRequest(false);
          if (!res.ok) {
            const retryErr = await res.text();
            throw new Error(`Epitope API ${res.status}: ${retryErr}`);
          }
          const data = await res.json();
          return { success: true, data, pdb_skipped: true };
        }
        throw new Error(`Epitope API ${res.status}: ${errBody}`);
      }

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Epitope API ${res.status}: ${errBody}`);
      }

      const data = await res.json();
      return { success: true, data };
    } catch (err) {
      console.error('analyzeEpitopes error:', err);
      return { success: false, error: err.message };
    }
  }

  // --- API : Créer une nouvelle protéine ---
  async function createProtein({ name, fullname, sequence, organism, description, pdb_file, cif_file }) {
    try {
      const formData = new FormData();
      formData.append('name', name);
      formData.append('fullname', fullname || '');
      formData.append('sequence', sequence);
      formData.append('organism', organism || '');
      formData.append('description', description || '');
      if (pdb_file) {
        formData.append('pdb_file', pdb_file);
      }
      if (cif_file) {
        formData.append('cif_file', cif_file);
      }

      const token = (typeof Auth !== 'undefined' && Auth.getAuthToken) ? Auth.getAuthToken() : sessionStorage.getItem('_authToken');
      const headers = {};
      if (token) headers['Authorization'] = `Token ${token}`;

      const res = await fetch(`${API_BASE_URL}/`, {
        method: 'POST',
        headers,
        body: formData
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`API ${res.status}: ${errBody}`);
      }

      const data = await res.json();
      const protein = normalizeProtein(data);
      invalidateCache(); // Force fresh fetch next time
      return { success: true, data: protein };
    } catch (err) {
      console.error('createProtein error:', err);
      return { success: false, error: err.message };
    }
  }

  // --- API : Mes protéines (avec auth token) ---
  async function getMyProteins(query = '', filters = {}) {
    try {
      const params = new URLSearchParams();
      if (query) params.set('search', query);
      const qs = params.toString();
      const url = `/api/proteins/my_own/${qs ? '?' + qs : ''}`;
      const data = await fetchJSON(url);
      const list = Array.isArray(data.results) ? data.results
                 : Array.isArray(data) ? data : [];
      const mapped = list.map(normalizeProtein).filter(Boolean);
      let results = mapped;
      if (filters.organism) {
        results = results.filter(p =>
          p.organism.toLowerCase().includes(filters.organism.toLowerCase())
        );
      }
      return { success: true, data: results, total: results.length };
    } catch (err) {
      console.error('getMyProteins error:', err);
      return { success: false, data: [], total: 0, error: err.message };
    }
  }

  // --- API : Supprimer une protéine ---
  async function deleteProtein(id) {
    try {
      const token = (typeof Auth !== 'undefined' && Auth.getAuthToken) ? Auth.getAuthToken() : sessionStorage.getItem('_authToken');
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Token ${token}`;
      const res = await fetch(`${API_BASE_URL}/${id}/`, { method: 'DELETE', headers });
      if (res.status === 204 || res.ok) {
        invalidateCache(); // Force fresh fetch next time
        return { success: true };
      }
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || `HTTP ${res.status}`);
    } catch (err) {
      console.error('deleteProtein error:', err);
      return { success: false, error: err.message };
    }
  }

  // --- API : Récupérer protéines publiques (sans auth) ---
  async function getPublicProteins(query = '', filters = {}) {
    try {
      const params = new URLSearchParams();
      if (query) params.set('search', query);
      const qs = params.toString();
      const url = `/api/proteins/public_list/${qs ? '?' + qs : ''}`;
      const data = await fetchJSON(url);
      const list = Array.isArray(data.results) ? data.results
                 : Array.isArray(data) ? data : [];
      const mapped = list.map(normalizeProtein).filter(Boolean);
      let results = mapped;
      if (filters.organism) {
        results = results.filter(p =>
          p.organism.toLowerCase().includes(filters.organism.toLowerCase())
        );
      }
      if (filters.family) {
        results = results.filter(p =>
          p.family.toLowerCase().includes(filters.family.toLowerCase())
        );
      } 
      cachedProteins = mapped;
      _persistCache(mapped);
      return { success: true, data: results, total: results.length };
    } catch (err) {
      console.error('getPublicProteins error:', err);
      return { success: false, data: [], total: 0, error: err.message };
    }
  }

  return {
    convertDNAToProtein,
    checkProteinInDB,
    getAllProteins,
    getPublicProteins,
    getMyProteins,
    getProtein3D,
    calculateSimilarity,
    getCachedProteins,
    analyzeEpitopes,
    createProtein,
    deleteProtein,
    invalidateCache
  };
})();
