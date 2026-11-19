'use strict';

// The hold-to-wipe demo: press and hold the bar; when it fills, the file count
// runs down to zero and the folder name is struck through. Touches nothing real.
(function () {
  const btn = document.getElementById('demo-hold');
  if (!btn) return;
  const files = document.getElementById('demo-files');
  const name = document.getElementById('demo-name');
  const status = document.getElementById('demo-status');
  const TOTAL = 38210;
  const HOLD_MS = 1100;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let start = 0;
  let raf = 0;
  let done = false;

  const set = (p) => btn.style.setProperty('--p', p.toFixed(4));
  const fmt = (n) => n.toLocaleString('en-US');

  function wipe() {
    done = true;
    btn.disabled = true;
    status.textContent = 'Wiping…';
    const t0 = performance.now();
    const ms = reduced ? 0 : 1400;
    const step = (now) => {
      const k = ms ? Math.min(1, (now - t0) / ms) : 1;
      files.textContent = fmt(Math.round(TOTAL * (1 - k)));
      if (k < 1) { requestAnimationFrame(step); return; }
      name.classList.add('gone');
      status.textContent = 'Gone. 38,210 files, 412 MB freed. (Demo: nothing on your computer was touched.)';
      setTimeout(reset, 4000);
    };
    requestAnimationFrame(step);
  }

  function reset() {
    done = false;
    btn.disabled = false;
    set(0);
    files.textContent = fmt(TOTAL);
    name.classList.remove('gone');
    status.textContent = 'This is a demo. Nothing on your computer is touched.';
  }

  function tick() {
    const p = Math.min(1, (performance.now() - start) / HOLD_MS);
    set(p);
    if (p >= 1) { start = 0; wipe(); return; }
    raf = requestAnimationFrame(tick);
  }

  function begin(e) {
    if (done || start) return;
    if (e.pointerId !== undefined) btn.setPointerCapture(e.pointerId);
    start = performance.now();
    status.textContent = 'Keep holding…';
    raf = requestAnimationFrame(tick);
  }

  function end() {
    if (!start) return;
    start = 0;
    cancelAnimationFrame(raf);
    set(0);
    if (!done) status.textContent = 'Let go too early. Hold until the bar fills.';
  }

  btn.addEventListener('pointerdown', begin);
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('lostpointercapture', end);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); begin(e); }
  });
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') end(); });
  btn.addEventListener('blur', end);
})();
