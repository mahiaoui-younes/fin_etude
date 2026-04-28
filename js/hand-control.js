/**
 * EpitopX AI — Hand Camera Control
 * Rotate / zoom the 3D protein with your hand using the webcam.
 * Uses MediaPipe Hands (CDN).
 *
 * Gestures:
 *   • Move open hand  → rotate protein (wrist tracks X/Y rotation)
 *   • Pinch (thumb ↔ index) closer / farther → zoom in / out
 */

(function () {
  'use strict';

  /* ── State ────────────────────────────────────────────────── */
  let active        = false;
  let handsInstance = null;
  let cameraUtil    = null;
  let animFrameId   = null;
  let videoEl       = null;

  let prevPalmX    = null;
  let prevPalmY    = null;
  let prevPinchD   = null;

  const ROT_SENS  = 200;   // degrees per full-screen swipe
  const ZOOM_SENS = 8;     // zoom strength

  /* ── Helpers ──────────────────────────────────────────────── */
  function getViewer() { return window._3dmolViewer || null; }

  /* ── UI ───────────────────────────────────────────────────── */
  function buildUI() {
    if (document.getElementById('hc-video')) return;   // already built

    /* Camera thumbnail */
    videoEl = document.createElement('video');
    videoEl.id = 'hc-video';
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = true;
    Object.assign(videoEl.style, {
      position: 'fixed', bottom: '72px', right: '16px',
      width: '168px', height: '126px', borderRadius: '14px',
      objectFit: 'cover', zIndex: '300',
      border: '2px solid #6366f1',
      boxShadow: '0 4px 24px rgba(99,102,241,.45)',
      transform: 'scaleX(-1)',          /* mirror like a selfie */
      display: 'none', background: '#111'
    });
    document.body.appendChild(videoEl);

    /* Landmark canvas (sits on top of video) */
    const cvs = document.createElement('canvas');
    cvs.id = 'hc-canvas';
    cvs.width  = 168;
    cvs.height = 126;
    Object.assign(cvs.style, {
      position: 'fixed', bottom: '72px', right: '16px',
      width: '168px', height: '126px', borderRadius: '14px',
      zIndex: '301', display: 'none', pointerEvents: 'none'
    });
    document.body.appendChild(cvs);

    /* Status badge */
    const badge = document.createElement('div');
    badge.id = 'hc-badge';
    badge.textContent = '✋ Hand Control actif';
    Object.assign(badge.style, {
      position: 'fixed', bottom: '204px', right: '16px',
      background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
      color: '#fff', fontSize: '11px', fontWeight: '600',
      padding: '4px 12px', borderRadius: '20px',
      zIndex: '302', display: 'none',
      boxShadow: '0 2px 12px rgba(99,102,241,.5)',
      fontFamily: 'Inter, system-ui, sans-serif'
    });
    document.body.appendChild(badge);

    /* Instructions tooltip */
    const tip = document.createElement('div');
    tip.id = 'hc-tip';
    tip.innerHTML =
      '<b>Gestes :</b><br>' +
      '✋ Déplace la main → rotation<br>' +
      '🤏 Pince → zoom in/out';
    Object.assign(tip.style, {
      position: 'fixed', bottom: '204px', right: '196px',
      background: 'rgba(17,17,17,.88)', backdropFilter: 'blur(6px)',
      color: '#e5e7eb', fontSize: '11px', lineHeight: '1.6',
      padding: '8px 12px', borderRadius: '10px',
      zIndex: '302', display: 'none', maxWidth: '190px',
      boxShadow: '0 4px 16px rgba(0,0,0,.4)',
      fontFamily: 'Inter, system-ui, sans-serif'
    });
    document.body.appendChild(tip);
  }

  function showUI() {
    ['hc-video','hc-canvas','hc-badge','hc-tip'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = (id === 'hc-canvas') ? 'block' : 'block';
    });
  }
  function hideUI() {
    ['hc-video','hc-canvas','hc-badge','hc-tip'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }

  /* ── Draw landmarks on mini canvas ───────────────────────── */
  function drawLandmarks(landmarks, canvasEl) {
    const ctx = canvasEl.getContext('2d');
    const W = canvasEl.width, H = canvasEl.height;
    ctx.clearRect(0, 0, W, H);

    const connections = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [0,9],[9,10],[10,11],[11,12],
      [0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],
      [5,9],[9,13],[13,17]
    ];
    ctx.strokeStyle = 'rgba(99,102,241,.7)';
    ctx.lineWidth = 1.5;
    connections.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo((1 - landmarks[a].x) * W, landmarks[a].y * H);
      ctx.lineTo((1 - landmarks[b].x) * W, landmarks[b].y * H);
      ctx.stroke();
    });

    landmarks.forEach((lm, i) => {
      ctx.beginPath();
      ctx.arc((1 - lm.x) * W, lm.y * H, i === 0 ? 5 : 3, 0, 2 * Math.PI);
      ctx.fillStyle = i === 0 ? '#6366f1' : i === 8 ? '#10b981' : i === 4 ? '#f59e0b' : '#a5b4fc';
      ctx.fill();
    });
  }

  /* ── MediaPipe result handler ─────────────────────────────── */
  function onResults(results) {
    const viewer = getViewer();
    const canvasEl = document.getElementById('hc-canvas');
    if (!canvasEl) return;

    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      const ctx = canvasEl.getContext('2d');
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      prevPalmX = null; prevPalmY = null; prevPinchD = null;
      return;
    }

    const lm = results.multiHandLandmarks[0];
    drawLandmarks(lm, canvasEl);

    if (!viewer) return;

    /* Wrist (0) drives rotation */
    const palmX = lm[0].x;
    const palmY = lm[0].y;

    if (prevPalmX !== null) {
      const dx = palmX - prevPalmX;
      const dy = palmY - prevPalmY;
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
        viewer.rotate(dx * ROT_SENS, { x: 0, y: 1, z: 0 });
        viewer.rotate(dy * ROT_SENS, { x: 1, y: 0, z: 0 });
        viewer.render();
      }
    }
    prevPalmX = palmX;
    prevPalmY = palmY;

    /* Pinch (thumb 4 ↔ index 8) drives zoom */
    const thumbTip = lm[4], indexTip = lm[8];
    const pinchD = Math.hypot(
      thumbTip.x - indexTip.x,
      thumbTip.y - indexTip.y
    );
    if (prevPinchD !== null) {
      const delta = pinchD - prevPinchD;
      if (Math.abs(delta) > 0.008) {
        viewer.zoom(1 + delta * ZOOM_SENS);
        viewer.render();
      }
    }
    prevPinchD = pinchD;
  }

  /* ── Start ────────────────────────────────────────────────── */
  async function start() {
    if (active) return;

    if (typeof Hands === 'undefined') {
      if (window.Utils) Utils.showToast('Chargement de MediaPipe…', 'info', 2000);
      await loadMediaPipe();
    }

    active = true;
    showUI();

    videoEl = document.getElementById('hc-video');

    /* Request camera */
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' }
      });
      videoEl.srcObject = stream;
      await videoEl.play();
    } catch (err) {
      if (window.Utils) Utils.showToast('Accès caméra refusé ❌', 'error');
      stop(); return;
    }

    /* Init MediaPipe Hands */
    handsInstance = new Hands({
      locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`
    });
    handsInstance.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5
    });
    handsInstance.onResults(onResults);

    /* Frame loop */
    async function loop() {
      if (!active) return;
      if (videoEl.readyState >= 2) {
        try { await handsInstance.send({ image: videoEl }); } catch (_) {}
      }
      animFrameId = requestAnimationFrame(loop);
    }
    loop();

    /* Update button */
    const btn = document.getElementById('hand-control-btn');
    if (btn) {
      btn.classList.add('ring-2', 'ring-indigo-400', 'bg-indigo-50');
      btn.title = 'Désactiver contrôle main';
    }
    if (window.Utils) Utils.showToast('Contrôle par la main activé ✋', 'success', 3000);
  }

  /* ── Stop ─────────────────────────────────────────────────── */
  function stop() {
    active = false;
    hideUI();

    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }

    if (videoEl && videoEl.srcObject) {
      videoEl.srcObject.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }

    if (handsInstance) { handsInstance.close(); handsInstance = null; }

    prevPalmX = null; prevPalmY = null; prevPinchD = null;

    const btn = document.getElementById('hand-control-btn');
    if (btn) {
      btn.classList.remove('ring-2', 'ring-indigo-400', 'bg-indigo-50');
      btn.title = 'Contrôle par la main';
    }
    if (window.Utils) Utils.showToast('Contrôle main désactivé', 'info', 2000);
  }

  /* ── Lazy-load MediaPipe from CDN ─────────────────────────── */
  function loadMediaPipe() {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/hands.js';
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  /* ── Public API ───────────────────────────────────────────── */
  window.toggleHandControl = function () { active ? stop() : start(); };

  /* Build DOM nodes as soon as possible */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }

})();
