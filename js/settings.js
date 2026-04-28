/**
 * EpitopX AI — Settings page logic
 */

(function () {
  'use strict';

  const SERVER_URL = window.location.origin;

  // ── helpers ──────────────────────────────────────────────
  function getToken() { return (typeof Auth !== 'undefined' ? Auth.getAuthToken() : null) || ''; }

  function getUser() {
    try { return JSON.parse(localStorage.getItem('authUser')) || {}; } catch { return {}; }
  }

  function getInitials(username) {
    if (!username) return '?';
    const parts = username.split(/[_.\s-]/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return username.slice(0, 2).toUpperCase();
  }

  function setStatus(elId, message, isError) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = message;
    el.className = `text-xs ${isError ? 'text-red-500' : 'text-emerald-600'}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
  }

  // ── init ──────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    populateFromCache();
    fetchProfile();
    initTokenDisplay();
    initAboutServer();
    initLangButtons();
    initTabFromHash();
  });

  // ── tabs ──────────────────────────────────────────────────
  window.switchTab = function (tab) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.remove('hidden');
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
    location.hash = tab;
  };

  function initTabFromHash() {
    const hash = location.hash.replace('#', '');
    if (['profile', 'security', 'prefs', 'danger'].includes(hash)) {
      switchTab(hash);
    }
  }

  // ── populate from localStorage ─────────────────────────
  function populateFromCache() {
    const user = getUser();
    if (!user.username) return;

    const initials = getInitials(user.username);
    document.getElementById('settings-avatar').textContent = initials;
    document.getElementById('settings-username-display').textContent = user.username;
    document.getElementById('settings-email-display').textContent = user.email || 'Email non renseigné';
    document.getElementById('pf-username').value = user.username;
    document.getElementById('pf-email').value = user.email || '';
    document.getElementById('session-username').textContent = user.username;
    document.getElementById('delete-confirm-username').textContent = user.username;
  }

  // ── fetch profile from API ─────────────────────────────
  async function fetchProfile() {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch('/api/users/profile/', {
        headers: { 'Authorization': `Token ${token}`, 'Content-Type': 'application/json' }
      });
      if (!res.ok) return;
      const data = await res.json();

      const username = data.username || getUser().username || '';
      const email    = data.email    || getUser().email    || '';
      const firstName = data.first_name || '';
      const lastName  = data.last_name  || '';

      document.getElementById('pf-username').value  = username;
      document.getElementById('pf-email').value     = email;
      document.getElementById('pf-firstname').value = firstName;
      document.getElementById('pf-lastname').value  = lastName;

      const initials = getInitials(username);
      document.getElementById('settings-avatar').textContent = initials;
      document.getElementById('settings-username-display').textContent = username;
      document.getElementById('settings-email-display').textContent = email || 'Email non renseigné';
      document.getElementById('session-username').textContent = username;
      document.getElementById('delete-confirm-username').textContent = username;

      // update localStorage
      localStorage.setItem('authUser', JSON.stringify({ username, email, first_name: firstName, last_name: lastName }));
    } catch (_) { /* fail silently — cached data shown */ }
  }

  // ── save profile ───────────────────────────────────────
  window.saveProfile = async function (e) {
    e.preventDefault();
    const btn = document.getElementById('profile-save-btn');
    const token = getToken();
    if (!token) { Utils.showToast('Non authentifié', 'error'); return; }

    const body = {
      email:      document.getElementById('pf-email').value.trim(),
      first_name: document.getElementById('pf-firstname').value.trim(),
      last_name:  document.getElementById('pf-lastname').value.trim(),
    };

    btn.disabled = true;
    btn.textContent = 'Enregistrement…';

    try {
      const res = await fetch('/api/users/profile/', {
        method: 'PATCH',
        headers: { 'Authorization': `Token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.detail || data.email?.[0] || 'Erreur inconnue';
        setStatus('profile-status', msg, true);
        Utils.showToast(msg, 'error');
      } else {
        // update cache
        const current = getUser();
        localStorage.setItem('authUser', JSON.stringify({ ...current, ...body, email: body.email }));
        document.getElementById('settings-email-display').textContent = body.email || 'Email non renseigné';
        setStatus('profile-status', 'Modifications enregistrées', false);
        Utils.showToast('Profil mis à jour', 'success');
      }
    } catch (err) {
      setStatus('profile-status', 'Erreur réseau', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enregistrer les modifications';
    }
  };

  // ── change password ───────────────────────────────────
  window.changePassword = async function (e) {
    e.preventDefault();
    const token = getToken();
    if (!token) return;

    const current = document.getElementById('pw-current').value;
    const newPw   = document.getElementById('pw-new').value;
    const confirm = document.getElementById('pw-confirm').value;
    const btn     = document.getElementById('pw-save-btn');

    if (newPw !== confirm) {
      setStatus('pw-status', 'Les mots de passe ne correspondent pas', true);
      return;
    }
    if (newPw.length < 8) {
      setStatus('pw-status', 'Le mot de passe doit faire au moins 8 caractères', true);
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Modification…';

    try {
      const res = await fetch('/api/users/change-password/', {
        method: 'POST',
        headers: { 'Authorization': `Token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password: current, new_password: newPw, confirm_password: confirm })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.detail || data.old_password?.[0] || data.new_password?.[0] || 'Erreur inconnue';
        setStatus('pw-status', msg, true);
        Utils.showToast(msg, 'error');
      } else {
        setStatus('pw-status', 'Mot de passe modifié avec succès', false);
        Utils.showToast('Mot de passe changé', 'success');
        document.getElementById('password-form').reset();
        resetPasswordStrength();
      }
    } catch (_) {
      setStatus('pw-status', 'Erreur réseau', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Changer le mot de passe';
    }
  };

  // ── password strength ─────────────────────────────────
  window.checkPasswordStrength = function () {
    const pw = document.getElementById('pw-new').value;
    let score = 0;
    if (pw.length >= 8)  score++;
    if (pw.length >= 12) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;

    const colors  = ['#ef4444', '#f97316', '#eab308', '#22c55e'];
    const labels  = ['Très faible', 'Faible', 'Moyen', 'Fort'];
    for (let i = 1; i <= 4; i++) {
      const bar = document.getElementById(`pw-str-${i}`);
      bar.style.background = i <= score ? colors[score - 1] : '#e5e7eb';
      bar.style.width = i <= score ? '100%' : '0%';
    }
    const label = document.getElementById('pw-str-label');
    label.textContent = pw.length ? labels[score - 1] || '' : '';
    label.style.color = pw.length ? colors[score - 1] : '#9ca3af';
  };

  function resetPasswordStrength() {
    for (let i = 1; i <= 4; i++) {
      const bar = document.getElementById(`pw-str-${i}`);
      bar.style.background = '#e5e7eb';
      bar.style.width = '0%';
    }
    document.getElementById('pw-str-label').textContent = '';
  }

  // ── toggle password visibility ────────────────────────
  window.togglePw = function (id) {
    const input = document.getElementById(id);
    input.type = input.type === 'password' ? 'text' : 'password';
  };

  // ── token display ─────────────────────────────────────
  function initTokenDisplay() {
    const token = getToken();
    const el = document.getElementById('token-display');
    if (el) el.textContent = token ? `${token.slice(0, 10)}••••••••••••••••••••••••${token.slice(-6)}` : 'Aucun token';
  }

  window.copyToken = function () {
    const token = getToken();
    if (!token) return;
    navigator.clipboard.writeText(token).then(() => {
      Utils.showToast('Token copié dans le presse-papiers', 'success');
    }).catch(() => {
      Utils.showToast('Impossible de copier', 'error');
    });
  };

  // ── about server ──────────────────────────────────────
  function initAboutServer() {
    const el = document.getElementById('about-server');
    if (el) el.textContent = SERVER_URL;
  }

  // ── language preferences ───────────────────────────────
  function initLangButtons() {
    const currentLang = localStorage.getItem('lang') || 'fr';
    highlightLang(currentLang);
  }

  function highlightLang(lang) {
    document.querySelectorAll('.lang-pref-btn').forEach(b => b.classList.remove('selected'));
    const btn = document.getElementById(`lang-${lang}`);
    if (btn) btn.classList.add('selected');
  }

  window.setLangAndSave = function (lang) {
    if (typeof setLang === 'function') setLang(lang);
    highlightLang(lang);
    Utils.showToast('Langue mise à jour', 'success');
  };

  // ── logout ─────────────────────────────────────────────
  window.doLogout = function () {
    if (typeof sbLogout === 'function') sbLogout();
    else {
      if (typeof Auth !== 'undefined') Auth.clearAuthToken();
      localStorage.removeItem('authUser');
      location.replace('login.html');
    }
  };

  // ── delete account ─────────────────────────────────────
  window.openDeleteAccountModal = function () {
    document.getElementById('delete-account-confirm-input').value = '';
    const modal = document.getElementById('delete-account-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  };

  window.closeDeleteAccountModal = function () {
    const modal = document.getElementById('delete-account-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  };

  window.confirmDeleteAccount = async function () {
    const inputVal = document.getElementById('delete-account-confirm-input').value.trim();
    const username = getUser().username || '';
    if (inputVal !== username) {
      Utils.showToast('Nom d\'utilisateur incorrect', 'error');
      return;
    }

    const btn = document.getElementById('delete-account-btn');
    btn.disabled = true;
    btn.textContent = 'Suppression…';

    try {
      const token = getToken();
      const res = await fetch('/api/users/delete/', {
        method: 'DELETE',
        headers: { 'Authorization': `Token ${token}`, 'Content-Type': 'application/json' }
      });
      if (res.ok || res.status === 204) {
        if (typeof Auth !== 'undefined') Auth.clearAuthToken();
        localStorage.removeItem('authUser');
        Utils.showToast('Compte supprimé avec succès', 'success');
        setTimeout(() => location.replace('index.html'), 1500);
      } else {
        const data = await res.json().catch(() => ({}));
        Utils.showToast(data.detail || 'Erreur lors de la suppression', 'error');
        btn.disabled = false;
        btn.textContent = 'Supprimer définitivement';
      }
    } catch (_) {
      Utils.showToast('Erreur réseau', 'error');
      btn.disabled = false;
      btn.textContent = 'Supprimer définitivement';
    }
  };

  // Close modal on backdrop click
  document.getElementById('delete-account-modal').addEventListener('click', function (e) {
    if (e.target === this) closeDeleteAccountModal();
  });

})();
