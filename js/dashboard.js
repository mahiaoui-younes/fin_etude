/**
 * EpitopX AI — Dashboard logic
 * Galerie de protéines avec recherche, filtres et tri
 */

(function () {
  'use strict';

  let allProteins = [];
  let filteredProteins = [];
  let currentSort = 'name';
  let isListView = false;

  const tagColors = ['tag-violet', 'tag-cyan', 'tag-pink', 'tag-emerald', 'tag-amber'];

  // --- Init ---
  document.addEventListener('DOMContentLoaded', async () => {
    await loadProteins();
  });

  // --- Load proteins ---
  async function loadProteins() {
    const grid = document.getElementById('proteins-grid');
    Utils.showSkeleton(grid, 6);

    try {
      const response = await API.getPublicProteins();
      if (!response.success) throw new Error(response.error || 'API error');
      if (response.offline) Utils.showToast('Mode hors-ligne : données locales chargées', 'warning');
      allProteins = (response.data || []).map(p => ({
        ...p,
        tags: p.tags || [],
        family: p.family || 'Inconnue',
        description: p.description || ''
      }));
    } catch (err) {
      Utils.showToast('Erreur de chargement des protéines : ' + err.message, 'error');
    }

    filteredProteins = [...allProteins];
    populateFilters();
    sortAndRender();
  }

  // --- Populate filter dropdowns from fetched data ---
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

  // --- Search ---
  window.handleSearch = Utils.debounce(function (query) {
    applyFilters();
  }, 250);

  // --- Filters ---
  window.applyFilters = function () {
    const query = document.getElementById('search-input').value.trim();
    const organism = document.getElementById('filter-organism').value;

    filteredProteins = allProteins.filter(p => {
      const matchesQuery = !query || [
        p.name, p.full_name, p.organism, p.sequence, p.description
      ].some(field => (field || '').toLowerCase().includes(query.toLowerCase()));

      const matchesOrg = !organism || p.organism === organism;

      return matchesQuery && matchesOrg;
    });

    updateFilterTags(query, organism);
    sortAndRender();
  };

  // --- Filter tags ---
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

    count.textContent = `${proteins.length} résultat${proteins.length !== 1 ? 's' : ''}`;

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
        ? 'glass-card p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4 cursor-pointer'
        : 'glass-card p-6 cursor-pointer flex flex-col';
      // Only animate first 20 cards for performance
      if (index < 20) {
        card.style.animationDelay = `${index * 0.05}s`;
        card.classList.add('animate-fade-in');
      }

      const tagHTML = (p.tags || []).slice(0, 3).map((t, i) =>
        `<span class="tag ${tagColors[i % tagColors.length]}">${esc(t)}</span>`
      ).join('');

      const safeId = Number(p.id);
      const safeName = esc(p.name);
      const safeFullName = esc(p.full_name);
      const safeOrganism = esc(p.organism);
      const safeDescription = esc(p.description);
      const seqLen = (p.sequence || '').length;

      if (isListView) {
        card.innerHTML = `
          <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-100 to-teal-100 flex items-center justify-center text-lg font-bold text-blue-700 shrink-0">
            ${esc(p.name.charAt(0))}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <h3 class="font-semibold truncate text-gray-900">${safeName}</h3>
              <span class="text-xs text-gray-400">— ${safeFullName}</span>
            </div>
            <p class="text-xs text-gray-400 truncate">${safeOrganism} • ${seqLen} aa • ${Utils.formatNumber(p.molecular_weight)} Da</p>
          </div>
          <div class="flex items-center gap-2">${tagHTML}</div>
          <svg class="w-4 h-4 text-gray-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
        `;
      } else {
        card.innerHTML = `
          <div class="flex items-start justify-between mb-4">
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-100 to-teal-100 flex items-center justify-center text-lg font-bold text-blue-700">
              ${esc(p.name.charAt(0))}
            </div>
          </div>
          <h3 class="font-semibold mb-1 text-gray-900">${safeName}</h3>
          <p class="text-xs text-gray-400 mb-1">${safeFullName}</p>
          <p class="text-xs text-gray-400 mb-4 line-clamp-2">${safeDescription}</p>
          <div class="mt-auto">
            <div class="flex items-center justify-between text-xs text-gray-400 mb-3">
              <span>${safeOrganism}</span>
              <span>${seqLen} aa</span>
            </div>
            <div class="flex items-center justify-between">
              <div class="flex gap-1.5 flex-wrap">${tagHTML}</div>
            </div>
            <div class="flex gap-2 mt-4">
              <a href="viewer.html?id=${safeId}" class="btn-primary text-xs flex-1 text-center" onclick="event.stopPropagation()">
                Voir en 3D
              </a>
              <button class="btn-icon w-9 h-9 copy-seq-btn" title="Copier la séquence" data-seq="${Utils.escapeAttr(p.sequence)}" onclick="event.stopPropagation(); Utils.copyToClipboard(this.dataset.seq)">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
              </button>
            </div>
          </div>
        `;
      }

      card.addEventListener('click', () => {
        window.location.href = `viewer.html?id=${safeId}`;
      });

      fragment.appendChild(card);
    });

    grid.innerHTML = '';
    grid.appendChild(fragment);
  }

  // --- Mobile menu ---
  window.toggleMobileMenu = function () {
    document.getElementById('mobile-menu').classList.toggle('open');
  };
})();
