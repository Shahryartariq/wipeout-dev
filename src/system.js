'use strict';

// Everything that talks to Windows: lock scanning, killing, git, "open with",
// the Explorer right-click entry and restarting as administrator.

const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, shell } = require('electron');
const log = require('./log');

const isWin = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60000, ...opts },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// Native helper and scripts ship outside app.asar (as extraResources) so
// Windows can run them. In development they sit in the project folder
// (one level up from src/, whatever script Electron was started with).
function resourcePath(...parts) {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  return path.join(base, ...parts);
}

function helperPath() {
  return app.isPackaged ? resourcePath('wipeout-locks.exe') : resourcePath('resources', 'wipeout-locks.exe');
}

// Run a program, write `input` to its stdin, collect stdout.
function runWithInput(cmd, args, input, timeout) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      resolve({ err, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ err, stdout, stderr });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(new Error('Lock scan timed out.')); }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(err));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
  });
}

function parseScan(r) {
  const text = r.stdout.trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

// ---------- safety ----------

function norm(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

function isSameOrInside(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep);
}

// Returns a human reason if this folder must never be wiped, otherwise null.
function protectedReason(target) {
  const t = path.resolve(target);
  if (norm(t) === norm(path.parse(t).root)) return 'That is a whole drive.';
  const env = process.env;
  const home = env.USERPROFILE || env.HOME || '';
  const critical = [
    env.SystemRoot, env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramData,
  ].filter(Boolean);
  for (const c of critical) {
    if (isSameOrInside(t, c)) return 'That is a Windows system or program folder.';
  }
  const keep = [
    home, home && path.dirname(home), env.APPDATA, env.LOCALAPPDATA, env.OneDrive,
    home && path.join(home, 'Desktop'), home && path.join(home, 'Documents'), home && path.join(home, 'Downloads'),
    home && path.join(home, 'Pictures'), home && path.join(home, 'Videos'), home && path.join(home, 'Music'),
  ].filter(Boolean);
  for (const k of keep) {
    // The folder itself, or anything that contains it.
    if (isSameOrInside(k, t)) return 'That folder holds your personal or system folders.';
  }
  if (isSameOrInside(app.getAppPath(), t) || isSameOrInside(process.execPath, t)) {
    return 'Wipeout itself lives in that folder.';
  }
  return null;
}

// ---------- locks ----------

// targets: one folder path, or an array of them. Each returned process lists
// in `targets` the indexes of the folders it holds.
async function findLocks(targets) {
  const list = Array.isArray(targets) ? targets : [targets];
  if (!isWin) {
    return { ok: true, supported: false, elevated: false, processes: [], scanMs: 0 };
  }
  // 1. The compiled helper: fast, no PowerShell. Folders go in over stdin.
  let data = null;
  let helperError = null;
  const exe = helperPath();
  if (fs.existsSync(exe) && process.env.WIPEOUT_SCANNER !== 'powershell') {
    const r = await runWithInput(exe, ['--stdin'], list.join('\n'), 120000);
    data = parseScan(r);
    if (!data) helperError = (r.err && r.err.message) || r.stderr.trim() || 'no output';
    else if (!data.ok) { helperError = data.error; data = null; }
  } else {
    helperError = 'helper not found';
  }

  // 2. Fallback: the same scanner compiled at runtime by PowerShell.
  if (!data) {
    log.warn('lock helper failed, falling back to PowerShell:', helperError);
    const script = resourcePath('scripts', 'find-locks.ps1');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
    let listFile = null;
    if (list.length === 1) {
      args.push('-Target', list[0]);
    } else {
      // Unpredictable name, created exclusively, so nothing can swap the list in.
      listFile = path.join(os.tmpdir(), `wipeout-targets-${crypto.randomBytes(12).toString('hex')}.txt`);
      fs.writeFileSync(listFile, list.join('\r\n'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      args.push('-TargetFile', listFile);
    }
    const r = await run('powershell.exe', args, { timeout: 120000 });
    if (listFile) fs.promises.unlink(listFile).catch(() => {});
    data = parseScan(r);
    if (!data) {
      return { ok: false, supported: true, error: (r.stderr || (r.err && r.err.message) || 'No output from lock scanner').trim(), processes: [] };
    }
    data.scanner = 'powershell';
  }

  data.supported = true;
  const own = ownPids();
  data.processes = (data.processes || []).filter((p) => !own.has(p.pid)).map((p) => ({
    ...p,
    samples: p.samples || [],
    moduleSamples: p.moduleSamples || [],
    targets: p.targets || [0],
    moduleCount: p.moduleCount || 0,
    ports: p.ports || [],
  }));
  return data;
}

function ownPids() {
  const s = new Set([process.pid]);
  try { for (const m of app.getAppMetrics()) s.add(m.pid); } catch { /* ignore */ }
  return s;
}

const NEVER_KILL = new Set([
  'system', 'idle', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'smss.exe',
  'svchost.exe', 'dwm.exe', 'explorer.exe', 'msmpeng.exe', 'nissrv.exe', 'searchindexer.exe', 'fontdrvhost.exe',
]);

// Is this PID still the program the user saw? PIDs get reused after a
// process exits, and stopping a stranger would be bad.
async function stillSameProcess(pid, name, startedAt) {
  const exe = helperPath();
  if (fs.existsSync(exe)) {
    const r = await run(exe, ['--describe', String(pid)], { timeout: 15000 });
    const d = parseScan(r);
    if (d && d.ok) {
      if (!d.exists) return { same: false, gone: true };
      const nameOk = !name || !d.name || d.name.toLowerCase() === String(name).toLowerCase();
      const timeOk = !startedAt || !d.startedAt || Math.abs(Date.parse(d.startedAt) - Date.parse(startedAt)) < 2000;
      return { same: nameOk && timeOk, gone: false };
    }
  }
  // Fallback: compare the name only.
  const r = await run('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  const m = /^"([^"]+)","(\d+)"/m.exec(r.stdout);
  if (!m) return { same: false, gone: true };
  return { same: !name || m[1].toLowerCase() === String(name).toLowerCase(), gone: false };
}

async function killTree(pid, name, startedAt) {
  if (!isWin) return { ok: false, message: 'Only supported on Windows.' };
  if (name && NEVER_KILL.has(String(name).toLowerCase())) {
    return { ok: false, message: `${name} is part of Windows and can't be stopped safely.` };
  }
  if (ownPids().has(pid)) return { ok: false, message: 'That is Wipeout itself.' };
  const check = await stillSameProcess(pid, name, startedAt);
  if (check.gone) return { ok: true, message: 'It had already stopped.' };
  if (!check.same) {
    log.warn('refusing to kill reused pid', pid, name);
    return { ok: false, message: `Process ${pid} is now a different program, so Wipeout left it alone. Rescan and try again.` };
  }
  const r = await run('taskkill.exe', ['/F', '/T', '/PID', String(pid)]);
  const out = (r.stdout + r.stderr).trim();
  const ok = !r.err || /not found/i.test(out);
  log.info('taskkill', pid, name, ok ? 'ok' : 'failed', out);
  if (!ok && /access is denied/i.test(out)) {
    return { ok, message: `Windows wouldn't let Wipeout stop ${name || 'that program'}. Restart Wipeout as administrator and try again.` };
  }
  return { ok, message: out };
}

// ---------- git ----------

async function gitInfo(target) {
  if (!fs.existsSync(path.join(target, '.git'))) return { isRepo: false };
  const g = (...args) => run('git', ['--no-optional-locks', '-C', target, ...args], { timeout: 15000 });
  const status = await g('status', '--porcelain');
  if (status.err) return { isRepo: true, available: false };
  const changes = status.stdout.split('\n').filter((l) => l.trim()).length;
  const last = await g('log', '-1', '--format=%cr');
  const remote = await g('remote', 'get-url', 'origin');
  const ahead = await g('rev-list', '--count', '@{u}..HEAD');
  return {
    isRepo: true,
    available: true,
    changes,
    lastCommit: last.err ? null : last.stdout.trim() || null,
    remote: remote.err ? null : remote.stdout.trim() || null,
    unpushed: ahead.err ? null : parseInt(ahead.stdout.trim(), 10) || 0,
  };
}

// ---------- open with ----------

function firstExisting(list) {
  return list.filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

function detached(exe, args) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

async function openInVSCode(target) {
  const env = process.env;
  const exe = firstExisting([
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
  ]);
  if (exe) {
    detached(exe, [target]);
    return { ok: true };
  }
  // VS Code registers vscode:// when installed anywhere else.
  await shell.openExternal('vscode://file/' + target.replace(/\\/g, '/'));
  return { ok: true };
}

async function openInBrowser(url) {
  const env = process.env;
  const chrome = isWin && firstExisting([
    env.ProgramFiles && path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]);
  if (chrome) {
    detached(chrome, [url]);
    return { ok: true, browser: 'Chrome' };
  }
  await shell.openExternal(url);
  return { ok: true, browser: 'default' };
}

function revealInExplorer(target) {
  // Select the folder in its parent instead of opening it,
  // so Explorer doesn't start holding it.
  shell.showItemInFolder(target);
  return { ok: true };
}

// ---------- Explorer right-click entry ----------

const MENU_KEY = 'HKCU\\Software\\Classes\\Directory\\shell\\Wipeout';
const PREFS_KEY = 'HKCU\\Software\\Wipeout';

// The portable build runs from a temporary copy; point the menu at the real .exe.
function appExe() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function launchCommand() {
  if (app.isPackaged) return `"${appExe()}" "%1"`;
  return `"${process.execPath}" "${app.getAppPath()}" "%1"`;
}

async function contextMenuStatus() {
  if (!isWin) return { supported: false, enabled: false };
  const r = await run('reg.exe', ['query', MENU_KEY + '\\command', '/ve']);
  if (r.err) return { supported: true, enabled: false };
  const current = r.stdout.toLowerCase().includes(appExe().toLowerCase());
  return { supported: true, enabled: true, current };
}

async function setContextMenu(enabled) {
  if (!isWin) return { supported: false, enabled: false };
  if (enabled) {
    await run('reg.exe', ['add', MENU_KEY, '/ve', '/d', 'Wipe out', '/f']);
    await run('reg.exe', ['add', MENU_KEY, '/v', 'Icon', '/d', `"${appExe()}",0`, '/f']);
    const r = await run('reg.exe', ['add', MENU_KEY + '\\command', '/ve', '/d', launchCommand(), '/f']);
    if (r.err) return { supported: true, enabled: false, error: r.stderr.trim() || r.err.message };
    await run('reg.exe', ['delete', PREFS_KEY, '/v', 'ContextMenuDisabled', '/f']);
  } else {
    await run('reg.exe', ['delete', MENU_KEY, '/f']);
    // Remembered so the installer doesn't add it back on the next update.
    await run('reg.exe', ['add', PREFS_KEY, '/v', 'ContextMenuDisabled', '/d', '1', '/f']);
  }
  log.info('right-click menu', enabled ? 'on' : 'off');
  return contextMenuStatus();
}

// ---------- run as administrator ----------

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

async function relaunchAsAdmin(target) {
  if (!isWin) return { ok: false };
  const args = [];
  if (!app.isPackaged) args.push(app.getAppPath());
  const exe = app.isPackaged ? appExe() : process.execPath;
  if (target) args.push(target);
  // Each argument is wrapped in double quotes so paths with spaces survive.
  const argList = args.map((a) => psQuote('"' + a + '"')).join(',');
  const command = `Start-Process -FilePath ${psQuote(exe)}` +
    (argList ? ` -ArgumentList ${argList}` : '') + ' -Verb RunAs';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  if (r.err) {
    log.info('admin relaunch declined or failed:', r.stderr.trim() || r.err.message);
    return { ok: false, message: 'Administrator access was not granted, so Wipeout kept running as before.' };
  }
  log.info('relaunched as administrator');
  return { ok: true };
}

// `net session` only succeeds in an elevated process.
async function isElevated() {
  if (!isWin) return false;
  const r = await run('net.exe', ['session'], { timeout: 10000 });
  return !r.err;
}

module.exports = {
  isWin,
  protectedReason,
  findLocks,
  killTree,
  gitInfo,
  openInVSCode,
  openInBrowser,
  revealInExplorer,
  contextMenuStatus,
  setContextMenu,
  relaunchAsAdmin,
  isElevated,
};
