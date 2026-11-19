'use strict';

/* global groupLocks, onBatchJob, renderBatch, batchAction, refreshBatchLocks */

const api = window.wipeout;
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const $veil = document.getElementById('drop-veil');

const HOLD_MS = 1100;

const state = {
  isWin: true,
  view: 'empty', // empty | folder | wiping | done
  folder: null, // inspect() result
  stats: null, // scan result
  counting: null, // live scan progress
  locks: null, // findLocks result
  locksLoading: false,
  stopping: new Set(), // root pids being stopped
  wipeProgress: null,
  wipeJob: null,
  lastFailure: null, // { failures, total, removed }
  doneInfo: null,
  busyMessage: null,
};

// ---------- small helpers ----------

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lc = (s) => String(s || '').toLowerCase();
const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : (many || one + 's')}`;

function fmtBytes(b) {
  if (b == null) return '';
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  if (i === 0) return `${v} ${v === 1 ? 'byte' : 'bytes'}`;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}

let toastTimer = null;
function toast(msg, bad = false) {
  $toast.textContent = msg;
  $toast.classList.toggle('bad', bad);
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, bad ? 6000 : 3500);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Process naming and grouping live in locks-logic.js (shared with the tests).

// ---------- loading a folder ----------

let loadSeq = 0;

async function loadFolder(p, { keepFailure = false } = {}) {
  if (isBusy()) {
    toast('Wait for the wipe to finish, or stop it first.', true);
    return;
  }
  const seq = ++loadSeq;
  // Check the folder first, so a bad drop doesn't throw away what's on screen.
  let info;
  try {
    info = await api.inspect(p);
  } catch (err) {
    if (seq !== loadSeq) return;
    toast(cleanError(err), true);
    return;
  }
  if (seq !== loadSeq) return;
  if (!keepFailure) state.lastFailure = null;
  state.view = 'folder';
  state.batch = null;
  state.stats = null;
  state.counting = null;
  state.locks = null;
  state.locksLoading = false;
  state.busyMessage = null;
  state.folder = info;
  render();
  if (info.protectedReason) return;
  api.scan(info.path).catch(() => {});
  refreshLocks();
}

let lockSeq = 0;
let lastLockScan = 0;
function markLockScan() { lastLockScan = Date.now(); }

async function refreshLocks() {
  if (!state.folder || state.folder.protectedReason) return;
  const target = state.folder.path;
  const seq = ++lockSeq;
  state.locksLoading = true;
  render();
  let r;
  try {
    r = await api.findLocks(target);
  } catch (err) {
    r = { ok: false, supported: true, error: cleanError(err), processes: [] };
  }
  // A newer scan or another folder took over while this one ran.
  if (seq !== lockSeq || !state.folder || state.folder.path !== target) return;
  markLockScan();
  state.locks = r;
  state.locksLoading = false;
  if (typeof r.elevated === 'boolean') state.elevated = r.elevated;
  render();
}

function isBusy() {
  return state.view === 'wiping' || state.view === 'batch-wiping' || !!state.busyMessage || !!(state.batch && state.batch.busy);
}

function cleanError(err) {
  const m = String((err && err.message) || err || 'Something went wrong.');
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------- actions ----------

async function stopGroup(group) {
  state.stopping.add(group.root.pid);
  render();
  const r = await api.kill(group.root.pid);
  state.stopping.delete(group.root.pid);
  if (!r.ok) toast(r.message || `Couldn't stop ${group.title}.`, true);
  await sleep(400);
  await refreshLocks();
}

async function startWipe() {
  const folder = state.folder;
  if (!folder || isBusy()) return;
  const groups = groupLocks((state.locks && state.locks.processes) || []);
  const stoppable = groups.filter((g) => !g.unstoppable);

  if (stoppable.length) {
    state.busyMessage = `Stopping ${plural(stoppable.length, 'program')}`;
    render();
    for (const g of stoppable) {
      const r = await api.kill(g.root.pid);
      if (!r.ok) toast(r.message || `Couldn't stop ${g.title}.`, true);
    }
    await sleep(600);
  }

  state.view = 'wiping';
  state.busyMessage = null;
  state.wipeJob = null;
  state.wipeProgress = { phase: 'scan', found: 0 };
  render();
  try {
    state.wipeJob = await api.wipe(folder.path);
  } catch (err) {
    state.view = 'folder';
    toast(cleanError(err), true);
    render();
  }
}

async function cancelWipe() {
  await api.cancel();
  state.wipeJob = null;
  state.view = 'folder';
  toast('Stopped. Whatever was already deleted is gone.');
  loadFolder(state.folder.path);
}

function onJob(m) {
  if (m.kind === 'find' || m.kind === 'wipe-many') return onBatchJob(m);
  if (!state.folder || m.target !== state.folder.path) return;

  if (m.kind === 'scan') {
    if (m.type === 'progress') state.counting = m;
    if (m.type === 'done') { state.stats = m.result; state.counting = null; }
    if (m.type === 'error') state.counting = null;
    if (state.view === 'folder') renderFacts();
    return;
  }

  if (m.kind === 'wipe' && state.view === 'wiping' && (m.id === state.wipeJob || state.wipeJob == null)) {
    if (state.wipeJob == null) state.wipeJob = m.id;
    if (m.type === 'progress') {
      state.wipeProgress = m;
      renderDock();
      return;
    }
    if (m.type === 'error') {
      toast(m.message, true);
      state.view = 'folder';
      state.wipeJob = null;
      loadFolder(state.folder.path);
      return;
    }
    if (m.type === 'done') {
      const r = m.result;
      state.wipeJob = null;
      if (r.ok) {
        state.doneInfo = {
          name: state.folder.name,
          linkOnly: !!r.linkOnly,
          files: r.total,
          bytes: state.stats ? state.stats.bytes : null,
          ms: r.ms,
        };
        state.view = 'done';
        render();
      } else if (!r.cancelled) {
        state.lastFailure = r;
        state.view = 'folder';
        loadFolder(state.folder.path, { keepFailure: true });
      }
    }
  }
}

// ---------- hold to wipe ----------

let holdStart = 0;
let holdRaf = 0;

function bindHold(btn, onComplete = startWipe) {
  const set = (p) => btn.style.setProperty('--p', p.toFixed(4));
  const tick = () => {
    const p = Math.min(1, (performance.now() - holdStart) / HOLD_MS);
    set(p);
    if (p >= 1) {
      holdStart = 0;
      onComplete();
      return;
    }
    holdRaf = requestAnimationFrame(tick);
  };
  const begin = (e) => {
    if (btn.disabled || holdStart) return;
    if (e.type === 'pointerdown') btn.setPointerCapture(e.pointerId);
    holdStart = performance.now();
    holdRaf = requestAnimationFrame(tick);
  };
  const end = () => {
    if (!holdStart) return;
    holdStart = 0;
    cancelAnimationFrame(holdRaf);
    set(0);
  };
  btn.addEventListener('pointerdown', begin);
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('lostpointercapture', end);
  btn.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); begin(e); }
  });
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') end(); });
  btn.addEventListener('blur', end);
}

// ---------- rendering ----------

let shownFolder = null; // the folder whose layout is currently on screen

function render() {
  if (state.view === 'empty') { shownFolder = null; return renderEmpty(); }
  if (state.view === 'done') { shownFolder = null; return renderDone(); }
  if (state.view.startsWith('batch')) { shownFolder = null; return renderBatch(); }
  if (state.folder && shownFolder === state.folder && document.getElementById('dock')) {
    // Same folder already on screen: update in place so focus and scroll stay put.
    renderFacts();
    renderDiagnosis();
    renderDock();
    return;
  }
  renderFolder();
  shownFolder = state.folder;
}

function renderEmpty() {
  $app.innerHTML = `
    <section class="empty">
      <h1>Drop a folder that won't delete.</h1>
      <p>Wipeout shows what's holding it, stops it, and deletes it, even node_modules.</p>
      <div class="empty-actions">
        <button class="btn" data-act="pick">Choose a folder</button>
        <button class="btn quiet" data-act="batch">Clean up old node_modules</button>
      </div>
    </section>`;
}

function renderDone() {
  const d = state.doneInfo;
  if (d.linkOnly) {
    $app.innerHTML = `
      <section class="done">
        <h1><s>${esc(d.name)}</s></h1>
        <p>Removed the link. The folder it pointed to wasn't touched.</p>
        <button class="btn" data-act="pick">Wipe out another folder</button>
      </section>`;
    $app.focus();
    return;
  }
  const bits = [plural(d.files, 'item')];
  if (d.bytes) bits.push(`${fmtBytes(d.bytes)} freed`);
  $app.innerHTML = `
    <section class="done">
      <h1><s>${esc(d.name)}</s></h1>
      <p>Gone. ${esc(bits.join(', '))} in ${esc(fmtDuration(d.ms))}.</p>
      <button class="btn" data-act="pick">Wipe out another folder</button>
    </section>`;
  $app.focus();
}

function renderFolder() {
  const f = state.folder;
  if (!f) {
    $app.innerHTML = `<div class="scroll"><p class="status-sub"><span class="spinner"></span>Opening folder</p></div>`;
    return;
  }
  $app.innerHTML = `
    <div class="scroll">
      <h1 class="folder-name">${esc(f.name)}</h1>
      <div class="folder-path">${esc(f.parent)}</div>
      <ul class="facts" id="facts"></ul>
      <div class="open-row" id="open-row">
        ${f.link ? '' : '<button class="link-btn" data-act="vscode">Open in VS Code</button><button class="link-btn" data-act="browser" id="browser-btn">Open in Chrome</button>'}
        <button class="link-btn" data-act="reveal">Show in Explorer</button>
        <button class="link-btn" data-act="pick">Choose another</button>
      </div>
      <div id="diagnosis"></div>
    </div>
    <div class="dock" id="dock"></div>`;
  renderFacts();
  renderDiagnosis();
  renderDock();
}

function renderFacts() {
  const el = document.getElementById('facts');
  if (!el || !state.folder) return;
  const s = state.stats;
  const c = state.counting;
  const items = [];
  if (s) {
    items.push([fmtInt(s.files), s.files === 1 ? 'file' : 'files']);
    items.push([fmtBytes(s.bytes), 'on disk']);
  } else if (c) {
    items.push([fmtInt(c.files), 'files so far']);
    if (c.bytes) items.push([fmtBytes(c.bytes), 'so far']);
  } else if (!state.folder.protectedReason) {
    items.push(['…', 'counting files']);
  }
  const g = state.folder.git;
  if (g && g.isRepo && g.available) {
    if (g.changes > 0) items.push([plural(g.changes, 'change'), 'not committed', true]);
    else items.push(['Clean', g.lastCommit ? `git, last commit ${g.lastCommit}` : 'git']);
    if (g.unpushed > 0) items.push([plural(g.unpushed, 'commit'), 'not pushed', true]);
    if (!g.remote) items.push(['No remote', 'this repo exists only here', true]);
  }
  el.innerHTML = items.map(([v, l, warn]) =>
    `<li><span class="fact-value${warn ? ' warn' : ''}">${esc(v)}</span><span class="fact-label">${esc(l)}</span></li>`).join('');

  // The browser button points at the dev server when one is running.
  const btn = document.getElementById('browser-btn');
  if (btn) {
    const port = devPort();
    btn.textContent = port ? `Open localhost:${port}` : 'Open in Chrome';
  }

  // Notes depend on stats too.
  renderNotes();
}

function devPort() {
  const procs = (state.locks && state.locks.processes) || [];
  for (const p of procs) if (p.ports && p.ports.length) return p.ports[0];
  return null;
}

function renderDiagnosis() {
  const el = document.getElementById('diagnosis');
  if (!el) return;
  const f = state.folder;

  if (f.link) {
    el.innerHTML = `<div class="status"><h2 class="clear">This is a link, not a real folder</h2></div>
      <p class="status-sub">It points to ${esc(f.link.target || 'another folder')}. Wiping removes only the link; the folder it points to is not touched.</p>
      <ul class="notes" id="notes"></ul>`;
    return;
  }
  if (f.protectedReason) {
    el.innerHTML = `<div class="refused"><strong>Wipeout won't delete this folder.</strong>${esc(f.protectedReason)}</div><ul class="notes" id="notes"></ul>`;
    return;
  }

  const L = state.locks;
  let html;
  if (!L) {
    html = `<div class="status"><h2><span class="spinner"></span>Checking what's holding it</h2></div>`;
  } else if (!L.supported) {
    html = `<div class="status"><h2>Lock checking needs Windows</h2></div>
      <p class="status-sub">You can still wipe the folder from here.</p>`;
  } else if (!L.ok) {
    html = `<div class="status"><h2 class="held">Couldn't check for locks</h2><button class="text-btn" data-act="rescan">Try again</button></div>
      <p class="status-sub">${esc(L.error)}</p>`;
  } else {
    const groups = groupLocks(L.processes || []);
    const rescan = `<button class="text-btn" data-act="rescan">${state.locksLoading ? 'Checking' : 'Rescan'}</button>`;
    if (!groups.length) {
      html = `<div class="status"><h2 class="clear">Nothing is holding this folder</h2>${rescan}</div>
        <p class="status-sub">Checked in ${esc(fmtDuration(L.scanMs || 0))}. It's ready to wipe.</p>`;
    } else {
      html = `<div class="status"><h2 class="held">${esc(groups.length === 1 ? '1 program is' : `${groups.length} programs are`)} holding this folder</h2>${rescan}</div>
        <ul class="tags">${groups.map((g) => tagHtml(g, f.path)).join('')}</ul>`;
    }
  }
  el.innerHTML = html + `<ul class="notes" id="notes"></ul>`;
  renderNotes();
  const btn = document.getElementById('browser-btn');
  if (btn) { const port = devPort(); btn.textContent = port ? `Open localhost:${port}` : 'Open in Chrome'; }
}

// Paths relative to the folder being looked at, so the list stays readable.
function relPath(p, base) {
  if (base && lc(p).startsWith(lc(base) + '\\')) return p.slice(base.length + 1);
  if (base && lc(p).startsWith(lc(base) + '/')) return p.slice(base.length + 1);
  return p;
}

function heldHtml(g, base) {
  const files = [...new Set(g.members.flatMap((m) => m.samples || []))];
  const mods = [...new Set(g.members.flatMap((m) => m.moduleSamples || []))];
  const total = g.files + g.modules;
  if (!files.length && !mods.length) return '';
  const rows = files.map((f) => `<li>${esc(relPath(f, base))}</li>`)
    .concat(mods.map((f) => `<li>${esc(relPath(f, base))} <span class="held-kind">loaded as a library</span></li>`));
  const more = total > files.length + mods.length ? `<li class="held-more">and ${fmtInt(total - files.length - mods.length)} more</li>` : '';
  return `<details class="held"><summary>What it's holding</summary><ul>${rows.join('')}${more}</ul></details>`;
}

function tagHtml(g, base, stopAct = 'stop') {
  const stopping = state.stopping.has(g.root.pid);
  const pidText = g.pids.length === 1 ? `PID ${g.pids[0]}` : `PID ${g.root.pid} plus ${g.pids.length - 1} more`;
  const detail = [g.detail, pidText].filter(Boolean).join('. ');
  const action = g.unstoppable
    ? ''
    : `<div class="tag-action"><button class="btn quiet" data-act="${stopAct}" data-pid="${g.root.pid}" ${stopping ? 'disabled' : ''}>${stopping ? 'Stopping' : 'Stop'}</button></div>`;
  return `
    <li class="tag${g.unstoppable ? ' stuck' : ''}">
      <div class="tag-title">${esc(g.title)}</div>
      ${action}
      <div class="tag-detail">${esc(detail)}</div>
      ${g.command ? `<div class="tag-cmd" title="${esc(g.command)}">${esc(g.command)}</div>` : ''}
      ${g.unstoppable ? `<div class="hint">${esc(g.unstoppable)}</div>` : ''}
      ${g.warn ? `<div class="hint">${esc(g.warn)}</div>` : ''}
      ${heldHtml(g, base)}
    </li>`;
}

function renderNotes() {
  const el = document.getElementById('notes');
  if (!el || !state.folder) return;
  const notes = [];
  const s = state.stats;
  const L = state.locks;
  const fail = state.lastFailure;

  if (fail) {
    const n = fail.failures.length;
    notes.push(['bad', `The last wipe removed ${fmtInt(fail.removed)} of ${fmtInt(fail.total)} items. ${plural(n, 'item')} couldn't be deleted. What's left is shown above.`]);
  }
  if (s && s.readOnly > 0) notes.push(['', `${plural(s.readOnly, 'file is', 'files are')} read-only. Wipeout clears that as it goes.`]);
  if (s && s.longPaths > 0) notes.push(['', `${plural(s.longPaths, 'path is', 'paths are')} longer than Windows' 260-character limit. Explorer often fails on these; Wipeout doesn't.`]);
  if (s && s.unreadable && s.unreadable.length) {
    notes.push(['warn', `${plural(s.unreadable.length, 'folder')} can't be read with your permissions. Restarting as administrator may help.`]);
  }
  if (L && L.supported && L.ok && !L.elevated) {
    notes.push(['', 'Programs running as administrator can hold files without showing up here. If the wipe fails, restart Wipeout as administrator.']);
  }
  if (state.elevated) {
    notes.push(['', "Running as administrator. Windows blocks drag and drop from Explorer into admin apps, so use Choose another to pick folders."]);
  }
  let html = notes.map(([cls, t]) => `<li class="${cls}">${esc(t)}</li>`).join('');
  if (fail && fail.failures.length) {
    html += `<li><ul class="failures">${fail.failures.slice(0, 6).map((x) =>
      `<li>${esc(x.code)}: ${esc(x.path)}</li>`).join('')}</ul></li>`;
  }
  if (L && L.supported && !L.elevated) {
    html += `<li><button class="text-btn" data-act="admin">Restart as administrator</button></li>`;
  }
  el.innerHTML = html;
}

// Widths are set through the DOM, not inline style attributes, so the page's
// Content-Security-Policy can forbid inline styles.
function applyWidths(root) {
  root.querySelectorAll('[data-pct]').forEach((n) => { n.style.width = `${n.dataset.pct}%`; });
}

function holdFaces(label, sub) {
  const face = `<span class="hold-label">${esc(label)}</span><span class="hold-sub">${esc(sub)}</span>`;
  return `<span class="hold-face" aria-hidden="true">${face}</span><span class="hold-face fill" aria-hidden="true">${face}</span>`;
}

function renderDock() {
  const el = document.getElementById('dock');
  if (!el) return;
  const f = state.folder;
  const row = document.getElementById('open-row');
  if (row) row.querySelectorAll('button').forEach((b) => { b.disabled = isBusy(); });
  document.querySelectorAll('#diagnosis .text-btn, #diagnosis .tag-action .btn').forEach((b) => { b.disabled = isBusy(); });

  if (state.view === 'wiping') {
    const p = state.wipeProgress || {};
    let pct = 0;
    let line = 'Finding files';
    let sub = p.found ? `${fmtInt(p.found)} found so far` : 'Getting ready';
    if (p.phase === 'delete' && p.total) {
      pct = p.done / p.total;
      line = `${fmtInt(p.done)} of ${fmtInt(p.total)} deleted`;
      const rate = p.done / Math.max(1, p.elapsedMs);
      const left = rate > 0 ? (p.total - p.done) / rate : 0;
      sub = pct >= 1 ? 'Finishing up' : `About ${fmtDuration(left)} left`;
      if (p.failed) sub += `. ${plural(p.failed, 'item')} stuck so far`;
    }
    el.innerHTML = `
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}" aria-label="Wiping ${esc(f.name)}">
        <div class="progress-text"><strong>${esc(line)}</strong><span>${esc(sub)}</span></div>
        <div class="progress-track"><div class="progress-fill" data-pct="${(pct * 100).toFixed(1)}"></div></div>
      </div>
      <button class="text-btn" data-act="cancel">Stop wiping</button>`;
    applyWidths(el);
    return;
  }

  if (!f) { el.innerHTML = ''; return; }
  if (f.protectedReason) {
    el.innerHTML = `<button class="hold" disabled aria-label="Can't wipe this folder">${holdFaces("Can't wipe this folder", 'Choose a different one')}</button>`;
    return;
  }
  if (state.busyMessage) {
    el.innerHTML = `<div class="progress"><div class="progress-text"><strong><span class="spinner"></span>${esc(state.busyMessage)}</strong><span>Then the wipe starts</span></div><div class="progress-track"></div></div>`;
    return;
  }

  const groups = groupLocks((state.locks && state.locks.processes) || []);
  const stoppable = groups.filter((g) => !g.unstoppable).length;
  const label = stoppable
    ? `Hold to stop ${plural(stoppable, 'program')} and wipe out`
    : 'Hold to wipe out';
  const sub = `Deletes ${f.name} permanently. It won't go to the Recycle Bin.`;
  el.innerHTML = `<button class="hold" id="hold" aria-label="${esc(label)} ${esc(f.name)}. Press and hold.">${holdFaces(label, sub)}</button>`;
  bindHold(document.getElementById('hold'));
}

// ---------- events ----------

async function pick() {
  if (isBusy()) return;
  const p = await api.pickFolder('single');
  if (p) loadFolder(p);
}

$app.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const f = state.folder;
  if (isBusy() && act !== 'cancel' && act !== 'batch-cancel') {
    toast('Wait for the wipe to finish, or stop it first.', true);
    return;
  }
  try {
    if (act === 'pick') return pick();
    if (act === 'rescan') return refreshLocks();
    if (act === 'cancel') return cancelWipe();
    if (act === 'admin') {
      const r = await api.relaunchAsAdmin(f ? f.path : null);
      if (!r || !r.ok) toast((r && r.message) || "Couldn't restart as administrator.", true);
      return;
    }
    if (act === 'batch' || act.startsWith('batch-')) return batchAction(act, btn);
    if (!f) return;
    if (act === 'vscode') { await api.openVSCode(f.path); toast('Opening in VS Code'); }
    if (act === 'reveal') await api.reveal(f.path);
    if (act === 'browser') {
      const port = devPort();
      const url = port ? `http://localhost:${port}` : 'file:///' + f.path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:') + '/';
      const r = await api.openBrowser(url);
      toast(r.browser === 'Chrome' ? 'Opening in Chrome' : "Chrome isn't installed, so it opened in your default browser");
    }
    if (act === 'stop') {
      const pid = Number(btn.dataset.pid);
      const g = groupLocks(state.locks.processes).find((x) => x.root.pid === pid);
      if (g) await stopGroup(g);
    }
  } catch (err) {
    toast(cleanError(err), true);
  }
});

// Drag and drop a folder anywhere on the window.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (isBusy()) return;
  dragDepth++;
  $veil.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $veil.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $veil.hidden = true;
  if (isBusy()) { toast('Wait for the wipe to finish, or stop it first.', true); return; }
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const p = api.pathForFile(file);
  if (p) loadFolder(p);
});

// Settings popover.
const $settingsBtn = document.getElementById('settings-btn');
const $settings = document.getElementById('settings');
const $ctx = document.getElementById('ctx-toggle');
const $ctxNote = document.getElementById('ctx-note');

function closeSettings() {
  $settings.hidden = true;
  $settingsBtn.setAttribute('aria-expanded', 'false');
  $settingsBtn.focus();
}

document.addEventListener('mousedown', (e) => {
  if (!$settings.hidden && !$settings.contains(e.target) && !$settingsBtn.contains(e.target)) closeSettings();
});

document.getElementById('open-logs').addEventListener('click', async () => {
  try { await api.openLogs(); } catch (err) { toast(cleanError(err), true); }
});

$settingsBtn.addEventListener('click', async () => {
  const open = $settings.hidden;
  if (!open) { closeSettings(); return; }
  $settings.hidden = false;
  $settingsBtn.setAttribute('aria-expanded', 'true');
  if (open) {
    const s = await api.contextMenuStatus();
    $ctx.disabled = !s.supported;
    $ctx.checked = !!s.enabled;
    if (!s.supported) $ctxNote.textContent = 'Only available on Windows.';
    else if (s.enabled && s.current === false) $ctxNote.textContent = 'Turned on from another copy of Wipeout. Turn it off and on to point it here.';
  }
});

$ctx.addEventListener('change', async () => {
  const s = await api.setContextMenu($ctx.checked);
  $ctx.checked = !!s.enabled;
  if (s.error) toast(s.error, true);
  else toast(s.enabled ? 'Added "Wipe out" to the folder right-click menu' : 'Removed from the right-click menu');
});

api.onJob(onJob);
api.onOpenFolder((p) => loadFolder(p));

// Coming back to the window (say, after closing a terminal): refresh the lock list.
api.onWindowFocus(() => {
  if (isBusy() || Date.now() - lastLockScan < 3000) return;
  if (state.view === 'folder' && state.folder && state.locks && !state.locksLoading) refreshLocks();
  else if (state.view === 'batch' && state.batch && state.batch.locks && !state.batch.locksLoading && !state.batch.finding) refreshBatchLocks();
});

// Keyboard: Ctrl+O opens a folder, Escape closes settings.
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o' && !isBusy()) {
    e.preventDefault();
    pick();
  }
  if (e.key === 'Escape' && !$settings.hidden) closeSettings();
});

(async () => {
  const info = await api.appInfo();
  state.isWin = info.isWin;
  state.elevated = info.elevated;
  document.getElementById('app-version').textContent = `Wipeout ${info.version}${info.elevated ? ', running as administrator' : ''}`;
  if (info.pendingFolder) loadFolder(info.pendingFolder);
  else render();
})();
