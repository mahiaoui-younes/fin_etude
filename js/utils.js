/**
 * EpitopX AI — Utilitaires partagés
 */

var Utils = typeof Utils !== 'undefined' ? Utils : (() => {

  /** Debounce */
  function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  /** Format number with locale */
  function formatNumber(n) {
    return new Intl.NumberFormat('fr-FR').format(n);
  }

  /** Truncate text */
  function truncate(text, max = 100) {
    if (!text || text.length <= max) return text;
    return text.substring(0, max) + '…';
  }

  /** Format sequence with spaces every 10 chars */
  function formatSequence(seq, groupSize = 10) {
    if (!seq) return '';
    const groups = [];
    for (let i = 0; i < seq.length; i += groupSize) {
      groups.push(seq.substring(i, i + groupSize));
    }
    return groups.join(' ');
  }

  /** Show toast notification */
  function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container') || createToastContainer();
    const toast = document.createElement('div');

    const colors = {
      success: 'bg-emerald-500/90 border-emerald-400',
      error: 'bg-red-500/90 border-red-400',
      warning: 'bg-amber-500/90 border-amber-400',
      info: 'bg-blue-500/90 border-blue-400'
    };

    const icons = {
      success: '✓',
      error: '✕',
      warning: '⚠',
      info: 'ℹ'
    };

    toast.className = `flex items-center gap-3 px-5 py-3 rounded-xl border backdrop-blur-sm text-white shadow-2xl transform translate-x-full transition-transform duration-300 ${colors[type]}`;
    const iconSpan = document.createElement('span');
    iconSpan.className = 'text-lg font-bold';
    iconSpan.textContent = icons[type];
    const msgSpan = document.createElement('span');
    msgSpan.className = 'text-sm font-medium';
    msgSpan.textContent = message;
    toast.appendChild(iconSpan);
    toast.appendChild(msgSpan);

    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.remove('translate-x-full');
      toast.classList.add('translate-x-0');
    });

    setTimeout(() => {
      toast.classList.remove('translate-x-0');
      toast.classList.add('translate-x-full');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function createToastContainer() {
    const container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'fixed top-20 right-4 z-[9999] flex flex-col gap-2';
    document.body.appendChild(container);
    return container;
  }

  /** Show loading spinner in element */
  function showLoading(element, text = 'Chargement...') {
    if (!element) return;
    element.innerHTML = `
      <div class="flex flex-col items-center justify-center py-12 gap-4">
        <div class="relative">
          <div class="w-12 h-12 border-4 border-blue-200 rounded-full"></div>
          <div class="absolute top-0 left-0 w-12 h-12 border-4 border-transparent border-t-blue-500 rounded-full animate-spin"></div>
        </div>
        <p class="text-gray-500 text-sm">${text}</p>
      </div>
    `;
  }

  /** Create skeleton loader cards */
  function showSkeleton(container, count = 6) {
    if (!container) return;
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const card = document.createElement('div');
      card.className = 'bg-gray-100 rounded-2xl p-6 animate-pulse';
      card.innerHTML = `
        <div class="h-4 bg-gray-200 rounded w-2/3 mb-4"></div>
        <div class="h-3 bg-gray-200 rounded w-full mb-2"></div>
        <div class="h-3 bg-gray-200 rounded w-4/5 mb-4"></div>
        <div class="flex gap-2">
          <div class="h-6 bg-gray-200 rounded-full w-16"></div>
          <div class="h-6 bg-gray-200 rounded-full w-20"></div>
        </div>
      `;
      container.appendChild(card);
    }
  }

  /** Download file */
  function downloadFile(content, filename, mimeType = 'text/plain') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Copy text to clipboard */
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copié dans le presse-papiers', 'success', 2000);
    } catch {
      // Fallback
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      showToast('Copié dans le presse-papiers', 'success', 2000);
    }
  }

  /** Animate element entrance */
  function animateIn(element, delay = 0) {
    if (!element) return;
    element.style.opacity = '0';
    element.style.transform = 'translateY(20px)';
    setTimeout(() => {
      element.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
      element.style.opacity = '1';
      element.style.transform = 'translateY(0)';
    }, delay);
  }

  /** Setup intersection observer for scroll animations */
  function setupScrollAnimations() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('animate-fade-in');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    document.querySelectorAll('[data-animate]').forEach(el => {
      observer.observe(el);
    });
  }

  /** Get URL parameter */
  function getParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  /**
   * Escape HTML special characters to prevent XSS when inserting
   * user-supplied text into innerHTML.
   */
  function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
  }

  /**
   * Escape a string for safe use inside an HTML attribute (e.g. onclick).
   */
  function escapeAttr(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  return {
    debounce,
    formatNumber,
    truncate,
    formatSequence,
    showToast,
    showLoading,
    showSkeleton,
    downloadFile,
    copyToClipboard,
    animateIn,
    setupScrollAnimations,
    getParam,
    escapeHTML,
    escapeAttr
  };
})();

// Global unhandled error boundary — installed once, catches unhandled promise
// rejections and synchronous JS errors across all pages without touching any
// module’s internal logic.
if (typeof window !== 'undefined' && !window._epitopx_err_boundary) {
  window._epitopx_err_boundary = true;

  window.addEventListener('unhandledrejection', function (event) {
    console.error('[EpitopX] Unhandled promise rejection:', event.reason);
    if (event.reason && !event.reason.silent) {
      Utils.showToast('Une erreur inattendue s\'est produite', 'error', 5000);
    }
    event.preventDefault();
  });

  window.onerror = function (message, source, lineno) {
    console.error('[EpitopX] Uncaught error:', message, 'at', source + ':' + lineno);
    if (source && source.indexOf(location.hostname) !== -1) {
      Utils.showToast('Erreur JavaScript inattendue', 'error', 5000);
    }
    return false;
  };

  // Offline / online detection
  window.addEventListener('offline', function () {
    Utils.showToast('Connexion perdue — certaines fonctionnalités peuvent être indisponibles', 'warning', 8000);
  });
  window.addEventListener('online', function () {
    Utils.showToast('Connexion rétablie', 'success', 3000);
  });
}
