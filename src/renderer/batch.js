'use strict';

/* global api, state, $app, esc, fmtInt, fmtBytes, fmtDuration, plural, toast, sleep, cleanError,
   groupLocks, tagHtml, bindHold, render, holdFaces, isBusy, applyWidths, markLockScan */

// Batch mode: find every node_modules (and Rust target) folder under a parent
// folder, show what each costs and what is holding it, and wipe the chosen ones.

const DAY = 24 * 60 * 60 * 1000;
const OLD_AFTER_DAYS = 30;

function fmtAgo(ms) {
  if (!ms) return 'unknown';
  const days = Math.floor((Date.now() - ms) / DAY);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  const months = Math.floor(days / 30.4);
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

const isOld = (item) => !item.lastTouched || Date.now() - item.lastTouched > OLD_AFTER_DAYS * DAY;

// ---------- starting ----------

async function startBatch(root) {
  if (isBusy()) {
    toast('Wait for the wipe to finish, or stop it first.', true);
    return;
  }
  if (!root) {
    root = await api.pickFolder('batch');
    if (!root) return;
  }
  let r;
  try {
    r = await api.findArtifacts(root);
  } catch (err) {
    toast(cleanError(err), true);
    return;
  }
  state.folder = null;
  state.batch = {
    root: r.root,
    rootName: r.root.split(/[\\/]/).filter(Boolean).pop() || r.root,
    jobId: r.id,
    finding: true,
    visited: 0,
    items: [],
    locks: null,
    locksLoading: false,
    wipeJob: null,
    progress: null,
    results: null,
    startedAt: 0,
    busy: null,
  };
  state.view = 'batch';
  render();
}

// ---------- worker events ----------

let batchRenderQueued = false;
function renderBatchSoon() {
  if (batchRenderQueued) return;
  batchRenderQueued = true;
  requestAnimationFrame(() => {
    batchRenderQueued = false;
    if (state.view.startsWith('batch')) renderBatch();
  });
}

let dockQueued = false;
function renderBatchDockSoon() {
  if (dockQueued) return;
  dockQueued = true;
  requestAnimationFrame(() => {
    dockQueued = false;
    if (state.view === 'batch-wiping') renderBatchDock([], 0, []);
  });
}

function onBatchJob(m) {
  const b = state.batch;
  if (!b) return;

  if (m.kind === 'find' && m.id === b.jobId) {
    if (m.type === 'found') {
      const item = { ...m.item, bytes: null, files: null, status: 'ready' };
      item.selected = isOld(item);
      b.items.push(item);
    } else if (m.type === 'progress') {
      b.visited = m.visited;
    } else if (m.type === 'measured') {
      const item = b.items.find((x) => x.path === m.path);
      if (item) { item.bytes = m.bytes; item.files = m.files; }
    } else if (m.type === 'done') {
      b.finding = false;
      refreshBatchLocks();
    } else if (m.type === 'error') {
      b.finding = false;
      toast(m.message, true);
    }
    renderBatchSoon();
    return;
  }

  if (m.kind === 'wipe-many' && m.id === b.wipeJob) {
    if (m.type === 'progress') {
      b.progress = m;
      if (m.phase === 'folder-done') {
        const item = b.items.find((x) => x.path === m.path);
        if (item) item.status = m.ok ? 'gone' : 'failed';
        renderBatchSoon();
      } else {
        const item = b.items.find((x) => x.path === m.path);
        if (item && item.status === 'queued') {
          item.status = 'wiping';
          renderBatchSoon();
        } else {
          // Most progress events only move the bar: don't rebuild the whole list.
          renderBatchDockSoon();
        }
      }
      return;
    }
    if (m.type === 'error') {
      toast(m.message, true);
      b.wipeJob = null;
      state.view = 'batch';
      startBatch(b.root);
      return;
    }
    if (m.type === 'done') {
      b.wipeJob = null;
      b.results = m.result.results;
      for (const r of b.results) {
        const item = b.items.find((x) => x.path === r.path);
        if (item) {
          item.status = r.ok ? 'gone' : 'failed';
          item.failure = r.ok ? null : r.failures[0] || { code: 'ERROR', message: 'Some files could not be deleted.' };
        }
      }
      b.elapsedMs = Date.now() - b.startedAt;
      state.view = 'batch-done';
      render();
    }
  }
}

// ---------- locks ----------

let batchLockSeq = 0;

async function refreshBatchLocks() {
  const b = state.batch;
  if (!b || !b.items.length) return;
  const seq = ++batchLockSeq;
  const paths = b.items.filter((x) => x.status === 'ready').map((x) => x.path);
  if (!paths.length) return;
  b.locksLoading = true;
  renderBatchSoon();
  let r;
  try {
    r = await api.findLocks(paths);
  } catch (err) {
    r = { ok: false, supported: true, error: cleanError(err), processes: [], targets: paths };
  }
  if (state.batch !== b || seq !== batchLockSeq) return;
  markLockScan();
  if (typeof r.elevated === 'boolean') state.elevated = r.elevated;
  b.locks = r;
  b.locksLoading = false;
  renderBatchSoon();
}

// Lock groups, each with the folder paths it holds.
function batchGroups() {
  const b = state.batch;
  const L = b && b.locks;
  if (!L || !L.ok) return [];
  const targets = L.targets || [];
  return groupLocks(L.processes || []).map((g) => ({
    ...g,
    paths: g.targets.map((i) => targets[i]).filter(Boolean),
  }));
}

function groupsFor(item, groups) {
  return groups.filter((g) => g.paths.includes(item.path));
}

// ---------- actions ----------

function selectedItems() {
  return state.batch.items.filter((x) => x.selected && x.status === 'ready');
}

async function startBatchWipe() {
  const b = state.batch;
  if (!b || isBusy()) return;
  const chosen = selectedItems();
  if (!chosen.length) return;
  const chosenPaths = new Set(chosen.map((x) => x.path));
  const stoppable = batchGroups().filter((g) => !g.unstoppable && g.paths.some((p) => chosenPaths.has(p)));

  if (stoppable.length) {
    b.busy = `Stopping ${plural(stoppable.length, 'program')}`;
    renderBatch();
    for (const g of stoppable) {
      const r = await api.kill(g.root.pid);
      if (!r.ok) toast(r.message || `Couldn't stop ${g.title}.`, true);
    }
    await sleep(600);
    b.busy = null;
  }

  for (const item of chosen) item.status = 'queued';
  b.startedAt = Date.now();
  b.progress = null;
  state.view = 'batch-wiping';
  renderBatch();
  try {
    b.wipeJob = await api.wipeMany(chosen.map((x) => x.path));
  } catch (err) {
    toast(cleanError(err), true);
    for (const item of chosen) item.status = 'ready';
    state.view = 'batch';
    renderBatch();
  }
}

async function batchAction(act, btn) {
  const b = state.batch;
  if (act === 'batch') return startBatch();
  if (act === 'batch-pick') return startBatch();
  if (!b) return;
  if (act === 'batch-again') return startBatch(b.root);
  if (act === 'batch-rescan') return refreshBatchLocks();
  if (act === 'batch-all') b.items.forEach((x) => { x.selected = true; });
  if (act === 'batch-none') b.items.forEach((x) => { x.selected = false; });
  if (act === 'batch-old') b.items.forEach((x) => { x.selected = isOld(x); });
  if (act === 'batch-reveal') return api.reveal(btn.dataset.path);
  if (act === 'batch-cancel') {
    await api.cancel();
    b.wipeJob = null;
    state.view = 'batch';
    toast('Stopped. Folders already wiped are gone.');
    return startBatch(b.root);
  }
  if (act === 'batch-stop') {
    const pid = Number(btn.dataset.pid);
    btn.disabled = true;
    btn.textContent = 'Stopping';
    const r = await api.kill(pid);
    if (!r.ok) toast(r.message || "Couldn't stop that program.", true);
    await sleep(400);
    return refreshBatchLocks();
  }
  renderBatch();
}

$app.addEventListener('change', (e) => {
  const box = e.target.closest('input[data-batch-item]');
  if (!box || !state.batch) return;
  const item = state.batch.items.find((x) => x.path === box.dataset.batchItem);
  if (item) item.selected = box.checked;
  renderBatch();
});

// ---------- rendering ----------

function renderBatch() {
  if (state.view === 'batch-done') return renderBatchDone();
  const b = state.batch;

  // Keep scroll position and focus across re-renders.
  const scroller = $app.querySelector('.scroll');
  const scrollTop = scroller ? scroller.scrollTop : 0;
  const active = document.activeElement;
  const focusKey = active && active.dataset ? (active.dataset.batchItem || active.dataset.act) : null;

  const groups = batchGroups();
  const chosen = b.items.filter((x) => x.selected && x.status === 'ready');
  const chosenBytes = chosen.reduce((n, x) => n + (x.bytes || 0), 0);
  const totalBytes = b.items.reduce((n, x) => n + (x.bytes || 0), 0);
  const measuring = b.items.some((x) => x.bytes == null);
  const wiping = state.view === 'batch-wiping';

  const facts = [
    [fmtInt(b.items.length), b.items.length === 1 ? 'folder found' : 'folders found'],
    [totalBytes ? fmtBytes(totalBytes) : '…', measuring ? 'measured so far' : 'in total'],
    [fmtInt(chosen.length), chosenBytes ? `selected, ${fmtBytes(chosenBytes)}` : 'selected'],
  ];

  let status = '';
  if (b.finding) {
    status = `<div class="status"><h2><span class="spinner"></span>Searching ${esc(plural(b.visited, 'folder'))}</h2></div>`;
  } else if (!b.items.length) {
    status = `<div class="status"><h2 class="clear">No node_modules here</h2></div>
      <p class="status-sub">Nothing to clean under ${esc(b.root)}. Try a folder that holds several projects.</p>`;
  } else if (!wiping) {
    const L = b.locks;
    const rescan = `<button class="text-btn" data-act="batch-rescan">${b.locksLoading ? 'Checking' : 'Rescan'}</button>`;
    if (b.locksLoading && !L) {
      status = `<div class="status"><h2><span class="spinner"></span>Checking what's holding them</h2></div>`;
    } else if (L && L.supported === false) {
      status = '';
    } else if (L && !L.ok) {
      status = `<div class="status"><h2 class="held">Couldn't check for locks</h2>${rescan}</div><p class="status-sub">${esc(L.error)}</p>`;
    } else if (L && !groups.length) {
      status = `<div class="status"><h2 class="clear">Nothing is holding these folders</h2>${rescan}</div>`;
    } else if (L) {
      status = `<div class="status"><h2 class="held">${esc(groups.length === 1 ? '1 program is' : `${groups.length} programs are`)} holding some of them</h2>${rescan}</div>
        <ul class="tags">${groups.map((g) => tagHtml(g, b.root, 'batch-stop')).join('')}</ul>`;
    }
  }

  const rows = b.items.map((item) => batchRowHtml(item, groupsFor(item, groups), wiping)).join('');
  const select = b.items.length && !wiping
    ? `<div class="select-row">
        <span>Select</span>
        <button class="text-btn" data-act="batch-old">untouched for ${OLD_AFTER_DAYS}+ days</button>
        <button class="text-btn" data-act="batch-all">all</button>
        <button class="text-btn" data-act="batch-none">none</button>
      </div>`
    : '';

  $app.innerHTML = `
    <div class="scroll">
      <h1 class="folder-name">${esc(b.rootName)}</h1>
      <div class="folder-path">Dependency folders under ${esc(b.root)}</div>
      <ul class="facts">${facts.map(([v, l]) => `<li><span class="fact-value">${esc(v)}</span><span class="fact-label">${esc(l)}</span></li>`).join('')}</ul>
      <div class="open-row">
        <button class="link-btn" data-act="batch-pick">Choose another folder</button>
        <button class="link-btn" data-act="pick">Wipe one folder instead</button>
      </div>
      ${status}
      ${select}
      <ul class="batch-list">${rows}</ul>
    </div>
    <div class="dock" id="dock"></div>`;

  renderBatchDock(chosen, chosenBytes, groups);

  const newScroller = $app.querySelector('.scroll');
  if (newScroller) newScroller.scrollTop = scrollTop;
  if (focusKey) {
    const el = $app.querySelector(`[data-batch-item="${CSS.escape(focusKey)}"]`) ||
      $app.querySelector(`[data-act="${CSS.escape(focusKey)}"]`);
    if (el) el.focus();
  }
}

function batchRowHtml(item, holders, wiping) {
  const rel = item.path.startsWith(state.batch.root) ? item.path.slice(state.batch.root.length).replace(/^[\\/]/, '') : item.path;
  const size = item.bytes == null ? 'measuring' : fmtBytes(item.bytes);
  const files = item.files == null ? '' : plural(item.files, 'file');
  const touched = `Project changed ${fmtAgo(item.lastTouched)}`;
  let note = '';
  if (item.status === 'gone') note = '<span class="row-note ok">Wiped</span>';
  else if (item.status === 'failed') note = `<span class="row-note bad">Couldn't finish${item.failure ? `: ${esc(item.failure.code)}` : ''}</span>`;
  else if (item.status === 'wiping') note = '<span class="row-note"><span class="spinner"></span>Wiping</span>';
  else if (item.status === 'queued') note = '<span class="row-note">Waiting</span>';
  else if (holders.length) {
    const names = holders.map((g) => g.title).join(', ');
    const stuck = holders.every((g) => g.unstoppable);
    note = `<span class="row-note held">Held by ${esc(names)}. ${stuck ? "Wipeout can't stop this one; see above" : 'Wipeout stops it first'}</span>`;
  } else if (!isOld(item)) {
    note = '<span class="row-note">Changed recently, so not selected by default</span>';
  }
  const disabled = wiping || item.status !== 'ready' ? 'disabled' : '';
  return `
    <li class="batch-row${item.status === 'gone' ? ' gone' : ''}">
      <label class="check">
        <input type="checkbox" data-batch-item="${esc(item.path)}" ${item.selected ? 'checked' : ''} ${disabled}>
        <span class="box" aria-hidden="true"></span>
        <span class="row-main">
          <span class="row-title">${esc(item.projectName)}</span>
          <span class="row-sub">${esc(rel)}</span>
          <span class="row-sub">${esc(touched)}${item.kind === 'rust' ? '. Rust build output' : ''}</span>
          ${note}
        </span>
      </label>
      <span class="row-size"><span class="fact-value">${esc(size)}</span><span class="fact-label">${esc(files)}</span></span>
    </li>`;
}

function renderBatchDock(chosen, chosenBytes, groups) {
  const el = document.getElementById('dock');
  const b = state.batch;
  if (!el) return;

  if (b.busy) {
    el.innerHTML = `<div class="progress"><div class="progress-text"><strong><span class="spinner"></span>${esc(b.busy)}</strong><span>Then the wipe starts</span></div><div class="progress-track"></div></div>`;
    return;
  }

  if (state.view === 'batch-wiping') {
    const p = b.progress || {};
    const count = p.count || chosen.length || 1;
    const index = p.index || 0;
    const within = p.phase === 'delete' && p.total ? p.done / p.total : 0;
    const frac = Math.min(1, (index + within) / count);
    const current = b.items.find((x) => x.path === p.path);
    const line = current ? `Folder ${index + 1} of ${count}: ${current.projectName}` : 'Getting ready';
    let sub = 'Finding files';
    if (p.phase === 'delete' && p.total) {
      sub = `${fmtInt(p.done)} of ${fmtInt(p.total)} files in this folder`;
      const elapsed = Date.now() - b.startedAt;
      if (frac > 0.02) sub += `. About ${fmtDuration((elapsed / frac) * (1 - frac))} left in total`;
    }
    el.innerHTML = `
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(frac * 100)}" aria-label="Wiping folders">
        <div class="progress-text"><strong>${esc(line)}</strong><span>${esc(sub)}</span></div>
        <div class="progress-track"><div class="progress-fill" data-pct="${(frac * 100).toFixed(1)}"></div></div>
      </div>
      <button class="text-btn" data-act="batch-cancel">Stop wiping</button>`;
    applyWidths(el);
    return;
  }

  if (b.finding || !chosen.length) {
    const label = b.finding ? 'Still searching' : 'Select folders to wipe out';
    el.innerHTML = `<button class="hold" disabled aria-label="${esc(label)}">${holdFaces(label, 'Tick the folders you want gone')}</button>`;
    return;
  }

  const chosenPaths = new Set(chosen.map((x) => x.path));
  const stops = groups.filter((g) => !g.unstoppable && g.paths.some((p) => chosenPaths.has(p))).length;
  const what = `${plural(chosen.length, 'folder')}${chosenBytes ? `, ${fmtBytes(chosenBytes)}` : ''}`;
  const label = stops ? `Hold to stop ${plural(stops, 'program')} and wipe out ${what}` : `Hold to wipe out ${what}`;
  const sub = "Permanent. Run npm install in a project to get its dependencies back.";
  el.innerHTML = `<button class="hold" id="hold" aria-label="${esc(label)}. Press and hold.">${holdFaces(label, sub)}</button>`;
  bindHold(document.getElementById('hold'), startBatchWipe);
}

function renderBatchDone() {
  const b = state.batch;
  const results = b.results || [];
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const freed = b.items.filter((x) => x.status === 'gone').reduce((n, x) => n + (x.bytes || 0), 0);
  const headline = `${plural(ok.length, 'folder')}`;
  const bits = [];
  if (freed) bits.push(`${fmtBytes(freed)} freed`);
  bits.push(`from ${plural(new Set(b.items.filter((x) => x.status === 'gone').map((x) => x.project)).size, 'project')}`);
  const failHtml = failed.length
    ? `<p class="bad-text">${esc(plural(failed.length, 'folder'))} couldn't be finished. Go back to the list to see what's holding them.</p>
       <ul class="failures">${failed.slice(0, 6).map((r) => `<li>${esc((r.failures[0] && r.failures[0].code) || 'ERROR')}: ${esc(r.path)}</li>`).join('')}</ul>`
    : '';
  $app.innerHTML = `
    <section class="done">
      <h1><s>${esc(headline)}</s></h1>
      <p>Gone. ${esc(bits.join(' '))} in ${esc(fmtDuration(b.elapsedMs || 0))}.</p>
      ${failHtml}
      <div class="empty-actions">
        <button class="btn" data-act="batch-again">Back to the list</button>
        <button class="btn quiet" data-act="batch-pick">Clean up another folder</button>
      </div>
    </section>`;
  $app.focus();
}
