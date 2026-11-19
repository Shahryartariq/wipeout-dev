'use strict';

const { app, BrowserWindow, ipcMain, dialog, utilityProcess, nativeTheme, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const log = require('./log');
const sys = require('./system');

let win = null;
let pendingFolder = null;
let job = null; // { id, child, kind, target }
let jobSeq = 0;
let quitConfirmed = false;
let elevated = null;
const lastLocks = new Map(); // pid -> { name, startedAt } from the latest scan

const INDEX_HTML = path.join(__dirname, 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).href;

// ---------- privacy ----------

// Chromium's background services (component updates, field trials, Google
// pings) aren't needed by a local tool: Wipeout contacts only GitHub, for updates.
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-features', 'OptimizationHints,MediaRouter,AutofillServerCommunication,CertificateTransparencyComponentUpdater');

// ---------- crash handling ----------

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err);
  try {
    dialog.showErrorBox('Wipeout hit a problem', `${err.message}\n\nDetails were saved to the log file in ${log.logsDir()}.`);
  } catch { /* ignore */ }
});
process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason));

// ---------- startup ----------

function folderFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-'));
  for (const a of args.reverse()) {
    try {
      const p = path.resolve(a);
      if (p === path.resolve(app.getAppPath())) continue;
      const st = fs.lstatSync(p);
      if (st.isDirectory() || st.isSymbolicLink()) return p;
    } catch { /* not a folder */ }
  }
  return null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const folder = folderFromArgv(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (folder) win.webContents.send('open-folder', folder);
    }
  });

  app.whenReady().then(() => {
    log.info(`Wipeout ${app.getVersion()} starting`, process.platform, process.arch, app.isPackaged ? 'packaged' : 'dev');
    nativeTheme.themeSource = 'dark';
    pendingFolder = folderFromArgv(process.argv);
    lockDownSession();
    createWindow();
    checkForUpdates();
  });

  app.on('window-all-closed', () => {
    stopJob();
    app.quit();
  });
}

// ---------- security ----------

function lockDownSession() {
  // The UI needs no camera, mic, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e, url) => {
    if (url !== INDEX_URL) e.preventDefault();
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

// Every IPC call must come from our own page.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const frameUrl = event.senderFrame && event.senderFrame.url;
    if (!win || event.sender !== win.webContents || frameUrl !== INDEX_URL) {
      log.warn('blocked IPC from unexpected sender', channel, frameUrl);
      throw new Error('Not allowed.');
    }
    try {
      return await fn(event, ...args);
    } catch (err) {
      log.warn(`ipc ${channel} failed:`, err.message);
      throw err;
    }
  });
}

// ---------- window ----------

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (Number.isFinite(b.width) && Number.isFinite(b.height)) return b;
  } catch { /* first run */ }
  return { width: 560, height: 760 };
}

function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds())); } catch { /* ignore */ }
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    minWidth: 460,
    minHeight: 560,
    backgroundColor: '#1d2024',
    title: 'Wipeout',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1d2024', symbolColor: '#a1a1aa', height: 44 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.loadFile(INDEX_HTML);

  // Re-check locks when the user comes back (e.g. after closing a terminal).
  win.on('focus', () => send('window-focus'));

  let saveTimer = null;
  const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveBounds, 400); };
  win.on('resize', queueSave);
  win.on('move', queueSave);

  // Don't let a close silently kill a wipe halfway through.
  win.on('close', (e) => {
    saveBounds();
    if (quitConfirmed || !job || (job.kind !== 'wipe' && job.kind !== 'wipe-many')) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep wiping', 'Stop and quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'Wipe in progress',
      message: 'A wipe is still running.',
      detail: 'If you quit now, part of the folder is deleted and the rest stays.',
    });
    if (choice === 1) {
      quitConfirmed = true;
      stopJob();
      win.close();
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('renderer gone', details);
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) win.reload();
  });
  win.on('closed', () => { win = null; });
}

app.on('child-process-gone', (_e, details) => {
  if (details.reason !== 'clean-exit' && details.reason !== 'killed') log.warn('child process gone', details);
});

// ---------- updates ----------

function checkForUpdates() {
  // Portable builds can't update themselves; installed builds can.
  if (!app.isPackaged || process.env.WIPEOUT_NO_UPDATES || process.env.PORTABLE_EXECUTABLE_FILE) return;
  try {
    // Present only in installed builds published through GitHub Releases.
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = { info: (m) => log.info('[update]', m), warn: (m) => log.warn('[update]', m), error: (m) => log.error('[update]', m), debug: () => {} };
    autoUpdater.checkForUpdatesAndNotify().catch((err) => log.warn('update check failed:', err.message));
  } catch (err) {
    log.warn('updater unavailable:', err.message);
  }
}

// ---------- helpers ----------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Accepts real folders and links (junctions/symlinks) to folders, even dangling ones.
function checkFolder(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('Not a valid folder path.');
  const p = path.resolve(target);
  let lst;
  try { lst = fs.lstatSync(p); } catch { throw new Error('That folder no longer exists.'); }
  if (lst.isSymbolicLink()) return p;
  if (!lst.isDirectory()) throw new Error('That is a file, not a folder.');
  return p;
}

function linkInfo(p) {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return null;
    let target = null;
    try { target = fs.readlinkSync(p); } catch { /* unreadable */ }
    return { target };
  } catch {
    return null;
  }
}

function stopJob() {
  if (!job) return;
  try { job.child.postMessage({ cmd: 'cancel' }); } catch { /* ignore */ }
  const child = job.child;
  setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 200);
  job = null;
}

// payload: { target } for scan/wipe, { root } for find, { targets } for wipe-many.
function startJob(kind, payload) {
  stopJob();
  const target = payload.target || payload.root || null;
  const id = ++jobSeq;
  const child = utilityProcess.fork(path.join(__dirname, 'delete-worker.js'), [], {
    serviceName: `wipeout-${kind}`,
    env: { ...process.env, UV_THREADPOOL_SIZE: '64' },
  });
  job = { id, child, kind, target };
  if (kind === 'wipe' || kind === 'wipe-many') log.info(`${kind} started`, payload.target || payload.targets);
  let finished = false;
  child.on('message', (m) => {
    if (!job || job.id !== id) return;
    if (m.type === 'done' || m.type === 'error') finished = true;
    send('job', { id, kind, target, ...m });
    if (finished) {
      if (m.type === 'error') log.warn(`${kind} failed:`, m.message);
      else if (kind === 'wipe') log.info('wipe finished', target, { ok: m.result.ok, removed: m.result.removed, failures: m.result.failures.length, ms: m.result.ms });
      else if (kind === 'wipe-many') log.info('wipe-many finished', m.result.results.map((r) => ({ path: r.path, ok: r.ok })));
      job = null;
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 50);
    }
  });
  child.on('exit', (code) => {
    if (!finished && job && job.id === id) {
      job = null;
      log.error(`${kind} worker exited unexpectedly`, code);
      send('job', { id, kind, target, type: 'error', message: `The ${kind} worker stopped unexpectedly (code ${code}). Details are in the log.` });
    }
  });
  child.postMessage({ cmd: kind, ...payload });
  return id;
}

async function isElevated() {
  if (elevated !== null) return elevated;
  if (!sys.isWin) return (elevated = false);
  elevated = await sys.isElevated();
  return elevated;
}

// ---------- IPC ----------

handle('app-info', async () => ({
  platform: process.platform,
  isWin: sys.isWin,
  version: app.getVersion(),
  elevated: await isElevated(),
  pendingFolder: (() => { const f = pendingFolder; pendingFolder = null; return f; })(),
}));

handle('pick-folder', async (_e, purpose) => {
  const title = purpose === 'batch' ? 'Choose a folder that holds your projects' : 'Choose a folder to wipe out';
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

handle('inspect', async (_e, target) => {
  const p = checkFolder(target);
  const reason = sys.protectedReason(p);
  const link = linkInfo(p);
  const git = reason || link ? { isRepo: false } : await sys.gitInfo(p).catch(() => ({ isRepo: false }));
  return { path: p, name: path.basename(p) || p, parent: path.dirname(p), protectedReason: reason, git, link };
});

handle('scan', (_e, target) => startJob('scan', { target: checkFolder(target) }));

handle('find-locks', async (_e, targets) => {
  const list = (Array.isArray(targets) ? targets : [targets]).filter((t) => {
    try { checkFolder(t); return true; } catch { return false; }
  }).map((t) => path.resolve(t));
  if (!list.length) throw new Error('None of those folders exist any more.');
  const r = await sys.findLocks(list.length === 1 ? list[0] : list);
  r.targets = list;
  if (r.ok) {
    lastLocks.clear();
    for (const proc of r.processes || []) lastLocks.set(proc.pid, { name: proc.name, startedAt: proc.startedAt });
  } else {
    log.warn('lock scan failed:', r.error);
  }
  if (typeof r.elevated === 'boolean') elevated = r.elevated;
  return r;
});

handle('kill', async (_e, pid) => {
  pid = Number(pid);
  const known = lastLocks.get(pid);
  if (!Number.isInteger(pid) || !known) return { ok: false, message: 'That process is no longer in the list. Rescan and try again.' };
  return sys.killTree(pid, known.name, known.startedAt);
});

handle('wipe', (_e, target) => {
  const p = checkFolder(target);
  const reason = sys.protectedReason(p);
  if (reason) throw new Error(reason);
  return startJob('wipe', { target: p });
});

handle('find-artifacts', (_e, root) => {
  const p = checkFolder(root);
  return { id: startJob('find', { root: p }), root: p };
});

handle('wipe-many', (_e, targets) => {
  if (!Array.isArray(targets) || !targets.length) throw new Error('Nothing selected.');
  const list = [];
  for (const t of targets) {
    if (typeof t !== 'string' || !path.isAbsolute(t)) throw new Error('Not a valid folder path.');
    const p = path.resolve(t);
    const base = path.basename(p).toLowerCase();
    // Batch mode only ever deletes dependency folders.
    if (base !== 'node_modules' && base !== 'target') throw new Error(`Refusing to batch-delete ${p}.`);
    const reason = sys.protectedReason(p);
    if (reason) throw new Error(`${p}: ${reason}`);
    list.push(p);
  }
  return startJob('wipe-many', { targets: list });
});

handle('cancel', () => {
  if (job) log.info(`${job.kind} cancelled by user`);
  stopJob();
  return true;
});

handle('open-vscode', (_e, target) => sys.openInVSCode(checkFolder(target)));
handle('reveal', (_e, target) => sys.revealInExplorer(checkFolder(target)));
handle('open-browser', (_e, url) => {
  if (typeof url !== 'string' || !/^(https?:\/\/localhost:\d{1,5}\/?|file:\/\/\/[^\s]+)$/i.test(url)) {
    throw new Error('Unsupported address.');
  }
  return sys.openInBrowser(url);
});
handle('open-logs', async () => {
  const dir = log.logsDir();
  if (!dir) throw new Error('No log folder yet.');
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return true;
});

handle('context-menu-status', () => sys.contextMenuStatus());
handle('context-menu-set', (_e, enabled) => sys.setContextMenu(!!enabled));
handle('relaunch-admin', async (_e, target) => {
  if (job && (job.kind === 'wipe' || job.kind === 'wipe-many')) throw new Error('Wait for the wipe to finish first.');
  stopJob();
  // Let the elevated copy take the single-instance lock; take it back if UAC is declined.
  app.releaseSingleInstanceLock();
  let folder;
  try { folder = target ? checkFolder(target) : null; } catch { folder = null; }
  const r = await sys.relaunchAsAdmin(folder);
  if (!r.ok) {
    app.requestSingleInstanceLock();
    return r;
  }
  quitConfirmed = true;
  setTimeout(() => app.quit(), 200);
  return r;
});
