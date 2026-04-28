/**
 * EpitopX AI — 3D Viewer logic
 * Visualisation 3D avec 3Dmol.js, contrôles de style et interactions
 */

(function () {
  'use strict';

  let viewer = null;
  let currentModel = null;
  let currentProtein = null;
  let currentPDBData = '';
  let currentFileFormat = 'pdb'; // 'pdb' or 'cif'
  let isSpinning = false;
  let currentStyle = 'cartoon';
  let currentColor = 'spectrum';
  let epitopeData = null;  // Store predicted epitope results
  let alphafoldPDBBlob = null; // PDB downloaded from AlphaFold

  // ── Performance tier detection ───────────────────────────────────────────
  // 0 = low-end  (disable antialias, reduce quality, line-only default)
  // 1 = mid-end  (antialias off, cartoonQuality 5)
  // 2 = high-end (antialias on,  cartoonQuality 10)
  const _perfTier = (function detectPerfTier() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return 0; // no WebGL at all

      const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbgInfo
        ? gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL).toLowerCase()
        : gl.getParameter(gl.RENDERER).toLowerCase();

      // Known low-end or software renderers
      const LOW = /swiftshader|llvmpipe|softpipe|mesa|virgl|vmware|intel hd|intel(r) hd|uhd 600|uhd 610|uhd 620|gma [0-9]/i;
      const MID = /radeon rx [3-5]|geforce gt[x]? [0-9]{3}[^0-9]|intel iris/i;

      if (LOW.test(renderer)) return 0;
      if (MID.test(renderer)) return 1;
      return 2;
    } catch (_) { return 1; }
  })();

  // Expose so the UI can read/override it
  let perfMode = _perfTier; // can be toggled by user

  // Pending render request — prevents scheduling more than one render per frame
  let _renderPending = false;
  function scheduleRender() {
    if (_renderPending || !viewer) return;
    _renderPending = true;
    requestAnimationFrame(() => {
      _renderPending = false;
      if (viewer) viewer.render();
    });
  }

  // --- Init ---
  async function init() {
    await populateProteinSelect();
    initViewer();

    // Sync performance mode buttons to detected / restored tier
    document.querySelectorAll('.perf-btn').forEach(b => {
      b.classList.toggle('active', Number(b.dataset.perf) === perfMode);
    });
    // Bind search button listeners (avoid inline onclick reference errors)
    const toggleBtn = document.getElementById('search-toggle-btn');
    if (toggleBtn) toggleBtn.addEventListener('click', (e) => {
      console.debug('search-toggle-btn clicked', e);
      if (window.toggleSearchBox) window.toggleSearchBox();
    });
    const searchOk = document.getElementById('search-ok-btn');
    if (searchOk) searchOk.addEventListener('click', () => window.searchInProtein && window.searchInProtein());

    // Close floating toolbar/search when clicking in the protein view (but ignore clicks inside the toolbar)
    const viewerArea = document.getElementById('viewer-wrapper') || document.getElementById('mol-viewer');
    if (viewerArea) {
      viewerArea.addEventListener('click', (e) => {
        const tools = document.getElementById('floating-tools');
        if (!tools) return;
        // if click happened inside the toolbar, do nothing
        if (tools.contains(e.target)) return;
        const searchBox = document.getElementById('search-box');
        if (searchBox && !searchBox.classList.contains('hidden')) searchBox.classList.add('hidden');
        // minimize instead of fully hiding
        tools.classList.add('minimized');
      });

      // Expand toolbar when user interacts with it
      const tools = document.getElementById('floating-tools');
      if (tools) {
        tools.addEventListener('mouseenter', () => tools.classList.remove('minimized'));
        tools.addEventListener('click', (ev) => {
          if (tools.classList.contains('minimized')) {
            tools.classList.remove('minimized');
            ev.stopPropagation();
          }
        });
      }
    }

    // Check URL params
    const id = Utils.getParam('id');
    if (id) {
      const sel = document.getElementById('protein-select');
      if (sel) sel.value = id;
      loadSelectedProtein();
    } else {
      // Restore last-viewed protein from session if no URL param
      const lastId = sessionStorage.getItem('viewer3d_lastProteinId');
      if (lastId) {
        const sel = document.getElementById('protein-select');
        if (sel) {
          sel.value = lastId;
          if (sel.value === lastId) loadSelectedProtein();
        }
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // --- Create Protein Modal ---
  window.openCreateProteinModal = function () {
    if (!localStorage.getItem('authToken')) {
      Utils.showToast('Vous devez être connecté pour créer une protéine', 'warning', 4000);
      setTimeout(() => { window.location.href = 'login.html'; }, 2000);
      return;
    }
    const modal = document.getElementById('create-protein-modal');
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  };

  window.closeCreateProteinModal = function () {
    const modal = document.getElementById('create-protein-modal');
    const panel = modal.querySelector('.modal-panel');
    panel.style.animation = 'modal-out 0.18s cubic-bezier(0.4,0,1,1) both';
    setTimeout(() => {
      modal.classList.add('hidden');
      panel.style.animation = '';
      document.body.style.overflow = '';
    }, 170);
    document.getElementById('create-protein-form').reset();
    document.getElementById('cp-pdb-filename').textContent = 'Aucun fichier';
    document.getElementById('cp-cif-filename').textContent = 'Aucun fichier';
    document.getElementById('cp-alphafold-status').innerHTML = '';
    alphafoldPDBBlob = null;
    switchStructureTab('pdb');
    ['cp-name','cp-fullname','cp-organism','cp-sequence','cp-description'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  };

  // --- Structure file tab switch (PDB / CIF) ---
  window.switchStructureTab = function (tab) {
    const isPdb = tab === 'pdb';
    document.getElementById('cp-pdb-section').classList.toggle('hidden', !isPdb);
    document.getElementById('cp-cif-section').classList.toggle('hidden', isPdb);
    const tabPdb = document.getElementById('cp-tab-pdb');
    const tabCif = document.getElementById('cp-tab-cif');
    tabPdb.className = isPdb
      ? 'px-3 py-1 text-xs rounded-full border transition-all bg-blue-50 border-blue-300 text-blue-700 font-medium'
      : 'px-3 py-1 text-xs rounded-full border transition-all bg-white border-gray-200 text-gray-500';
    tabCif.className = !isPdb
      ? 'px-3 py-1 text-xs rounded-full border transition-all bg-blue-50 border-blue-300 text-blue-700 font-medium'
      : 'px-3 py-1 text-xs rounded-full border transition-all bg-white border-gray-200 text-gray-500';
  };

  // --- AlphaFold PDB search ---
  window.searchAlphaFold = async function () {
    const name     = document.getElementById('cp-name').value.trim();
    const fullname = document.getElementById('cp-fullname').value.trim();
    const organism = document.getElementById('cp-organism').value.trim();
    const query    = fullname || name;
    if (!query) {
      Utils.showToast('Remplissez le nom de la protéine d\'abord', 'warning');
      return;
    }

    const statusEl = document.getElementById('cp-alphafold-status');
    const btn      = document.getElementById('cp-alphafold-btn');
    btn.disabled   = true;
    alphafoldPDBBlob = null;
    document.getElementById('cp-pdb-filename').textContent = 'Aucun fichier';

    function setStatus(html) { statusEl.innerHTML = html; }

    try {
      // 1. Search UniProt for accession
      setStatus('<span class="text-blue-500">Recherche sur UniProt...</span>');
      const uniprotQ = encodeURIComponent([query, organism].filter(Boolean).join(' '));
      const uniprotRes = await fetch(
        `/api/uniprot/uniprotkb/search?query=${uniprotQ}&format=json&fields=accession,id,protein_name&size=1`
      );
      if (!uniprotRes.ok) throw new Error('UniProt inaccessible');
      const uniprotData = await uniprotRes.json();

      if (!uniprotData.results || uniprotData.results.length === 0) {
        setStatus('<span class="text-amber-600">&#x26A0; Protéine non trouvée sur UniProt &mdash; veuillez uploader le fichier PDB manuellement.</span>');
        return;
      }

      const accession = uniprotData.results[0].primaryAccession;
      setStatus(`<span class="text-blue-500">UniProt: <strong>${accession}</strong> — Recherche sur AlphaFold...</span>`);

      // 2. Query AlphaFold DB
      const afRes = await fetch(`https://alphafold.ebi.ac.uk/api/prediction/${accession}`);
      if (!afRes.ok) {
        setStatus(`<span class="text-amber-600">&#x26A0; Aucune structure AlphaFold pour <strong>${accession}</strong> &mdash; veuillez uploader le fichier PDB manuellement.</span>`);
        return;
      }
      const afData = await afRes.json();
      if (!afData || !afData.length || !afData[0].pdbUrl) {
        setStatus('<span class="text-amber-600">&#x26A0; Pas de PDB disponible sur AlphaFold &mdash; veuillez uploader le fichier PDB manuellement.</span>');
        return;
      }

      const pdbUrl  = afData[0].pdbUrl;
      const filename = pdbUrl.split('/').pop();
      setStatus('<span class="text-blue-500">Téléchargement du PDB depuis AlphaFold...</span>');

      // 3. Download PDB content
      const pdbRes = await fetch(pdbUrl);
      if (!pdbRes.ok) throw new Error('Impossible de télécharger le PDB');
      const pdbText = await pdbRes.text();
      alphafoldPDBBlob = new Blob([pdbText], { type: 'text/plain' });
      alphafoldPDBBlob._name = filename; // store for display

      document.getElementById('cp-pdb-filename').textContent = filename + ' (AlphaFold ✓)';
      switchStructureTab('pdb');
      setStatus(`<span class="text-green-600">&#x2713; Structure AlphaFold chargée &mdash; <strong>${accession}</strong> (${filename})</span>`);
    } catch (err) {
      setStatus(`<span class="text-red-500">Erreur: ${err.message} &mdash; veuillez uploader le fichier PDB manuellement.</span>`);
    } finally {
      btn.disabled = false;
    }
  };

  // --- Update filename label for PDB or CIF input ---
  window.updateStructureFileName = function (type, input) {
    const labelId = type === 'cif' ? 'cp-cif-filename' : 'cp-pdb-filename';
    document.getElementById(labelId).textContent =
      input.files.length ? input.files[0].name : 'Aucun fichier';
  };

  window.submitCreateProtein = async function (e) {
    e.preventDefault();
    const name     = document.getElementById('cp-name').value.trim();
    const fullname = document.getElementById('cp-fullname').value.trim();
    const organism = document.getElementById('cp-organism').value.trim();
    const sequence = document.getElementById('cp-sequence').value.trim().replace(/\s+/g, '').toUpperCase();
    const description = document.getElementById('cp-description').value.trim();
    const pdbFile  = document.getElementById('cp-pdb-file').files[0] || alphafoldPDBBlob || null;
    const cifFile  = document.getElementById('cp-cif-file').files[0] || null;

    if (!name || !fullname || !organism || !sequence) {
      Utils.showToast('Veuillez remplir les champs obligatoires (*)', 'error');
      return;
    }

    const btn = document.getElementById('cp-submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Création...';

    try {
      const result = await API.createProtein({ name, fullname, sequence, organism, description, pdb_file: pdbFile, cif_file: cifFile });
      if (result.success) {
        Utils.showToast(`Protéine "${name}" créée avec succès`, 'success');
        closeCreateProteinModal();
        // Refresh protein selector and load the new protein
        await populateProteinSelect();
        if (result.data && result.data.id) {
          const sel = document.getElementById('protein-select');
          sel.value = result.data.id;
          loadSelectedProtein();
        }
      } else {
        Utils.showToast(result.error || 'Erreur lors de la création', 'error');
      }
    } catch (err) {
      Utils.showToast(`Erreur: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Créer';
    }
  };

  // --- Generated-model banner — persistent visual warning when no real structure is available ---
  function _showGeneratedModelBanner() {
    if (document.getElementById('generated-model-banner')) return;
    const wrapper = document.getElementById('viewer-wrapper') || document.getElementById('mol-viewer');
    if (!wrapper) return;
    const banner = document.createElement('div');
    banner.id = 'generated-model-banner';
    banner.style.cssText = [
      'position:absolute', 'top:0.6rem', 'left:50%', 'transform:translateX(-50%)',
      'z-index:100', 'background:rgba(245,158,11,0.93)', 'color:#fff',
      'font-size:0.72rem', 'font-weight:600', 'padding:0.3rem 0.9rem',
      'border-radius:999px', 'pointer-events:none', 'white-space:nowrap',
      'box-shadow:0 2px 8px rgba(0,0,0,0.18)'
    ].join(';');
    banner.textContent = '\u26a0 Mod\u00e8le g\u00e9n\u00e9r\u00e9 \u2014 aucune structure r\u00e9elle disponible';
    wrapper.style.position = 'relative';
    wrapper.appendChild(banner);
  }

  function _clearGeneratedModelBanner() {
    const b = document.getElementById('generated-model-banner');
    if (b) b.remove();
  }

  // --- Init 3Dmol viewer ---
  function initViewer() {
    const el = document.getElementById('mol-viewer');
    if (!el || typeof $3Dmol === 'undefined') {
      console.warn('3Dmol.js not loaded');
      return;
    }
    const qualityMap = [
      // perfMode 0 — low-end: no antialias, lowest quality
      { antialias: false, cartoonQuality: 3 },
      // perfMode 1 — mid: no antialias, medium quality
      { antialias: false, cartoonQuality: 6 },
      // perfMode 2 — high: antialias on, full quality
      { antialias: true,  cartoonQuality: 10 },
    ];
    const q = qualityMap[perfMode];

    viewer = $3Dmol.createViewer(el, {
      backgroundColor: '0xf0f4f8',
      antialias: q.antialias,
      cartoonQuality: q.cartoonQuality
    });

    // Outline is expensive on low-end hardware — skip it
    if (perfMode >= 2) {
      viewer.setViewStyle({ style: 'outline', color: 'black', width: 0.02 });
    }
    viewer.render();
    window._3dmolViewer = viewer;   // expose for hand-control.js
  }

  // --- Populate protein selector from API ---
  async function populateProteinSelect() {
    const select = document.getElementById('protein-select');
    try {
      const cached = API.getCachedProteins();
      const proteins = cached.length ? cached : (await API.getAllProteins()).data || [];
      proteins.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name} — ${p.organism}`;
        select.appendChild(opt);
      });
    } catch (err) {
      console.warn('Could not load protein list', err);
    }
  }

  // --- Load selected protein ---
  window.loadSelectedProtein = async function () {
    const id = document.getElementById('protein-select').value;
    if (!id) return;

    // Remember which protein was selected
    try { sessionStorage.setItem('viewer3d_lastProteinId', id); } catch(e) {}

    const wrapper = document.getElementById('viewer-wrapper');
    Utils.showLoading(document.getElementById('viewer-empty'), 'Génération de la structure 3D...');
    document.getElementById('viewer-empty').classList.remove('hidden');

    try {
      const response = await API.getProtein3D(id);
      if (!response.success) {
        Utils.showToast(response.error || 'Erreur', 'error');
        return;
      }

      currentProtein = response.data;
      currentPDBData = response.data.pdb_data;
      currentFileFormat = response.data.file_format || 'pdb';
      loadPDBIntoViewer(currentPDBData);
      updateInfoPanel(currentProtein);
      updateSequenceDisplay(currentProtein.sequence);

      document.getElementById('viewer-empty').classList.add('hidden');
      document.getElementById('floating-tools').classList.remove('hidden');
      document.getElementById('viewer-title').innerHTML = `${Utils.escapeHTML(currentProtein.name)} <span class="gradient-text">3D</span>`;

      // Restore epitope data if it was previously predicted for this protein
      restoreEpitopeData();

      const src = response.data.structure_source;
      if (src === 'alphafold') {
        _clearGeneratedModelBanner();
        document.getElementById('viewer-subtitle').textContent = `${currentProtein.full_name} — ${currentProtein.organism} · AlphaFold`;
        Utils.showToast(`${currentProtein.name} — structure AlphaFold chargée`, 'success', 3000);
      } else if (src === 'server') {
        _clearGeneratedModelBanner();
        document.getElementById('viewer-subtitle').textContent = `${currentProtein.full_name} — ${currentProtein.organism}`;
        Utils.showToast(`${currentProtein.name} chargée`, 'success', 2000);
      } else {
        document.getElementById('viewer-subtitle').textContent = `${currentProtein.full_name} — ${currentProtein.organism} · modèle simplifié`;
        Utils.showToast(`Aucune structure réelle trouvée — modèle simplifié affiché`, 'warning', 5000);
        _showGeneratedModelBanner();
      }
    } catch (err) {
      Utils.showToast(`Erreur: ${err.message}`, 'error');
    }
  };

  // --- Handle PDB / CIF file upload ---
  window.handlePDBUpload = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    // Detect format from extension
    const isCIF = /\.(cif|mmcif)$/i.test(file.name);
    currentFileFormat = isCIF ? 'cif' : 'pdb';
    const formatLabel = isCIF ? 'CIF' : 'PDB';

    const reader = new FileReader();
    reader.onload = (e) => {
      currentPDBData = e.target.result;
      currentProtein = {
        name: file.name.replace(/\.(pdb|ent|cif|mmcif)$/i, ''),
        full_name: 'Fichier importé',
        organism: 'Inconnu',
        sequence: isCIF ? extractSequenceFromCIF(currentPDBData) : extractSequenceFromPDB(currentPDBData),
        description: `Fichier ${formatLabel} importé : ${file.name}`,
        tags: ['importé', formatLabel],
        family: 'Importé',
        molecular_weight: 0
      };

      loadPDBIntoViewer(currentPDBData);
      updateInfoPanel(currentProtein);
      updateSequenceDisplay(currentProtein.sequence);

      document.getElementById('viewer-empty').classList.add('hidden');
      document.getElementById('floating-tools').classList.remove('hidden');
      document.getElementById('viewer-title').innerHTML = `${Utils.escapeHTML(currentProtein.name)} <span class="gradient-text">3D</span>`;
      document.getElementById('viewer-subtitle').textContent = `Fichier ${formatLabel} importé : ${file.name}`;
      document.getElementById('protein-select').value = '';

      _clearGeneratedModelBanner();
      Utils.showToast(`"${file.name}" chargé (${formatLabel})`, 'success');
    };
    reader.readAsText(file);
  };

  const AA3TO1 = {
    'ALA':'A','ARG':'R','ASN':'N','ASP':'D','CYS':'C','GLU':'E','GLN':'Q',
    'GLY':'G','HIS':'H','ILE':'I','LEU':'L','LYS':'K','MET':'M','PHE':'F',
    'PRO':'P','SER':'S','THR':'T','TRP':'W','TYR':'Y','VAL':'V'
  };

  // --- Extract sequence from PDB ---
  function extractSequenceFromPDB(pdb) {
    const seen = new Set();
    const seq = [];
    for (const line of pdb.split('\n')) {
      if (line.startsWith('ATOM') && line.substring(12, 16).trim() === 'CA') {
        const resName = line.substring(17, 20).trim();
        const resSeq = line.substring(22, 27).trim();
        const key = resName + resSeq;
        if (!seen.has(key)) {
          seen.add(key);
          seq.push(AA3TO1[resName] || 'X');
        }
      }
    }
    return seq.join('');
  }

  // --- Extract sequence from mmCIF ---
  function extractSequenceFromCIF(cif) {
    const lines = cif.split('\n');
    let headers = [];
    let colGroup = -1, colAtomId = -1, colCompId = -1, colSeqId = -1;
    let inAtomLoop = false;
    const seen = new Set();
    const seq = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (trimmed === 'loop_') {
        headers = [];
        colGroup = colAtomId = colCompId = colSeqId = -1;
        inAtomLoop = false;
        continue;
      }

      if (trimmed.startsWith('_atom_site.')) {
        const tag = trimmed.toLowerCase();
        const idx = headers.length;
        headers.push(tag);
        if (tag === '_atom_site.group_pdb')       colGroup   = idx;
        if (tag === '_atom_site.label_atom_id')   colAtomId  = idx;
        if (tag === '_atom_site.label_comp_id')   colCompId  = idx;
        if (tag === '_atom_site.label_seq_id')    colSeqId   = idx;
        inAtomLoop = true;
        continue;
      }

      if (inAtomLoop && colGroup >= 0 && colAtomId >= 0 && colCompId >= 0 && colSeqId >= 0) {
        if (trimmed.startsWith('_') || trimmed.startsWith('loop_') ||
            trimmed.startsWith('data_') || trimmed.startsWith('#') || trimmed === '') {
          if (trimmed.startsWith('loop_') || trimmed.startsWith('data_')) inAtomLoop = false;
          continue;
        }
        const cols = trimmed.split(/\s+/);
        if (cols.length > Math.max(colGroup, colAtomId, colCompId, colSeqId)) {
          if (cols[colGroup] === 'ATOM' && cols[colAtomId] === 'CA') {
            const compId = cols[colCompId].toUpperCase();
            const seqId  = cols[colSeqId];
            const key = compId + seqId;
            if (!seen.has(key)) {
              seen.add(key);
              seq.push(AA3TO1[compId] || 'X');
            }
          }
        }
      }
    }
    return seq.join('');
  }

  // --- Load PDB into viewer ---
  function loadPDBIntoViewer(pdbData) {
    if (!viewer) {
      Utils.showToast('Le viewer 3D n\'est pas initialisé', 'error');
      return;
    }
    viewer.removeAllModels();
    viewer.removeAllSurfaces();
    viewer.removeAllLabels();
    viewer.removeAllShapes();

    currentModel = viewer.addModel(pdbData, currentFileFormat);

    // On low-end hardware, downgrade surface/sphere to line style automatically
    if (perfMode === 0 && (currentStyle === 'surface' || currentStyle === 'sphere')) {
      currentStyle = 'line';
      document.querySelectorAll('.style-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.style === 'line');
      });
    }

    applyCurrentStyle();
    viewer.zoomTo();
    scheduleRender();

    // Add click handler for atom selection
    viewer.setClickable({}, true, function(atom) {
      if (!atom) return;
      const label = `${atom.resn} ${atom.resi} (${atom.atom})`;
      viewer.removeAllLabels();
      viewer.addLabel(label, {
        position: atom,
        backgroundColor: 'rgba(255,255,255,0.95)',
        fontColor: '#1e293b',
        fontSize: 12,
        borderRadius: 8,
        padding: 6,
        backgroundOpacity: 0.95
      });
      scheduleRender();
    });
  }

  // --- Apply style ---
  function applyCurrentStyle() {
    if (!viewer || !currentModel) return;

    viewer.removeAllSurfaces();
    const colorSpec = getColorSpec();
    const isSimpleColor = typeof colorSpec === 'string';

    // Adaptive quality per perfMode
    const seqLen = currentProtein ? (currentProtein.sequence || '').length : 0;
    const isLargeProtein = seqLen > 1000;

    // Cartoon uses 'color' for strings, 'colorscheme' for objects
    const cartoonStyle = {
      arrows: perfMode >= 1,       // arrows expensive on low-end
      tubes: perfMode >= 1,        // tubes expensive on low-end
      thickness: perfMode === 0 ? 0.2 : 0.3
    };
    if (isSimpleColor) {
      cartoonStyle.color = colorSpec;
    } else {
      cartoonStyle.colorscheme = colorSpec;
    }

    const stickRadius = perfMode === 0 ? 0.08 : 0.15;
    const sphereScale = perfMode === 0 ? 0.20 : 0.3;

    const styleMap = {
      cartoon: { cartoon: cartoonStyle },
      stick:   { stick:   { colorscheme: isSimpleColor ? colorSpec : colorSpec, radius: stickRadius } },
      sphere:  { sphere:  { colorscheme: isSimpleColor ? colorSpec : colorSpec, scale: sphereScale } },
      line:    { line:    { colorscheme: isSimpleColor ? colorSpec : colorSpec } },
      cross:   { cross:   { colorscheme: isSimpleColor ? colorSpec : colorSpec, linewidth: 2 } },
      surface: { cartoon: { ...cartoonStyle, opacity: 0.5 } }
    };

    viewer.setStyle({}, styleMap[currentStyle] || styleMap.cartoon);

    if (currentStyle === 'surface') {
      // On low-end or large proteins, block surface rendering
      if (perfMode === 0 || isLargeProtein) {
        Utils.showToast(
          perfMode === 0
            ? 'Surface désactivée en mode Éco (matériel limité)'
            : 'Surface désactivée pour les protéines > 1000 aa (performance)',
          'warning', 4000
        );
        currentStyle = 'cartoon';
        document.querySelectorAll('.style-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.style === 'cartoon');
        });
        viewer.setStyle({}, styleMap.cartoon);
      } else {
        const surfColor = isSimpleColor
          ? { prop: 'resi', gradient: 'roygb' }
          : colorSpec;
        // Mid-range: lower-quality surface; high-end: full VDW
        const surfType = perfMode >= 2 ? $3Dmol.SurfaceType.VDW : $3Dmol.SurfaceType.SAS;
        viewer.addSurface(surfType, {
          opacity: perfMode >= 2 ? 0.7 : 0.55,
          colorscheme: surfColor
        });
      }
    }

    scheduleRender();
  }

  // --- Get color spec ---
  function getColorSpec() {
    switch (currentColor) {
      case 'spectrum': return 'spectrum';
      case 'chain': return 'chainHetatm';
      case 'bfactor': return { prop: 'b', gradient: new $3Dmol.Gradient.Sinebow() };
      case 'ss': return 'ssJmol';
      case 'residue': return 'amino';
      case 'epitope': return getEpitopeColorScheme();
      default: return 'spectrum';
    }
  }

  // --- Epitope coloring from prediction data ---
  function getEpitopeColorScheme() {
    return {
      prop: 'resi',
      map: generateEpitopeMap()
    };
  }

  function generateEpitopeMap() {
    const map = {};
    if (!currentProtein) return map;
    const seqLen = currentProtein.sequence.length;

    // Default: blue for all residues
    for (let i = 1; i <= seqLen; i++) {
      map[i] = 0x4488ff;
    }

    // If we have real epitope data, color those residues
    if (epitopeData && epitopeData.epitopes && epitopeData.epitopes.length > 0) {
      for (const ep of epitopeData.epitopes) {
        const start = ep.start || ep.start_position || 1;
        const end = ep.end || ep.end_position || start;
        // Color by score: high score => bright red, lower => orange
        const score = ep.score || ep.combined_score || 0.5;
        const r = Math.round(255);
        const g = Math.round(80 * (1 - score));
        const b = Math.round(60 * (1 - score));
        const color = (r << 16) | (g << 8) | b;
        for (let i = start; i <= end && i <= seqLen; i++) {
          map[i] = color;
        }
      }
    }
    return map;
  }

  // --- Style and color setters ---
  window.setStyle = function (style) {
    currentStyle = style;
    document.querySelectorAll('.style-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.style === style);
      if (btn.dataset.style === style) {
        btn.classList.remove('bg-white/6');
        btn.style.background = 'rgba(59,130,246,0.15)';
        btn.style.borderColor = 'rgba(59,130,246,0.3)';
      } else {
        btn.style.background = '';
        btn.style.borderColor = '';
      }
    });
    applyCurrentStyle();
  };

  window.setColor = function (color) {
    currentColor = color;
    document.querySelectorAll('.color-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.color === color);
      if (btn.dataset.color === color) {
        btn.style.background = 'rgba(13,148,136,0.15)';
        btn.style.borderColor = 'rgba(13,148,136,0.3)';
      } else {
        btn.style.background = '';
        btn.style.borderColor = '';
      }
    });
    applyCurrentStyle();
  };

  // --- View controls ---
  window.resetView = function () {
    if (!viewer) return;
    viewer.zoomTo();
    scheduleRender();
  };

  window.toggleSpin = function () {
    if (!viewer) return;
    // Disable spin on low-end hardware
    if (perfMode === 0 && !isSpinning) {
      Utils.showToast('Rotation désactivée en mode Éco', 'warning', 2500);
      return;
    }
    isSpinning = !isSpinning;
    viewer.spin(isSpinning ? 'y' : false);
    Utils.showToast(isSpinning ? 'Rotation activée' : 'Rotation désactivée', 'info', 1500);
  };

  window.zoomIn = function () {
    if (!viewer) return;
    viewer.zoom(1.3, 300);
    scheduleRender();
  };

  window.zoomOut = function () {
    if (!viewer) return;
    viewer.zoom(0.7, 300);
    scheduleRender();
  };

  // --- Performance mode toggle (user-exposed) ---
  window.setPerfMode = function (mode) {
    perfMode = Number(mode);
    sessionStorage.setItem('viewer3d_perfMode', String(perfMode));
    const labels = ['Éco ⚡', 'Équilibré ⚖️', 'Qualité 🎯'];
    Utils.showToast(`Mode: ${labels[perfMode]} — rechargez la protéine`, 'info', 3000);
    document.querySelectorAll('.perf-btn').forEach(b => {
      b.classList.toggle('active', Number(b.dataset.perf) === perfMode);
    });
    // Re-init viewer with new quality settings then reload current protein
    if (viewer) {
      viewer.clear();
      viewer = null;
      initViewer();
      if (currentPDBData) {
        loadPDBIntoViewer(currentPDBData);
      }
    }
  };

  // Restore saved perf mode preference
  (function () {
    try {
      const saved = sessionStorage.getItem('viewer3d_perfMode');
      if (saved !== null) perfMode = Number(saved);
    } catch (_) {}
  })();

  // Pause spin when tab is not visible (saves GPU on background tabs)
  document.addEventListener('visibilitychange', function () {
    if (!viewer) return;
    if (document.hidden) {
      viewer.spin(false);
    } else if (isSpinning && perfMode > 0) {
      viewer.spin('y');
    }
  });

  // --- Search UI ---
  window.toggleSearchBox = function () {
    const box = document.getElementById('search-box');
    if (!box) return;
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) {
      const input = document.getElementById('search-input');
      input.focus();
      input.select();
    }
  };

  // --- Search in protein ---
  window.searchInProtein = function () {
    const q = (document.getElementById('search-input') || { value: '' }).value.trim();
    if (!q) {
      Utils.showToast('Entrez un numéro, une plage ou une séquence', 'warning');
      return;
    }
    if (!viewer || !currentModel || !currentProtein) {
      Utils.showToast('Aucune protéine chargée', 'warning');
      return;
    }

    // Clear previous highlights/labels
    viewer.removeAllLabels();
    viewer.removeAllShapes();

    // Interpret query: single number, range (start-end) or sequence substring
    const numberMatch = q.match(/^\s*(\d+)\s*$/);
    const rangeMatch = q.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);

    let start = null, end = null;

    if (numberMatch) {
      start = parseInt(numberMatch[1], 10);
      end = start;
    } else if (rangeMatch) {
      start = parseInt(rangeMatch[1], 10);
      end = parseInt(rangeMatch[2], 10);
      if (end < start) [start, end] = [end, start];
    } else {
      // Sequence substring search (one-letter codes expected)
      const seq = (currentProtein.sequence || '').toUpperCase();
      const sub = q.toUpperCase();
      const idx = seq.indexOf(sub);
      if (idx === -1) {
        Utils.showToast('Séquence non trouvée', 'warning');
        return;
      }
      start = idx + 1; // residues are 1-based
      end = start + sub.length - 1;
    }

    // Find atoms in selected residue range
    const allAtoms = currentModel.selectedAtoms({});
    const matched = allAtoms.filter(a => {
      const r = parseInt(a.resi, 10);
      return r >= start && r <= end;
    });

    if (matched.length === 0) {
      Utils.showToast('Aucune correspondance atomique trouvée', 'warning');
      return;
    }

    // Highlight matched residues by setting a special style for that residue range
    try {
      viewer.setStyle({ resi: [start, end] }, { sphere: { scale: 0.45, color: '0xff4444' } });
    } catch (e) {
      // Fallback: add labels and small cylinders at CA positions
      matched.filter(a => a.atom === 'CA').forEach(atom => {
        viewer.addLabel(`${atom.resn}${atom.resi}`, { position: atom, fontSize: 10, backgroundColor: 'rgba(255,68,68,0.9)', fontColor: 'white', padding: 4 });
      });
    }

    // Zoom to the selection
    viewer.zoomTo({ resi: [start, end] });
    // Add a label at the first matched atom
    const first = matched[0];
    if (first) {
      viewer.addLabel(`${first.resn} ${first.resi}`, { position: first, backgroundColor: 'rgba(30,30,60,0.9)', fontColor: 'white', fontSize: 12, padding: 6 });
    }

    viewer.render();
    Utils.showToast(`Résidus ${start}${start===end? '': ('–' + end)} mis en évidence`, 'success', 2500);
  };

  // --- Options ---
  window.toggleHBonds = function (show) {
    if (!viewer || !currentModel) return;
    viewer.removeAllShapes();
    if (show) {
      if (perfMode === 0) {
        Utils.showToast('Liaisons H désactivées en mode Éco', 'warning', 2500);
        document.getElementById('opt-hbonds').checked = false;
        return;
      }

      // O(N) spatial bucket approach — avoids O(N²) full pairwise scan
      const atoms = currentModel.selectedAtoms({});
      const CUTOFF = 3.5;
      const CUTOFF2 = CUTOFF * CUTOFF;
      const MIN_DIST2 = 2.5 * 2.5;
      const BUCKET = CUTOFF;

      // Build spatial hash of O atoms
      const oBuckets = new Map();
      for (const o of atoms) {
        if (o.elem !== 'O') continue;
        const bx = Math.floor(o.x / BUCKET);
        const by = Math.floor(o.y / BUCKET);
        const bz = Math.floor(o.z / BUCKET);
        const key = `${bx},${by},${bz}`;
        if (!oBuckets.has(key)) oBuckets.set(key, []);
        oBuckets.get(key).push(o);
      }

      // Cap total H-bonds drawn to avoid GPU overload on large proteins
      const MAX_HBONDS = perfMode >= 2 ? 500 : 200;
      let drawn = 0;

      outer: for (const n of atoms) {
        if (n.elem !== 'N') continue;
        const bx0 = Math.floor(n.x / BUCKET);
        const by0 = Math.floor(n.y / BUCKET);
        const bz0 = Math.floor(n.z / BUCKET);
        for (let dbx = -1; dbx <= 1; dbx++) {
          for (let dby = -1; dby <= 1; dby++) {
            for (let dbz = -1; dbz <= 1; dbz++) {
              const key = `${bx0+dbx},${by0+dby},${bz0+dbz}`;
              const bucket = oBuckets.get(key);
              if (!bucket) continue;
              for (const o of bucket) {
                if (n.resi === o.resi) continue;
                const dx = n.x - o.x, dy = n.y - o.y, dz = n.z - o.z;
                const d2 = dx*dx + dy*dy + dz*dz;
                if (d2 >= MIN_DIST2 && d2 <= CUTOFF2) {
                  viewer.addCylinder({
                    start: { x: n.x, y: n.y, z: n.z },
                    end: { x: o.x, y: o.y, z: o.z },
                    radius: 0.03, color: 'yellow', dashed: true, opacity: 0.5
                  });
                  if (++drawn >= MAX_HBONDS) break outer;
                }
              }
            }
          }
        }
      }
      if (drawn === MAX_HBONDS) {
        Utils.showToast(`Liaisons H limitées à ${MAX_HBONDS} (performance)`, 'info', 2500);
      }
    }
    scheduleRender();
  };

  window.toggleLabels = function (show) {
    if (!viewer || !currentModel) return;
    viewer.removeAllLabels();
    if (show) {
      const atoms = currentModel.selectedAtoms({ atom: 'CA' });
      // Adaptive density: low-end shows every 10th residue, mid every 5th, high every 2nd
      const step = perfMode === 0 ? 10 : perfMode === 1 ? 5 : 2;
      // Also cap total labels to avoid GPU overload
      const MAX_LABELS = perfMode === 0 ? 50 : perfMode === 1 ? 150 : 400;
      let count = 0;
      atoms.forEach((atom, i) => {
        if (i % step !== 0 || count >= MAX_LABELS) return;
        viewer.addLabel(atom.resn + atom.resi, {
          position: atom,
          fontSize: 9,
          fontColor: 'white',
          backgroundColor: 'rgba(0,0,0,0.5)',
          backgroundOpacity: 0.5,
          borderRadius: 4,
          padding: 2
        });
        count++;
      });
    }
    scheduleRender();
  };

  window.toggleBackground = function (white) {
    if (!viewer) return;
    viewer.setBackgroundColor(white ? '0xffffff' : '0xf0f4f8');
    scheduleRender();
  };

  // --- Export ---
  window.exportPNG = function () {
    if (!viewer) return;
    const imgData = viewer.pngURI();
    const link = document.createElement('a');
    link.href = imgData;
    link.download = `${currentProtein ? currentProtein.name : 'structure'}_3d.png`;
    link.click();
    Utils.showToast('Image PNG exportée', 'success');
  };

  window.downloadPDB = function () {
    if (!currentPDBData) {
      Utils.showToast('Aucune structure à télécharger', 'warning');
      return;
    }
    const ext = currentFileFormat === 'cif' ? 'cif' : 'pdb';
    const baseName = currentProtein ? currentProtein.name : 'structure';
    Utils.downloadFile(currentPDBData, `${baseName}.${ext}`);
    Utils.showToast(`Fichier ${ext.toUpperCase()} téléchargé`, 'success');
  };

  // --- Update panels ---
  function updateInfoPanel(protein) {
    const container = document.getElementById('info-content');
    const esc = Utils.escapeHTML;
    const tagHTML = (protein.tags || []).map(t => `<span class="tag tag-violet">${esc(t)}</span>`).join('');
    container.innerHTML = `
      <div class="flex justify-between items-start">
        <span class="text-gray-400 text-xs">Nom</span>
        <span class="font-medium text-sm text-right text-gray-900">${esc(protein.name)}</span>
      </div>
      <div class="flex justify-between items-start">
        <span class="text-gray-400 text-xs">Complet</span>
        <span class="text-xs text-right text-gray-600">${esc(protein.full_name)}</span>
      </div>
      <div class="flex justify-between items-start">
        <span class="text-gray-400 text-xs">Organisme</span>
        <span class="text-xs text-right text-gray-600">${esc(protein.organism)}</span>
      </div>
      <div class="flex justify-between items-start">
        <span class="text-gray-400 text-xs">Longueur</span>
        <span class="text-xs text-right text-gray-600">${protein.sequence.length} résidus</span>
      </div>
      ${protein.molecular_weight ? `
      <div class="flex justify-between items-start">
        <span class="text-gray-400 text-xs">Masse mol.</span>
        <span class="text-xs text-right text-gray-600">${Utils.formatNumber(protein.molecular_weight)} Da</span>
      </div>` : ''}
      ${protein.resolution ? `
      <div class="flex justify-between items-start">
        <span class="text-gray-400 text-xs">Résolution</span>
        <span class="text-xs text-right text-gray-600">${esc(String(protein.resolution))}</span>
      </div>` : ''}
      ${protein.method ? `
      <div class="flex justify-between items-start">
        <span class="text-gray-400 text-xs">Méthode</span>
        <span class="text-xs text-right text-gray-600">${esc(protein.method)}</span>
      </div>` : ''}
      <div class="pt-2">
        <p class="text-xs text-gray-400 leading-relaxed">${esc(protein.description || '')}</p>
      </div>
      ${tagHTML ? `<div class="flex flex-wrap gap-1.5 pt-1">${tagHTML}</div>` : ''}
    `;
  }

  function updateSequenceDisplay(sequence) {
    const el = document.getElementById('sequence-display');
    el.textContent = Utils.formatSequence(sequence || '');
  }

  window.copyCurrentSequence = function () {
    if (currentProtein && currentProtein.sequence) {
      Utils.copyToClipboard(currentProtein.sequence);
    }
  };

  // --- Epitope prediction ---
  window.predictEpitopes = async function () {
    if (!currentProtein || !currentProtein.sequence) {
      Utils.showToast('Chargez une protéine d\'abord', 'warning');
      return;
    }

    const btn = document.getElementById('btn-predict-epitopes');
    const loading = document.getElementById('epitope-loading');
    const resultsDiv = document.getElementById('epitope-results');

    // Get parameters from UI
    const method = document.getElementById('epitope-method').value;
    const minLen = parseInt(document.getElementById('epitope-min-len').value) || 9;
    const maxLen = parseInt(document.getElementById('epitope-max-len').value) || 20;
    const minScore = parseFloat(document.getElementById('epitope-min-score').value) || 0.5;
    const topN = parseInt(document.getElementById('epitope-top-n').value) || 20;
    const chainId = document.getElementById('epitope-chain-id').value || 'A';

    // Prepare PDB file if available
    let pdbFile = null;
    if (currentPDBData) {
      pdbFile = new Blob([currentPDBData], { type: 'text/plain' });
    }

    // Show loading, hide results
    btn.disabled = true;
    btn.classList.add('opacity-50');
    loading.classList.remove('hidden');
    resultsDiv.classList.add('hidden');

    try {
      const response = await API.analyzeEpitopes({
        protein_id: currentProtein.id,
        sequence: currentProtein.sequence,
        method: method,
        min_length: minLen,
        max_length: maxLen,
        min_score: minScore,
        top_n: topN,
        pdb_file: pdbFile,
        chain_id: chainId
      });

      if (!response.success) {
        Utils.showToast('Erreur: ' + (response.error || 'Échec de l\'analyse'), 'error');
        return;
      }

      if (response.pdb_skipped) {
        Utils.showToast('Le fichier PDB était incompatible avec la séquence — analyse effectuée sans PDB', 'warning');
      }

      epitopeData = response.data;
      displayEpitopeResults(response.data);

      // Persist epitope data so it survives page reload
      try {
        sessionStorage.setItem('viewer3d_epitopeData', JSON.stringify({
          proteinId: currentProtein ? (currentProtein.id || currentProtein.name) : null,
          data: response.data
        }));
      } catch(e) { /* quota exceeded — ignore */ }

      Utils.showToast('Analyse des épitopes terminée — cliquez sur un épitope pour le visualiser en 3D', 'success');
    } catch (err) {
      Utils.showToast('Erreur: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('opacity-50');
      loading.classList.add('hidden');
    }
  };

  // --- Restore epitope data from sessionStorage ---
  function restoreEpitopeData() {
    try {
      const raw = sessionStorage.getItem('viewer3d_epitopeData');
      if (!raw) return;
      const stored = JSON.parse(raw);
      const currentId = currentProtein ? (currentProtein.id || currentProtein.name) : null;
      if (stored.proteinId && String(stored.proteinId) === String(currentId) && stored.data) {
        epitopeData = stored.data;
        displayEpitopeResults(stored.data);
        highlightEpitopesOn3D(stored.data);
      }
    } catch (e) {
      console.warn('Could not restore epitope data', e);
    }
  }

  // --- Display epitope results in the panel ---
  function displayEpitopeResults(data) {
    const resultsDiv = document.getElementById('epitope-results');
    const countEl = document.getElementById('epitope-count');
    const summaryEl = document.getElementById('epitope-summary');
    const listEl = document.getElementById('epitope-list');

    const epitopes = data.epitopes || data.results || [];
    if (epitopes.length === 0) {
      resultsDiv.classList.remove('hidden');
      countEl.textContent = '0 épitopes';
      summaryEl.textContent = 'Aucun épitope candidat trouvé avec ces paramètres.';
      listEl.innerHTML = '';
      return;
    }

    countEl.textContent = `${epitopes.length} épitope${epitopes.length > 1 ? 's' : ''}`;

    // Summary stats
    const avgScore = epitopes.reduce((sum, e) => sum + (e.score || e.combined_score || 0), 0) / epitopes.length;
    const methodUsed = Utils.escapeHTML(data.method || data.analysis_method || '—');
    summaryEl.innerHTML = `
      <div class="flex gap-3 flex-wrap">
        <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-amber-500"></span>Méthode: <strong>${methodUsed}</strong></span>
        <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-blue-500"></span>Score moy: <strong>${avgScore.toFixed(3)}</strong></span>
      </div>
    `;

    // List each epitope
    listEl.innerHTML = epitopes.map((ep, idx) => {
      const start = ep.start || ep.start_position || '?';
      const end = ep.end || ep.end_position || '?';
      // Resolve sequence: prefer API-provided, fallback to slicing the full protein sequence
      let seq = ep.sequence || ep.peptide || '';
      if (!seq && currentProtein && currentProtein.sequence && start !== '?' && end !== '?') {
        seq = currentProtein.sequence.slice(start - 1, end);
      }
      if (!seq) seq = '—';
      const score = (ep.score || ep.combined_score || 0).toFixed(3);
      const length = ep.length || (seq !== '—' ? seq.length : 0);
      // Score bar width
      const pct = Math.round((ep.score || ep.combined_score || 0) * 100);
      const barColor = pct >= 70 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-500' : 'bg-blue-400';

      return `
        <div class="epitope-item p-2.5 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50/50 transition-all cursor-pointer" onclick="focusEpitope(${start}, ${end})">
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs font-semibold text-gray-700">#${idx + 1}</span>
            <span class="text-xs font-mono font-bold ${pct >= 70 ? 'text-red-600' : pct >= 50 ? 'text-amber-600' : 'text-blue-600'}">${score}</span>
          </div>
          <div class="mb-1.5">
            <span class="text-[9px] text-gray-400 uppercase tracking-wider font-medium">Séquence</span>
            <div class="font-mono text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-1.5 py-1 break-all leading-5 mt-0.5 select-all">${Utils.escapeHTML(seq)}</div>
          </div>
          <div class="flex items-center justify-between text-[10px] text-gray-400">
            <span>Pos: ${start}–${end} (${length} aa)</span>
          </div>
          <div class="mt-1.5 w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div class="h-full rounded-full ${barColor} transition-all" style="width:${pct}%"></div>
          </div>
        </div>
      `;
    }).join('');

    resultsDiv.classList.remove('hidden');
  }

  // --- Highlight epitopes on the 3D structure ---
  function highlightEpitopesOn3D(data) {
    if (!viewer || !currentModel) return;

    const epitopes = data.epitopes || data.results || [];
    if (epitopes.length === 0) return;

    // Remove previous labels/shapes
    viewer.removeAllLabels();
    viewer.removeAllShapes();

    // Re-apply base style
    applyCurrentStyle();

    // Highlight each epitope region
    epitopes.forEach((ep, idx) => {
      const start = ep.start || ep.start_position || 1;
      const end = ep.end || ep.end_position || start;
      const score = ep.score || ep.combined_score || 0.5;

      // Color intensity based on score
      const red = Math.round(255);
      const green = Math.round(80 * (1 - score));
      const blue = Math.round(60 * (1 - score));
      const hexColor = '0x' + ((1 << 24) + (red << 16) + (green << 8) + blue).toString(16).slice(1);

      // Overlay epitope residues with sphere or cartoon highlight
      try {
        const sel = { resi: [`${start}-${end}`] };
        viewer.addStyle(sel, {
          cartoon: { color: hexColor, opacity: 1, arrows: true, tubes: true, thickness: 0.4 }
        });

        // Add a label for top 5
        if (idx < 5) {
          const midResi = Math.floor((start + end) / 2);
          const atoms = currentModel.selectedAtoms({ resi: midResi, atom: 'CA' });
          if (atoms.length > 0) {
            viewer.addLabel(`E${idx + 1} (${score.toFixed(2)})`, {
              position: atoms[0],
              backgroundColor: 'rgba(220,38,38,0.9)',
              fontColor: 'white',
              fontSize: 10,
              borderRadius: 6,
              padding: 4,
              backgroundOpacity: 0.9
            });
          }
        }
      } catch (e) {
        console.warn('Could not highlight epitope', idx, e);
      }
    });

    viewer.render();
  }

  // --- Focus on a specific epitope in 3D ---
  window.focusEpitope = function (start, end) {
    if (!viewer || !currentModel) return;

    viewer.removeAllLabels();
    viewer.removeAllShapes();

    // Reset to base style, then highlight only this epitope
    applyCurrentStyle();

    try {
      // Highlight the clicked epitope
      viewer.addStyle({ resi: [`${start}-${end}`] }, {
        cartoon: { color: '#e53e3e', opacity: 1, arrows: true, tubes: true, thickness: 0.4 }
      });

      // Zoom to the epitope region
      viewer.zoomTo({ resi: [`${start}-${end}`] });

      // Add label at midpoint
      const midResi = Math.floor((start + end) / 2);
      const atoms = currentModel.selectedAtoms({ resi: midResi, atom: 'CA' });
      if (atoms.length > 0) {
        viewer.addLabel(`Résidus ${start}–${end}`, {
          position: atoms[0],
          backgroundColor: 'rgba(220,38,38,0.95)',
          fontColor: 'white',
          fontSize: 12,
          borderRadius: 8,
          padding: 6,
          backgroundOpacity: 0.95
        });
      }
    } catch (e) {
      console.warn('focusEpitope error', e);
    }

    viewer.render();
    Utils.showToast(`Épitope résidus ${start}–${end}`, 'info', 2000);
  };

  // --- Open Epitope Details Page ---
  window.showAllEpitopesDetails = function () {
    if (!epitopeData) {
      Utils.showToast('Aucune donnée d\'épitope disponible', 'warning');
      return;
    }
    const epitopes = (epitopeData.epitopes || epitopeData.results || []);
    if (epitopes.length === 0) {
      Utils.showToast('Aucun épitope à afficher', 'warning');
      return;
    }
    // Store data in sessionStorage and navigate
    sessionStorage.setItem('epitopeDetailsData', JSON.stringify({
      analysisData: epitopeData,
      proteinName: currentProtein ? currentProtein.name : '—',
      proteinSequence: currentProtein ? currentProtein.sequence : ''
    }));
    window.open('epitope-details.html', '_blank');
  };

  // --- Mobile menu ---
  window.toggleMobileMenu = function () {
    document.getElementById('mobile-menu').classList.toggle('open');
  };
})();
