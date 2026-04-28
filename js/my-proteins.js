/**
 * EpitopX AI — Mes Protéines
 * Liste des protéines de l'utilisateur connecté via GET /api/proteins/my_proteins/
 */

(function () {
  'use strict';

  let allProteins = [];
  let filteredProteins = [];
  let currentSort = 'name';
  let isListView = false;
  let pendingDeleteId = null;

  const tagColors = ['tag-violet', 'tag-cyan', 'tag-pink', 'tag-emerald', 'tag-amber'];

  // --- Init ---
  document.addEventListener('DOMContentLoaded', async () => {
    await loadProteins();
  });

  // --- Load ---
  async function loadProteins() {
    const grid = document.getElementById('proteins-grid');
    Utils.showSkeleton(grid, 6);

    try {
      const response = await API.getMyProteins();
      if (!response.success) throw new Error(response.error || 'API error');
      allProteins = (response.data || []).map(p => ({
        ...p,
        tags: p.tags || [],
        family: p.family || 'Inconnue',
        description: p.description || ''
      }));
      filteredProteins = [...allProteins];
      populateFilters();
      sortAndRender();
    } catch (err) {
      Utils.showToast('Erreur de chargement : ' + err.message, 'error');
      const grid = document.getElementById('proteins-grid');
      grid.innerHTML = '';
      const empty = document.getElementById('empty-state');
      document.getElementById('empty-msg').textContent = 'Impossible de charger vos protéines.';
      empty.classList.remove('hidden');
    }
  }

  // --- Filters ---
  function populateFilters() {
    const organisms = [...new Set(allProteins.map(p => p.organism).filter(Boolean))];
    const orgSelect = document.getElementById('filter-organism');
    orgSelect.innerHTML = '<option value="">Tous les organismes</option>';
    organisms.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      orgSelect.appendChild(opt);
    });
  }

  window.handleSearch = Utils.debounce(function () {
    applyFilters();
  }, 250);

  window.applyFilters = function () {
    const query = document.getElementById('search-input').value.trim();
    const organism = document.getElementById('filter-organism').value;

    filteredProteins = allProteins.filter(p => {
      const matchesQuery = !query || [p.name, p.full_name, p.organism, p.sequence, p.description]
        .some(f => (f || '').toLowerCase().includes(query.toLowerCase()));
      const matchesOrg = !organism || p.organism === organism;
      return matchesQuery && matchesOrg;
    });

    updateFilterTags(query, organism);
    sortAndRender();
  };

  function updateFilterTags(query, organism) {
    const container = document.getElementById('filter-tags');
    container.innerHTML = '';
    if (query) addFilterTag(container, `Recherche : "${query}"`, () => {
      document.getElementById('search-input').value = '';
      applyFilters();
    });
    if (organism) addFilterTag(container, organism, () => {
      document.getElementById('filter-organism').value = '';
      applyFilters();
    });
  }

  function addFilterTag(container, text, onRemove) {
    const tag = document.createElement('button');
    tag.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs transition-all hover:bg-blue-100';
    tag.innerHTML = `${text} <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`;
    tag.onclick = onRemove;
    container.appendChild(tag);
  }

  window.resetFilters = function () {
    document.getElementById('search-input').value = '';
    document.getElementById('filter-organism').value = '';
    filteredProteins = [...allProteins];
    updateFilterTags('', '');
    sortAndRender();
  };

  // --- Sort ---
  window.sortBy = function (key) {
    currentSort = key;
    document.querySelectorAll('.sort-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === key);
      btn.classList.toggle('tag-violet', btn.dataset.sort === key);
    });
    sortAndRender();
  };

  function sortAndRender() {
    const sorted = [...filteredProteins].sort((a, b) => {
      switch (currentSort) {
        case 'name': return a.name.localeCompare(b.name);
        case 'organism': return a.organism.localeCompare(b.organism);
        case 'weight': return (b.molecular_weight || 0) - (a.molecular_weight || 0);
        case 'length': return b.sequence.length - a.sequence.length;
        default: return 0;
      }
    });
    renderCards(sorted);
  }

  // --- Toggle view ---
  window.toggleView = function () {
    isListView = !isListView;
    const grid = document.getElementById('proteins-grid');
    grid.className = isListView
      ? 'flex flex-col gap-4'
      : 'grid gap-6 sm:grid-cols-2 lg:grid-cols-3';
    sortAndRender();
  };

  // --- Render ---
  function renderCards(proteins) {
    const grid = document.getElementById('proteins-grid');
    const empty = document.getElementById('empty-state');
    const count = document.getElementById('total-count');
    const esc = Utils.escapeHTML;
    const escA = Utils.escapeAttr;

    count.textContent = `${proteins.length} protéine${proteins.length !== 1 ? 's' : ''}`;

    if (proteins.length === 0) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    const fragment = document.createDocumentFragment();

    proteins.forEach((p, index) => {
      const card = document.createElement('div');
      card.className = isListView
        ? 'glass-card p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4'
        : 'glass-card p-6 flex flex-col';
      if (index < 20) {
        card.style.animationDelay = `${index * 0.05}s`;
        card.classList.add('animate-fade-in');
      }

      const tagHTML = (p.tags || []).slice(0, 3).map((t, i) =>
        `<span class="tag ${tagColors[i % tagColors.length]}">${esc(t)}</span>`
      ).join('');

      const safeId = Number(p.id);
      const safeName = esc(p.name);
      const safeFullName = esc(p.full_name || '');
      const safeOrganism = esc(p.organism || '—');
      const safeDescription = esc(p.description || '');
      const seqLen = p.sequence ? p.sequence.length : 0;
      const mw = p.molecular_weight ? Utils.formatNumber(p.molecular_weight) + ' Da' : '—';

      if (isListView) {
        card.innerHTML = `
          <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-100 to-blue-100 flex items-center justify-center text-lg font-bold text-violet-700 shrink-0">
            ${esc(p.name.charAt(0))}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <h3 class="font-semibold truncate text-gray-900">${safeName}</h3>
              <span class="text-xs text-gray-400">— ${safeFullName}</span>
            </div>
            <p class="text-xs text-gray-400 truncate">${safeOrganism} • ${seqLen} aa • ${mw}</p>
          </div>
          <div class="flex items-center gap-2">${tagHTML}</div>
          <div class="flex items-center gap-2 shrink-0">
            <a href="viewer.html?id=${safeId}" class="btn-icon" title="Voir en 3D">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5"/></svg>
            </a>
            <button data-delete-id="${safeId}" data-delete-name="${escA(p.name)}" class="btn-icon text-red-400 hover:text-red-600 hover:bg-red-50 delete-protein-btn" title="Supprimer">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        `;
      } else {
        card.innerHTML = `
          <div class="flex items-start justify-between mb-4">
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-100 to-blue-100 flex items-center justify-center text-lg font-bold text-violet-700">
              ${esc(p.name.charAt(0))}
            </div>
            <div class="flex items-center gap-2">
              <a href="viewer.html?id=${safeId}" class="btn-icon" title="Voir en 3D">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5"/></svg>
              </a>
              <button data-delete-id="${safeId}" data-delete-name="${escA(p.name)}" class="btn-icon text-red-400 hover:text-red-600 hover:bg-red-50 delete-protein-btn" title="Supprimer">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
              </button>
            </div>
          </div>
          <h3 class="font-semibold mb-1 text-gray-900">${safeName}</h3>
          <p class="text-xs text-gray-400 mb-1">${safeFullName}</p>
          <p class="text-xs text-gray-400 mb-4 line-clamp-2">${safeDescription}</p>
          <div class="mt-auto">
            <div class="flex items-center justify-between text-xs text-gray-400 mb-3">
              <span>${safeOrganism}</span>
              <span class="font-mono">${seqLen} aa</span>
            </div>
            <div class="flex items-center justify-between text-xs text-gray-400 mb-3">
              <span>Masse mol.</span>
              <span class="font-mono">${mw}</span>
            </div>
            <div class="flex flex-wrap gap-1.5">${tagHTML}</div>
          </div>
        `;
      }

      // Attach delete handler via event delegation (no inline onclick)
      card.querySelectorAll('.delete-protein-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          openDeleteModal(Number(btn.dataset.deleteId), btn.dataset.deleteName);
        });
      });

      fragment.appendChild(card);
    });

    grid.innerHTML = '';
    grid.appendChild(fragment);
  }

  // --- Delete ---
  window.openDeleteModal = function (id, name) {
    pendingDeleteId = id;
    document.getElementById('delete-protein-name').textContent = name || 'cette protéine';
    const modal = document.getElementById('delete-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  };

  window.closeDeleteModal = function () {
    pendingDeleteId = null;
    const modal = document.getElementById('delete-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  };

  window.confirmDelete = async function () {
    if (!pendingDeleteId) return;
    const btn = document.getElementById('delete-confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Suppression...';

    const response = await API.deleteProtein(pendingDeleteId);
    if (response.success) {
      allProteins = allProteins.filter(p => p.id !== pendingDeleteId);
      filteredProteins = filteredProteins.filter(p => p.id !== pendingDeleteId);
      closeDeleteModal();
      sortAndRender();
      Utils.showToast('Protéine supprimée avec succès', 'success');
    } else {
      Utils.showToast('Erreur : ' + (response.error || 'Impossible de supprimer'), 'error');
    }

    btn.disabled = false;
    btn.textContent = 'Supprimer';
  };

  // Close modal on backdrop click
  document.getElementById('delete-modal').addEventListener('click', function (e) {
    if (e.target === this) closeDeleteModal();
  });

})();
